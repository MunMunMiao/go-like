# @likego/winston

`@likego/winston` 把应用创建的官方 Winston `Logger` 接入 LikeGo `Server` 生命周期，并为 Client、
内部 unary Server、标准 Web Handler 与 Broker 提供显式请求日志包装。应用仍然直接使用原生 logger；
LikeGo 不定义 Logger facade、日志格式、transport、child logger 或异常处理策略。

## 使用方式

```ts
import { newApp, server } from "@likego/core"
import { newWinstonServer } from "@likego/winston"
import winston from "winston"

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [new winston.transports.File({ filename: "/var/log/orders/service.log" })]
})

const logging = newWinstonServer(logger)
const app = newApp(server(httpServer, logging))

const running = app.run()
logger.info("service ready", { service: "orders" })
await app.stop()
await running
```

调用 `newWinstonServer(logger)` 只做同步接口校验，不读取终态、不安装监听器，也不改变 logger 所有权。
应用始终持有原生 logger 数据面引用并继续调用日志方法。只有 `start(ctx)` 通过取消检查、确认 logger 尚未
终止并完整安装生命周期监听器后，LikeGo 才接管该次已启动实例的 stop 契约；此后应用不得再调用 `end()`
或 `close()`。需要记录其他组件的最终日志时，应让这些组件在 logging 停止前完成自己的收尾。

对应 `owner.json` 的真实拆分 tuple 为：`owner: application-owned`、`exposure: native-borrowed`、
`stopContract: likego-owned`。它表示应用拥有并直接暴露 Winston 数据面，但成功启动后的终止操作由 LikeGo
统一发起；并不表示 LikeGo 私有化或重新创建 logger。

## 生命周期契约

- `start(ctx)` 首先同步检查调用方 Context。若 Context 已取消，start 原样拒绝，logger 不会被 `end()`、
  不会增加监听器，仍完全由应用拥有；一旦 start 失败，该 Server 仍按 one-shot 语义被消费。
- 原生 `error`、`finish`、`close` 监听器只在 start 内安装。任一监听安装失败会撤销已经安装的全部监听，
  不发生生命周期移交。
- 第一次 `stop(ctx)` 调用官方 writable-stream `logger.end()`，然后等待真实的 `finish` 或 `close`。Winston
  只在所有 transport 已完成排空后发出 `finish`；提前 `close` 作为异常终态报告。
- 后续 `stop` 共享同一个所有者排空；每个调用方 `Context` 只限制自身等待，不会取消已经开始的排空。
- 原生 `error` 会保留其 `Error` 标识，触发 owner stop，并在到达 `finish` 后使 `start(ctx)` 的运行期
  Promise reject。
  多个不同错误按观测顺序聚合。
- owner stop 之前出现 `finish` 或任意时刻出现 logger `close` 都属于意外终态，使运行期 Promise reject。
- 适配器绝不调用 `logger.close()`、`destroy()`，也不遍历或强杀应用配置的 transports。Winston 没有适用于
  任意 transport 的统一 force 原语；如果 `end()` 后没有真实 `finish`/`close`，`stop()` 与运行期 Promise
  都保持 pending。调用方 Context 超时只结束该调用方等待；应用级 `stopTimeout` 负责限制整体停止等待，
  适配器不会伪造原生关闭。

Winston 的 `handleExceptions` 和 `handleRejections` 会安装进程级处理器，而 `logger.close()` 才负责移除它们。
本适配器不调用 `close()`，因此应用不应把这两项全局能力的清理责任隐式交给本适配器；需要时应由独立的
应用级 Server 明确拥有这些进程处理器。

当前固定并验证 Winston `3.19.0`。依据：

- [Winston README：Logger 是 Node stream，`end()` 后的 `finish` 表示全部 transport 已 flush](https://github.com/winstonjs/winston/blob/v3.19.0/README.md)
- [Winston Logger 源码：`_final()` 等待 transports 的 `finish`；`close()` 是独立清理动作](https://github.com/winstonjs/winston/blob/v3.19.0/lib/winston/logger.js)

## 请求完成日志

```ts
import { logBroker, logClient, logUnaryMiddleware, logWebHandler } from "@likego/winston"

const client = logClient(nativeClient, logger)
const unary = logUnaryMiddleware(logger)
const web = logWebHandler(fetchHandler, logger)
const broker = logBroker(nativeBroker, logger)
```

四个适配器都只在一个逻辑操作完成时写一条原生 Winston 日志：

- Client operation 为 `service/endpoint`；一次包含重试的逻辑调用仍只记录一次。
- unary Server operation 从 LikeGo routing header 读取 `service/endpoint`。
- Web operation 只记录 HTTP method，并在成功响应时增加 `httpStatus`；不记录 URL 或 path。
- Broker operation 为 `publish <topic>` 或 `consume <topic>`；topic 应保持为稳定、低基数的业务主题。

公共结构化字段只有 `component`、`operation`、`outcome` 与 `durationMs`；Web 响应可增加
`httpStatus`。失败只可增加格式为 `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` 的 `errorType`，以及格式为
`^[A-Z0-9_.-]{1,64}$` 的 `errorCode`；非法、过长或读取失败的字段会被省略。`outcome` 只有
`success`、`failure`、`canceled`。成功和取消使用 `logger.info`，失败使用 `logger.error`。适配器不记录
原始 Error、message、stack、cause、body、headers、metadata、URL/path 或 Broker payload，也不接管
Client、Handler、Broker 或 Subscriber 生命周期。需要记录原始错误时，应用应在自己的原生 Logger 边界
显式处理。Winston 同步写入异常按 best-effort 处理，不会替换业务返回值或原始失败。

Client、unary Server 与 Broker 的 fulfilled 操作记为 `success`；rejected 操作在 Context 已取消时记为
`canceled`，否则记为 `failure`。Web 优先把已 abort 的 request 记为 `canceled`，其次把 HTTP 5xx
Response 或 throw/reject 记为 `failure`，其余 Response 记为 `success`。
