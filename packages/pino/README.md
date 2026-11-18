# @go-like/pino

`@go-like/pino` 把应用创建的 Pino destination 接入 `LogHandler` 的 `lifecycle`。公开入口只有
`@go-like/pino/log`。它填充 core 的 `LogHandler` 插座（含 `withAttrs` 与 `lifecycle`）。Pino 继续拥有
logger、level、custom levels、formatter、redaction、bindings、child logger、destination 和 transport 的
全部业务语义；该包不复制或配置这些能力。请求完成日志由 `@go-like/core` 的遥测层写入这个 handler。
Pino 默认的 `err` serializer 会展开 `Error`，因此这里不需要 Winston 那种额外 format。

## 依赖

`@go-like/core` 的 peer 是锁步精确版本，dev 依赖是 `workspace:*`。`pino` 是 peer，因为 handler 要核对
logger 上的 `symbols.streamSym`。`@types/node` 是常规依赖。

| 种类 | 包              | 范围      |
| ---- | --------------- | --------- |
| peer | `@go-like/core` | `0.0.1`   |
| peer | `pino`          | `^10.4.0` |
| 常规 | `@types/node`   | `26.6.6`  |

开发依赖把 `pino` 钉在已验证的 `10.4.0`。

## 使用方式

```ts
import pino from "pino"
import { newApp, server, telemetry } from "@go-like/core"
import { newTelemetry } from "@go-like/core/telemetry"
import { newPinoHandler } from "@go-like/pino/log"

const destination = pino.destination({
  dest: "/var/log/orders/service.log",
  sync: false,
  mkdir: true
})
const logger = pino(
  {
    level: "info",
    redact: ["password", "token"]
  },
  destination
)

// App 接纳 handler 后，destination 的 flush/end/close 生命周期移交给 go-like。
const logging = newPinoHandler(logger, destination)
const app = newApp(telemetry(newTelemetry({ logHandlers: [logging] })), server(httpServer))

const running = app.run()
logger.info({ service: "orders" }, "service ready")
await app.stop()
await running
```

公开入口是 `@go-like/pino/log`：`newPinoHandler(logger, destination, ...options)` 与 `pinoDrainTimeout`。
`newPinoHandler` 返回的 `PinoHandler` 实现 core `LogHandler`，其 `lifecycle` 拥有移交的 destination。

应用始终直接持有并使用官方 `pino.Logger`。`newPinoHandler` 只验证 logger 通过 Pino 公开的
`symbols.streamSym` 绑定了同一个 destination；`start(ctx)` 的同步准入完成前 destination 仍由应用拥有，也不会
留下适配器监听器。接纳后，应用不得再调用 destination 的 `end()` 或 `destroy()`；一个原生资源只能
有一个生命周期 owner。应用可以继续用 logger 写记录，但不得替换 logger 的 `flush`/stream binding 或
destination 的 lifecycle 方法。adapter 使用构造期捕获、start 准入确认的固定 `flush`/`end`/`destroy` 引用；若 logger
stream 之后漂移，会跳过错配 flush、清理原 destination 并以失败结算，绝不会把错配资源报告为成功 terminal。
无需 go-like 管理的 logger 直接使用 Pino 即可，不需要额外包装。

