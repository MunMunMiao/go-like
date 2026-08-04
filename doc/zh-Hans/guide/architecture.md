# 架构

go-like 采用平铺的可发布包，而不是做一个包办一切的大框架。`@go-like/core` 组合应用和 Server 生命周期，`@go-like/context` 传递取消、截止时间、原因和值，其余 SPI 包各管一个能力域。具体后端放在独立 provider 包里，不会变成隐式全局默认值。

整个框架可以按几条主线理解：应用面负责启动、接纳、hook 和终态；Core 会并行调用各个 sibling Server 的 `stop(ctx)`，等待各自的 terminal result，再汇总 lifecycle failure，但不保证按反向声明顺序停止。需要有序清理的组件应在单个 Server 内部组合顺序；调用面负责发现、选择、客户端、服务端投影和传输；事件面负责 broker 与可选的 typed codec；运维面包括配置快照、Store、健康检查、指标、追踪和日志生命周期；对外 Web 则只承接标准 Fetch Handler，跟内部 transport 是两回事。

依赖方向始终朝向可移植接口。Provider 可以依赖官方 SDK 或某个 runtime host，但 SPI 不能反过来知道具体实现。这样同一份业务代码才能在 Bun、Node.js、Deno 或其他兼容 Web API 的后端上复用，而不是被某个框架绑死。

项目不提供 service locator。应用自己构造依赖再显式传进去，多写几行装配代码并不是坏事，它恰好把连接、watcher、listener 和关闭责任都暴露出来了。

> [!NOTE]
> 这页是便于快速阅读的本地化摘要。完整生命周期 DAG、ownership map 和各 provider 的边界见[英文 canonical 页面](/guide/architecture)；这里不承诺不同 runtime 之间存在通用 parity。

## 请求与生命周期地图

```text
application composition root
  -> Context：取消 / deadline / values
  -> Core App：接纳 / hooks / stop 结果
  -> Web Handler -> runtime host -> listener
  -> 内部 Client -> Discovery -> Selector -> Transport -> Server

App.stop()
  -> 撤销已接纳的实例
  -> 取消 Server runtime
  -> 并发调用 Server.stop
  -> 等待终态 -> 一个结果
```

`Server.start(ctx)` 不等于 readiness。要观察 admission，请用 `endpoint(ctx)` 或 `afterStart` hook。Core 也不承诺 sibling Server 按反向顺序停止；如果顺序重要，就把相关资源组合到一个 `Server` 或显式 hook 里。
