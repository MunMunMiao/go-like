# @go-like/croner

`@go-like/croner` 把应用创建的原生 Croner `Cron` 实例接入 go-like 结构化 `Server` 生命周期。Cron
表达式、时区、重叠保护、错误处理、手动触发、运行次数和其他调度行为全部由 Croner 实现；本包不定义
job schema，也不复制 Croner API。

```ts
import type { Context } from "@go-like/context"
import { newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newCronerServer } from "@go-like/croner"
import { Cron } from "croner"

async function generateDailyReport(ctx: Context): Promise<void> {
  if (ctx.err() !== null) return
  // Application work.
}

const scheduler = newCronerServer<Context>(
  (ctx) =>
    new Cron<Context>(
      "0 0 9 * * *",
      {
        paused: true,
        timezone: "Asia/Shanghai",
        mode: "6-part",
        protect: true,
        catch(error, job) {
          console.error({ error, job: job.name }, "cron callback failed")
        },
        context: ctx
      },
      async (_job, callbackCtx) => {
        await generateDailyReport(callbackCtx)
      }
    )
)

const app = newApp(server(scheduler), signal())
await app.run()
```

## 工厂契约

`newCronerServer(factory)` 在构造阶段不会调用 `factory`。同步工厂只会在 `start(ctx)` 内执行一次，并以
适配器持有的运行期 `Context` 作为第一个参数。工厂必须返回一个原生 `Cron`，或非空的原生 `Cron` 数组。

每个返回实例都必须满足：

- 使用 Croner 原生 `{ paused: true }` 选项构造；
- 已配置调度回调，并且仍有未来执行时间；
- 尚未运行、永久停止或处于执行中；
- 在返回数组中只出现一次。

go-like 按返回顺序恢复任务。启动成功后，每个返回任务的生命周期所有权都归 Server；应用代码不得再对这些实例
调用 `pause()`、`resume()` 或 `stop()`。如果工厂在返回临时任务前抛错，工厂仍负责停止未返回的资源；失败的
工厂无法把适配器从未见过的对象转移给适配器管理。

工厂刻意保持同步：Croner 构造本身就是同步操作；如果允许异步工厂，原生定时器和部分资源就可能逃离启动的
线性化边界。

## 生命周期语义

- `start(ctx)` 检查调用方取消状态、调用工厂、验证休眠任务，然后调用原生 `resume()`。
- 启动失败会永久消耗这个 Server，并按逆序对所有已返回任务调用原生 `stop()`。
- `stop(ctx)` 启动一次共享的所有者停止操作，按逆序调用原生 `stop()`，再取消运行期 `Context`；每个调用方的
  Context 只限制该调用方自己的等待。
- `start(ctx)` 返回的 Promise 覆盖完整运行期，并且只会由显式 go-like 停止操作结算。

Croner `stop()` 会阻止后续调度，但返回 `void`，也不会为正在执行的回调提供 Promise。因此，本适配器不声称
支持活动回调排空、强制取消、硬排空超时或孤儿任务计数。应用通过 Croner 原生 `context` 选项传入运行期
`Context` 后，回调可以观察取消状态，但 `stop()` 仍可能早于该回调完成。

Croner 也没有暴露被动终态 Promise 或事件。通过 `maxRuns`、`stopAt`、一次性调度自然耗尽，或在 go-like 外部调用
原生 `stop()`，都无法可靠结算 go-like 运行期。因此，本包虽然是 v1 发布阻断适配器，但会如实把常驻终态
可观测性声明为 `unobservable`。需要被动退出监督或回调排空的应用，应围绕自己的 Croner 策略实现更丰富的
结构化 `Server`。
