# 架构

LikeGo 采用平铺的可发布包，而不是做一个包办一切的大框架。`@likego/core` 组合应用和 Server 生命周期，`@likego/context` 传递取消、截止时间、原因和值，其余 SPI 包各管一个能力域。具体后端放在独立 provider 包里，不会变成隐式全局默认值。

整个框架可以按几条主线理解：应用面负责启动、接纳、通过 `Promise.allSettled` 汇总各 Server 的并发停止结果、hook 和终态，需要有序清理的组件应在单个 Server 内部组合顺序；调用面负责发现、选择、客户端、服务端投影和传输；事件面负责 broker 与可选的 typed codec；运维面包括配置快照、Store、健康检查、指标、追踪和日志生命周期；对外 Web 则只承接标准 Fetch Handler，跟内部 transport 是两回事。

依赖方向始终朝向可移植接口。Provider 可以依赖官方 SDK 或某个 runtime host，但 SPI 不能反过来知道具体实现。这样同一份业务代码才能在 Bun、Node.js、Deno 或其他兼容 Web API 的后端上复用，而不是被某个框架绑死。

项目不提供 service locator。应用自己构造依赖再显式传进去，多写几行装配代码并不是坏事，它恰好把连接、watcher、listener 和关闭责任都暴露出来了。
