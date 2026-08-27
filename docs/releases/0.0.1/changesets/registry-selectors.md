---
"@go-like/registry": patch
---

增加 random、weighted round-robin、带 in-flight/连续失败/cooldown 反馈的 P2C，以及 Kratos 风格 P2C+EWMA
endpoint selector；反馈回调防同步重入并观察非法 thenable，HTTP 503/504 与 Bun 真实 Web 网络错误会降低健康度。
同一 endpoint 的反馈 transaction 同步串行，交叉重入不会覆盖较新的 EWMA/P2C 状态；合法 observation 恰好结算
一次，失败 transaction 保持可重试。outcome、Context、时钟、随机源、分类器和错误字段的同步边界会观察返回或
抛出或承载的 thenable，再以 `TypeError` fail closed；array、callable 与带自有 `then` 的 callback 也执行相同检查。
嵌套 getter、`then()`、settlement 和自定义 continuation 使用带 identity 去重和 64 个外部 candidate 上限的同一观察
预算，observer 自身创建的原生安全 continuation 不占预算；64 层原生拒绝链可完整观察，超过上限的动态无界图不在保证
范围。selector option getter 改为逐字段读取后立即验证，后续 getter 抛错不会遗漏较早的异步非法值。P2C fresh
domain 会在外部时钟和随机源同步重入期间共享 provisional state；无提交失败会回滚，已提交 nested selection 不会再被
outer state 覆盖。P2C 在每次随机回调后以同一 timestamp 重验 cooldown eligibility，不重采样；EWMA 的
`lastPick` 与 `stamp` 在回退时钟和同步重入下保持单调。