公开类型边界直接接收官方 `pino.Logger`，以及 `pino.destination()` 或 `pino.transport()` 的官方返回类型。
该包不导出 `PinoLogger`、`PinoDestination`，也不复制日志方法、stream 写入方法或 EventEmitter API；包内只保留
运行时校验和确定性单元测试所需的最小生命周期 seam，它不是 package root API。
`sonic-boom` 由 `pino` 自己声明和解析；本包不直接依赖、不声明 peer，也不 import 或校验其原型品牌。
Pino `10.4.0` 当前声明 `sonic-boom ^4.0.1`，消费应用可以独立使用 SonicBoom `5.x`，npm 会为 Pino 保留其
受支持的 `4.x` 实现，不需要 override。运行时边界是 Pino destination 的生命周期结构：
`newPinoHandler` 同步构造时捕获第一次观察到的 `logger.flush` 与 destination `end`/`destroy`，之后只接受相同
函数引用。构造前已经存在的结构化包装会成为基线；本包不再承诺 implementation package provenance 或精确
SonicBoom 版本。
由于 Pino、其 destination 实现与 ThreadStream 的公开声明引用 Node 类型，该包把固定版本的 `@types/node` 声明为正式
依赖，供仅安装真实发布 tarball 的 TypeScript 消费者解析 Node 声明。当前 manifest 固定 `26.6.6`。
ThreadStream `4.2.0` 仍引用 Node 26 类型中已删除的旧别名 `TransferListItem`；它在 Node 25 声明中精确等价于仍存在的
`Transferable`。本包随声明输出一个仅包含 `TransferListItem = Transferable` 的兼容 module augmentation，
不改变运行时代码或 Pino API；对应的[上游问题](https://github.com/pinojs/thread-stream/issues/228)修复发布后
删除该临时声明桥。

## 生命周期

- `newPinoHandler` 同步构造时先验证 Pino file destination 或 ThreadStream 的状态结构、logger stream 绑定，
  并冻结第一次稳定读取到的 `flush`/`end`/`destroy`。`start(ctx)` 检查调用方 Context，并在安装原生
  `error`/`close` 监听器前后以及发布 owner 前三次对照这份构造期快照，同时复核 logger stream 绑定、已观察
  failure 与终态，随后才完成所有权移交。准入读取 Pino file destination 的内部 `_ending` 与公开
  `destroyed`/`writable`，以及
  ThreadStream `4.2.0` 的 `destroyed`/`closed`/`writable`/`writableEnded`/`writableFinished`/
  `writableErrored`。Pino file destination 当前没有公开等价的 end-in-progress 状态；本包因此要求 `_ending`
  保持布尔形状，但不据此声称实现版本或 provenance。相对构造快照的方法漂移、logger binding 或状态形状不符
  都会 fail closed；不读取 `ready` 或 `fd`。已关闭或正在
  结束的资源会在所有权移交前被拒绝，
  adapter 不调用其 `end()`/`destroy()`，也会撤销已安装的监听器；`writableErrored` 中的原生 `Error` 保持
  原对象身份。operation getter 在 start revalidation 期间同步触发的 `error`、`close` 或 destination terminal 同样会在
  ownership 发布前被第三次 admission 拒绝，不会进入运行期或触发 owner 调用。`start(ctx)` 返回的 Promise
  表示完整运行期，只在真实原生 `close` 后结算。
- `stop(ctx)` 第一次调用创建共享 owner drain：`logger.flush(callback)`、`destination.end()`、等待原生
  `close`。这些调用使用构造期捕获、start 准入确认的固定函数与原生 receiver；flush 前还会核对 logger 仍绑定
  transferred destination。每个调用方 Context 只限制自己的等待。
- destination 在运行期间意外 `error` 或 `close` 会使 `start(ctx)` 的运行期 Promise reject，并触发清理。
- `destination.end()` 抛错只记录为清理失败，不会提前伪造终态。adapter 默认拥有 25 秒 owner wait 边界，
  并在原生操作返回后复核单调时钟；边界到期会结算共享 stop waiter。Pino file destination 暴露 `destroy()` 时只
  尽力调用一次；ThreadStream 没有公开 force 方法，因此超时错误的 `forceSupported` 为 `false`。无论
  `destroy()` 缺失、抛错还是调用后没有关闭，运行期 Promise 与 listener 都继续等待真实原生 `close`。
  `pinoDrainTimeout(ms)` 只配置这一真实 Pino drain 边界；App 的整体停止等待由 Core `stopTimeout(ms)` 配置。
- adapter 不打开路径。路径错误由应用调用 Pino 官方 constructor 时原样产生，不会被 go-like 改写。

Pino 版本固定为当前验证的 `10.4.0`。运行时 E2E 会创建官方异步 destination，写入结构化日志，并在
lifecycle stop 后读取最终文件，证明 flush/end/close 的实际顺序。

## 错误码

| 代码                              | 类型                         | 何时出现                                      |
| --------------------------------- | ---------------------------- | --------------------------------------------- |
| `GO_LIKE_PINO_ALREADY_STARTED`    | `PinoAlreadyStartedError`    | 同一个 handler 再次 `start`                   |
| `GO_LIKE_PINO_DRAIN_TIMEOUT`      | `PinoDrainTimeoutError`      | owner 排空超过 `pinoDrainTimeout`，默认 25 秒 |
| `GO_LIKE_PINO_DESTINATION_CLOSED` | `PinoDestinationClosedError` | destination 在移交前或运行中已经关闭          |

`PinoDrainTimeoutError.forceSupported` 只在 file destination 暴露 `destroy()` 时为 `true`。

## 验证

```sh
bun run --cwd packages/pino typecheck
bun run --cwd packages/pino test:unit:coverage
bun run --cwd packages/pino build
bun run --cwd packages/pino test:e2e:runtimes
```

`test:e2e:runtimes` 使用 Bun 与 Node 运行真实 destination/transport 生命周期；仓库级
`test:e2e:published` 负责验证发布 tarball 的安装与公共入口。
