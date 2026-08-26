# @go-like/health

面向 go-like 的可移植存活探针与就绪探针注册表。

该包只定义 probe 注册、并发检查和取消，不包含 HTTP 或 Web handler。对外健康检查端点由
`@go-like/web/health` 提供，应用通过结构式 `ProbeRegistry` 显式组合两者。

空 liveness 快照返回 `ok: true`；空 readiness 快照 fail closed，返回 `ok: false`。readiness 只有在至少
注册一个 probe 且全部 ready probe 都成功时才返回 `ok: true`。

不需要 HTTP 时，应用可以直接检查 Registry：

```ts
const report = await probes.check(ctx, "ready")
if (!report.ok) throw new Error("workload admission failed")
```

应用可把这个 report 交给自己的 CLI、supervisor adapter、测试或 management route；Health package 不创建 HTTP
listener。

内部服务确实需要在首次 Registry 发布前校验就绪状态时，使用 Core App 已有的 `beforeStart(...)` hook：

```ts
beforeStart(async (ctx) => {
  if (!(await probes.check(ctx, "ready")).ok) throw new Error("service is not ready")
})
```

该组合只负责启动期 fail-closed，不引入第二套 readiness DSL，也不创建后台轮询。运行期是否撤销注册必须由
应用根据自身健康策略显式决定。
