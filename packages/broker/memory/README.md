# @likego/broker-memory

LikeGo 的进程内 Broker provider。每个实例拥有独立的订阅集合，构造后即可使用，不创建连接，也不需要
`connect`、`disconnect` 或全局 `close`。

该 provider 按精确 topic 广播。每个订阅串行处理已接纳的消息，不同订阅并行执行；`publish` 等待本次接纳的
全部 delivery。`unsubscribe(ctx)` 先停止新消息准入，再等待已接纳 handler 排空，调用方 Context 只限制自己的
等待。handler 失败会结束该订阅，并通过既有 `newBrokerServer(...).start()` 运行期 Promise 报告原始
Error；应用侧 `Subscriber` 仍只有 `topic` 与 `unsubscribe(ctx)`。

Memory Broker 适合单进程服务组合和确定性测试。它不提供 queue group、通配 topic、持久化、ack、DLQ、
Event Store 或 replay；需要这些语义时应选择对应的真实 broker provider。
