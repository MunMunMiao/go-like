# @go-like/winston

`@go-like/winston` 把应用创建的官方 Winston `Logger` 接入 `LogHandler` 的 `lifecycle`。公开入口只有
`@go-like/winston/log`。它填充 core 的 `LogHandler` 插座（含 `withAttrs` 与 `lifecycle`）。应用仍然直接使用原生
logger；go-like 不安装日志格式、transport 或 child logger。请求完成日志由 `@go-like/core` 的遥测层写入这个 handler。

诊断字段 `exception`（`LogField.exception`）会写到 winston 的 `error` 键上。只使用 `winston.format.json()` 时，
`Error` 会序列化成 `{}`，`name`、`message` 和 `stack` 都会丢失。应用必须在 `json()` 之前用自己的 format 把
`info.error` 展开。Pino 的默认 `err` serializer 已经做了这件事，Winston 没有。

## 依赖

种类按清单原文。`@go-like/core` 的 peer 是锁步精确版本，dev 依赖是 `workspace:*`。`winston` 只做类型导入。

| 种类      | 包              | 范围      |
| --------- | --------------- | --------- |
| peer      | `@go-like/core` | `0.0.1`   |
| 可选 peer | `winston`       | `^3.19.0` |
| 开发      | `@types/node`   | `26.6.6`  |

开发依赖把 `winston` 钉在已验证的 `3.19.0`。

## 使用方式

```ts
import { newApp, server, telemetry } from "@go-like/core"
import { newTelemetry } from "@go-like/core/telemetry"
import { newWinstonHandler } from "@go-like/winston/log"
import winston from "winston"

const expandError = winston.format((info) => {
  const error = info["error"]
  if (error instanceof Error) {
    info["error"] = { name: error.name, message: error.message, stack: error.stack }
  }
  return info
})

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(expandError(), winston.format.json()),
  transports: [new winston.transports.File({ filename: "/var/log/orders/service.log" })]
})

const logging = newWinstonHandler(logger)
const app = newApp(telemetry(newTelemetry({ logHandlers: [logging] })), server(httpServer))

const running = app.run()
logger.info("service ready", { service: "orders" })
await app.stop()
await running
```

公开入口是 `@go-like/winston/log`。调用 `newWinstonHandler(logger)` 只做同步接口校验，不读取终态、不安装监听器，也不改变 logger 所有权。
应用始终持有原生 logger 数据面引用并继续调用日志方法。只有 `start(ctx)` 通过取消检查、确认 logger 尚未
终止并完整安装生命周期监听器后，go-like 才接管该次已启动实例的 stop 契约；此后应用不得再调用 `end()`
或 `close()`。需要记录其他组件的最终日志时，应让这些组件在 logging 停止前完成自己的收尾。

所有权拆分为：`owner: application-owned`、`exposure: native-borrowed`、
`stopContract: go-like-owned`。它表示应用拥有并直接暴露 Winston 数据面，但成功启动后的终止操作由 go-like
统一发起；并不表示 go-like 私有化或重新创建 logger。

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

## 错误码

| 代码                              | 类型                         | 何时出现                          |
| --------------------------------- | ---------------------------- | --------------------------------- |
| `GO_LIKE_WINSTON_ALREADY_STARTED` | `WinstonAlreadyStartedError` | 同一个 handler 再次 `start`       |
| `GO_LIKE_WINSTON_LOGGER_FINISHED` | `WinstonLoggerFinishedError` | owner 停止之外 logger 已 `finish` |
| `GO_LIKE_WINSTON_LOGGER_CLOSED`   | `WinstonLoggerClosedError`   | logger 出现 `close`               |

当前固定并验证 Winston `3.19.0`。依据：

- [Winston README：Logger 是 Node stream，`end()` 后的 `finish` 表示全部 transport 已 flush](https://github.com/winstonjs/winston/blob/v3.19.0/README.md)
- [Winston Logger 源码：`_final()` 等待 transports 的 `finish`；`close()` 是独立清理动作](https://github.com/winstonjs/winston/blob/v3.19.0/lib/winston/logger.js)
