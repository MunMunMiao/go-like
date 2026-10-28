# 历史发现分类

研究范围：2026-08 初始样本中的 84 条发现，来自 9 个失败样本。以下按症状与对照结果合并同类记录；机器路径、审查角色编号、运行 UUID 和原始日志索引不属于公开摘要。完整样本分母见[样本与证据范围](samples.md)。

文中的旧路由头、API 和缺陷描述属于研究基线。后续结论见[对照实验结论](dest-learn-report.md)，当前调用方式见[服务调用指南](../../../doc/guide/service-call.md)。

## 分类与计数

| 样本   | 对照分类                               | 失败阶段     | 发现条数 | 症状与归因边界                                                 |
| ------ | -------------------------------------- | ------------ | -------: | -------------------------------------------------------------- |
| MS-006 | LikeGo 单侧失败                        | healthy-path |        6 | recovering broker 初始化等待阻塞 HTTP 接纳，对照通过           |
| MS-009 | LikeGo 单侧失败                        | healthy-path |        6 | 默认健康探针返回 500，对照返回 200                             |
| MS-010 | 仅对照失败                             | fault-matrix |        6 | 对照出现 socket hang up；LikeGo 六槽通过                       |
| MS-011 | 双侧失败                               | healthy-path |       12 | LikeGo 等待 File Store 就绪超时；对照未完成崩溃租约恢复        |
| MS-013 | 双侧失败                               | healthy-path |       12 | LikeGo 业务网关返回 502；对照网关未能通过健康检查              |
| MS-016 | 双侧失败                               | fault-matrix |       12 | 双侧 kill/start 后未在期限内恢复 liveness；healthy-path 已通过 |
| MS-017 | 双侧失败                               | fault-matrix |       12 | 双侧外部重启后未恢复 liveness；healthy-path 已通过             |
| MS-018 | 双侧失败                               | healthy-path |       12 | LikeGo 后段 controller/ledger 未就绪；对照 replica 未就绪      |
| MS-020 | LikeGo 单侧失败                        | healthy-path |        6 | mTLS/h2 已建立，REST 请求却被旧服务信封阻挡，对照返回 201      |
| 合计   | 3 个单侧、1 个仅对照、5 个双侧失败样本 |              |       84 |                                                                |

LikeGo 单侧失败贡献 18 条，只有对照失败贡献 6 条，双侧失败贡献 60 条。初始记录中的 `status=reproduced` 与每条车道三次 repetition 不等于 84 个不同缺陷。

行级 `suspectedOwner` 只是初始分类。双侧失败的 60 条中，6 条标记 go-like、24 条标记 application、30 条标记 competitor；它们不能覆盖样本级双侧失败这一事实。

## 可形成库缺陷候选的三组观察

### Recovering broker 的接纳边界

MS-006 在 `ensureSchema` 后等待 `openRecoveringBroker`，直到 `setupCompleted` 才能取得 handle 并绑定 HTTP。初始化重试使 `/healthz` 在 60 秒启动窗口内不可达；相同拓扑的对照可以启动。该证据指向长期恢复过程与初始工作接纳耦合，不能靠应用提前绑定 HTTP 来宣称框架问题已修复。

### 健康探针的 HTTP 语义

MS-009 的默认探针持续返回 500，而自定义 handler 与对照均可返回 200。样本接受 200 或 503，因此该观察支持检查默认探针语义；它不证明所有业务依赖已经就绪。

### REST 与内部 RPC 信封

MS-020 在 required-mTLS HTTP/2 下完成 TLS 1.3 与 h2 协商，但公开 REST 请求因缺少旧路由头而得到 HTTP 200 载体和内部 400 错误。对照返回约定的 201。原公共接口还不能提供已验证的客户端 URI SAN，因此协议已建立、业务 handler 可达和安全身份可用是三个独立边界。

三组观察的后续修复基线与回归范围见[实验结论](dest-learn-report.md)和[契约研究](contract-findings.md)。

## 不能直接归因于库的观察

- **MS-010**：失败只出现在对照的故障阶段，不能列作 LikeGo 缺陷。
- **MS-011**：两侧失败点不同，初始样本缺少通过对照。后续组件实验才把等待器覆盖终态错误隔离为消费者问题，见[File Store 实验](../framework-evidence-2026-08.md)。
- **MS-013**：LikeGo 到达业务请求后返回 502，对照停在网关健康检查；不能只凭两个错误码比较库质量。
- **MS-016/MS-017**：HTTP `ECONNREFUSED` 不能证明库无法恢复，需要容器身份、终态、退出码和重新启动证据。后续对照补足了这部分取证。
- **MS-018**：双方失败角色不同；没有新的通过对照，不能将应用启动顺序问题直接提升为 `@go-like/web` 或 Kubernetes 客户端缺陷。

本页保留初始统计，不用后续结果覆盖旧失败，也不把未公开的原始产物包装成可直接重放的实验。
