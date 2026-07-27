# @likego/core

`@likego/core` 提供与 go-kratos 对齐的应用生命周期。应用只需要理解 `App.run()`、`App.stop()` 与结构化
`Server.start/stop`；不需要 handle、`done()`、diagnostics 或独立 runner。

## 使用方式

```ts
import type { Context } from "@likego/context"
import { name, newApp, registrar, server, type Server } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Registrar } from "@likego/registry"

declare const registry: Registrar
const httpServer: Server = {
  async start(ctx: Context) {
    await new Promise<void>((resolve) => {
      ctx.done()?.addEventListener("abort", () => resolve(), { once: true })
    })
  },
  async stop(_ctx: Context) {}
}

const app = newApp(name("orders"), server(httpServer), registrar(registry), signal())

await app.run()
```

## 公共模型

```ts
export interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

export interface Endpointer {
  endpoint(ctx: Context): string | PromiseLike<string>
}

export interface App {
  id(): string
  name(): string
  version(): string
  metadata(): Readonly<Record<string, string>>
  endpoint(): readonly string[]
  run(): Promise<void>
  stop(): Promise<void>
}
```

- `server(...servers)` 注册结构化 Server，不要求继承；与 Kratos 一样，后声明的 `server` option
  替换先前列表。
- `registrar(registry)` 在 Server 启动后注册一个 Kratos `ServiceInstance`，并在停止 Server 前反注册；
  `registrarTimeout(ms)` 限制 register/deregister caller 的等待，默认十秒。超时或停止后迟到成功的 register
  会触发一次 best-effort 补偿反注册。
- 显式 `endpoint(...)` 优先作为注册地址；未显式配置时，App 会异步读取 Server 可选的
  `Endpointer.endpoint(ctx)`。这是 JavaScript 异步监听模型对 Kratos `Endpointer` 的直接映射。
- Server 并发启动；`App.stop()` 使用同一个 stop Context 并发调用全部 Server。
- `Server.start(ctx)` 既可在接纳完成后返回，也可像 Kratos HTTP/gRPC Server 一样持续到运行期结束；
  Core 不把它当作 readiness Promise。
- `startTimeout(ms)` 使用一份绝对 deadline 限制 `beforeStart`、endpoint 准备、register 与 `afterStart`；
  默认 `0`，表示不设置 startup deadline。它不覆盖长期运行的 `Server.start(ctx)`。
- `stopTimeout(ms)` 从第一次 `App.stop()` 起使用一份绝对 deadline，覆盖 startup join、`beforeStop`、
  deregister、全部 `Server.stop`、全部 `Server.start` terminal join 与 `afterStop`；默认 `0`，表示不设置
  shutdown deadline。各阶段只使用剩余预算。
- timeout 只结束 App caller 的等待，不证明不合作的 Promise 或底层资源已经 terminal。Core 会继续观察迟到
  resolve/reject 并调用尚未调用的必要 cleanup，但不会调用 `process.exit()`。生产预算应满足“原生 force
  deadline < App stop deadline < supervisor/Kubernetes termination grace”。
- `beforeStart`、`afterStart`、`beforeStop`、`afterStop` 按声明顺序执行；停止会先取消启动 Context，并等待已经
  进入的启动 hook 或注册阶段收束。`Server.start(ctx)` 使用独立运行 Context，在 `beforeStop` 与反注册期间保持
  有效，并在反注册完成后、`Server.stop(ctx)` 前取消；反注册失败也不会跳过该取消。
- 启动 hook 需要中止启动时应抛出错误或取消父 Context；不要在启动 hook 内等待同一个 App 的 `stop()`，
  否则“hook 完成后清理”与“清理完成后 hook 继续”会形成循环等待。
- `context`、`id`、`name`、`version`、`metadata` 和 `endpoint` 对齐 Kratos App options。
- `fromContext(ctx)` 与 `newContext(ctx, info)` 在 Context 中传递同一套 identity accessor。
- `@likego/core/node` 只导出 `signal(...signals)` App option。默认监听 `SIGTERM`、`SIGQUIT`、`SIGINT`，
  第一次信号会设置 Unix exit code、同步移除该 App 自己的全部 listener，再请求 `App.stop()`；第二次信号恢复
  Node 默认终止行为。停止失败将 exit code 改为 `1`。
- `@likego/core/lifecycle` 是 provider-facing 子路径，只提供 `waitForContext`：JavaScript Promise 本身不可取消，
  该 helper 让一个 caller Context 放弃等待时不误取消资源 owner，也不会制造 unhandled rejection。它不属于
  App 的 canonical happy path。
