import { background } from "@go-like/core/context"
import type { LogHandler } from "@go-like/core/log"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"
import {
  newWinstonHandler,
  type WinstonAlreadyStartedError,
  type WinstonHandler,
  type WinstonLoggerClosedError,
  type WinstonLoggerFinishedError
} from "@go-like/winston/log"
import winston, { type Logger } from "winston"

const logger: Logger = winston.createLogger({
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
})
const handler: WinstonHandler = newWinstonHandler(logger)
const asLog: LogHandler = handler
const lifecycle: TelemetryLifecycle = handler.lifecycle
const running: Promise<void> = lifecycle.start(background())
const stopping: Promise<void> = lifecycle.stop(background())

declare const already: WinstonAlreadyStartedError
declare const closed: WinstonLoggerClosedError
declare const finished: WinstonLoggerFinishedError
void [asLog, running, stopping, already.status, already.code, closed.code, finished.code]
