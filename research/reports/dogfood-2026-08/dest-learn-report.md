# 对照实验结论（2026-08）

初始样本来自 `cd15313d50e6804cfe34a7e7291cb65a861dec1c`。本文区分冻结失败与后续回归，不把当时的成功推广为当前版本或整个 40 项目研究的成功。

## 归因边界

只有同一 dest、同一产品阶段的 go-like 失败与可信对照通过，才形成库缺陷候选。`suspectedOwner` 是原始行级分类，不能覆盖 dest 级双侧失败；安装摩擦、应用组装、探活客户端和 Docker 控制条件也不能单凭症状归到库。

9 个失败样本中，MS-006、MS-009、MS-020 为 go-like 单侧失败；MS-010 仅对照失败；MS-011、MS-013、MS-016、MS-017、MS-018 为双侧失败。完整分类见 [findings-catalog.md](findings-catalog.md)。

## 三个单侧失败的后续对照

| 项目   | 冻结失败                                                           | 后续代码基线                               | 原记录中的观察                                                                       |
| ------ | ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| MS-020 | REST POST 得到 HTTP 200 + missing routing header，无法取得 URI SAN | `43abe749cb9e05c56c99b07a3595dbdb8c2121a0` | 双侧产品阶段通过；六个 go-like 槽返回 HTTP 201、h2 和 `spiffe://ms020/machine/alpha` |
| MS-009 | 默认 `/healthz` 为 HTTP 500                                        | `a6d266718ac322fcb7cc4f5c87a3be46bfe53aff` | 双侧产品阶段通过；fault-worker 探针不再以 500 耗尽启动期限                           |
| MS-006 | recovering setup 阻塞 HTTP 接纳，`/healthz` socket hang up         | `a6d266718ac322fcb7cc4f5c87a3be46bfe53aff` | 双侧产品阶段通过；recovering 初始 setup 前可以取得 handle 并启动 HTTP                |

`a6d2667` 引入路径路由、recovering 接纳和默认探针；`43abe749` 修正 REST ServiceError 的 HTTP 载体状态。这些是原研究的代码基线，不是对当前 HEAD 的描述。

三个后续 dest 各有四条车道 × 三次 repetition，共 12 槽；journal 记录 `status=0 cleanup=0 shutdown=0 gate=1`，project-cleanup 通过，UX 未报告 product-classified failure，也不存在 findings 目录。**它们没有 `verify-*.json`**，因此必须按上述原始证据范围解释，不能补写成拥有新格式证书。

## 从失败中得到的设计结论

- 一次性 resident `start()` 与工作接纳、业务 readiness 是不同信号，不能通过等待长期 Promise 来判断初始化完成。
- REST 载体状态、内部 unary 错误语义和探针 HTTP 状态是三种问题，不能用一种响应约定覆盖全部场景。
- TLS listener 已建立不等于公共 handler 可达，也不等于客户端身份已经安全暴露给应用。
- 通过样本中的 workaround 有时属于实验环境或测试器；不能据此增加库层 API。

契约细节和后续变化见[契约研究](contract-findings.md)。

## 尚不足以成立的结论

MS-011 的初始 File Store 症状与对照文件系统失败并存；后续独立合同实验把等待器覆盖终态错误隔离为消费者问题，见[组件实验](../framework-evidence-2026-08.md)。MS-016/MS-017 的 kill/start 双侧失败需要容器终态、身份与 StartedAt 证据，不能只看 HTTP 端口。

MS-013/MS-018 没有在该后续报告中得到新的可信通过对照。其余 first-wave 和未启动项目也没有因此获得完整验证结果。初始 84 条发现的统计保持不变，没有用后续结果改写旧失败。

## 公开证据边界

初始统计见[样本与证据范围](samples.md)。后续观察来自原报告的运行日志、清理检查和体验记录，但原始产物未公开；本文保留代码基线与结果摘要，不提供本机目录或运行定位信息。
