# 生命周期与 provider 故障：历史研究结论

研究日期：2026-07-25 至 2026-07-26。原基线为 `078e24c3b6ebc9228968acf3489cddc7e552b0c4` 加当时工作区实现。以下区分观察到的缺陷与设计回应，不判断当前代码是否仍有缺陷。

## 生命周期与错误观察

| 原观察                                                                        | 设计回应与理由                                                                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 不合作的 `Server.stop()`、Registrar 或 resident `start()` 令 App 永久 pending | 使用一个覆盖停止各阶段的剩余总预算；超时只能结束等待，不能证明原生资源已经关闭                      |
| Server Promise 立即拒绝，而 `afterStart` 延迟时出现 unhandled rejection       | 创建 Promise 时立即观察 rejection，保留原 Promise 供最终错误聚合，不能把 observer 变成吞错          |
| Node Web 同一事件循环内 start 后 stop，admission 永久 pending                 | clean stop、listen 成功和 startup failure 共享一次性 admission 结算；迟到 listener 不得恢复 running |
| 取消启动 Context 会让 listener 在注销前提前退出                               | 启动取消与运行取消分离，先收束启动和注销实例，再停止运行资源                                        |
| watcher 的 `next()` 与 `stop()` 同时失败                                      | 聚合保留两个失败与顺序，不能以 cleanup 错误覆盖原始失败，也不能无限重试已终止的 watcher             |
| options 返回内部 Map 或已注销 probe 仍被列表持有                              | 返回防御性快照；注销时释放所有持有关系，避免调用方改变在线 dispatcher 或残留闭包保留资源            |

这些取舍将 caller 等待预算与资源 owner 的清理分开。迟到成功需要补偿处理，迟到失败需要继续被观察；超时不等于成功取消。

## Provider 与数据面

| 研究问题                                 | 取舍                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Config/Registry 初次就绪后的后台终态故障 | 使用明确的终态观察通道；可恢复 reload 与不可恢复 terminal 分开，避免将短暂失联都升级为终态                |
| Client 空闲连接没有容量和寿命上限        | 在 client owner 维度约束 idle 数量与真实时间 TTL，共享 acquire/evict/close 的所有权，避免每条路径独立关闭 |
| RabbitMQ publish 返回不等于 broker 接受  | 使用原生 ConfirmChannel，确认中断保留失败语义，不据此承诺 exactly-once                                    |
| Redis 单 URL 入口限制已有 SDK 能力       | 复用 node-redis 的 TLS、Sentinel、Cluster 配置与原生 client，不复制供应商拓扑模型                         |
| completion 日志或 span 复制原始 Error    | 默认只记录安全的结构字段；原始 message、stack、cause 不自动流入观测或 wire                                |

## 原实验范围

原记录中 Core/Config 既有基线为 55 通过、0 失败，但独立的不合作 Promise 复现仍失败，说明既有门禁通过不能证明未覆盖场景。

RabbitMQ 4.3.4 Docker 基线验证了发布订阅、手动 ack、consumer recovery 与 owner cleanup，未证明 publisher confirms。Redis 8.8.1 基线验证了五项 Cache conformance、二进制值、协议错误和 cleanup，未证明 TLS、Sentinel 或 Cluster。这些缺项是当时的证据边界，不是对当前能力的判断。

## 上游比较基线

原研究参考 Kratos v3.0.0 (`668db92c…`)、go-micro v6.8.0 (`db4401d3…`)、Node 24.18.0/26.5.0、Fastify 5.10.0、chokidar 5.0.0、Kubernetes 1.36.3、Undici 8.9.0、amqplib 2.0.1、node-redis 6.1.0。精确提交和完整条件见下方原始记录。

## 不成立的推论

- 与 Go API 形状相似，不表示 JavaScript Promise 获得 goroutine 的强制取消能力。
- 一次 graceful shutdown 不证明重复启动同一 App 合法，也不证明异常中断后的恢复。
- mock、健康 HTTP、通过数和清理记录各自只回答一种问题，不能互相替代。
- 短时实验不能支持高可用、备份恢复、容量上限或长期资源稳定性声明。
