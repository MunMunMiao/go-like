# @likego/broker

`@likego/broker` 定义 Context-first 的 bytes/topic publish 与 subscribe SPI，并保留 provider 原生事件对象。公共层不提供 `ack`、`nak`、`term` 等伪抽象；这些 settlement 行为继续由 NATS JetStream 等原生对象负责。

`Subscriber` 采用与 go-micro `Subscriber` 相同的心智模型：公开 `topic` 与
`unsubscribe(ctx)`，不再暴露第二套 `stop()`/`done()` 生命周期。

`Broker` 直接声明 `subscribe(...)`，并返回 `Subscriber` handle。
`newBrokerServer(...)` 可把 `Broker` 或 typed `EventBroker` 的一次订阅接入 Core Server
生命周期；它不建立、关闭或拥有连接。`start(ctx)` 完成订阅准入后保持 pending；`stop(ctx)` 只调用一次
`unsubscribe(background())`，调用方 Context 只限制自己的等待。`start(ctx)` 的 Promise 在 unsubscribe
成功或失败后按相同结果结算。provider 返回的 `topic` 必须与请求值精确一致；接纳阶段已经取得
`unsubscribe` 后若 metadata 畸形，Server 会先回滚该订阅。

provider 可通过 `@likego/broker/provider` 把原生订阅的稳定终态关联到 `Subscriber`。该内部入口不会给
应用侧 `Subscriber` 增加 `done()` 或其他 handle；`newBrokerServer` 会把 provider 的被动终止或 handler
失败送入现有 `Server.start()` 终态。
