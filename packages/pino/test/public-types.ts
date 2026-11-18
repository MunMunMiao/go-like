import { background } from "@go-like/core/context"
import type { LogHandler } from "@go-like/core/log"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"
import {
  newPinoHandler,
  pinoDrainTimeout,
  type PinoAlreadyStartedError,
  type PinoDestinationClosedError,
  type PinoDrainTimeoutError,
  type PinoHandler
} from "@go-like/pino/log"
import pino, { type Logger } from "pino"

const destination = pino.destination({ dest: 1, sync: false })
const logger: Logger = pino({ base: null }, destination)
const handler: PinoHandler = newPinoHandler(logger, destination, pinoDrainTimeout(25_000))
const asLog: LogHandler = handler
const lifecycle: TelemetryLifecycle = handler.lifecycle
const running: Promise<void> = lifecycle.start(background())
const stopping: Promise<void> = lifecycle.stop(background())

const transport = pino.transport({ target: "pino/file", options: { destination: 1 } })
const transportLogger: Logger = pino({ base: null }, transport)
const transportHandler: PinoHandler = newPinoHandler(transportLogger, transport)

declare const already: PinoAlreadyStartedError
declare const closed: PinoDestinationClosedError
declare const timeout: PinoDrainTimeoutError
void [
  asLog,
  running,
  stopping,
  transportHandler,
  already.status,
  already.code,
  closed.code,
  timeout.timeoutMs,
  timeout.forceSupported
]
