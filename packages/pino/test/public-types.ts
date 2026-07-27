import type { Broker } from "@likego/broker"
import type { Client } from "@likego/client"
import { background } from "@likego/context"
import type { Server } from "@likego/core"
import type { Middleware } from "@likego/server"
import pino, { type Logger } from "pino"

import {
  logBroker,
  logClient,
  logUnaryMiddleware,
  logWebHandler,
  pinoDrainTimeout,
  newPinoServer,
  type PinoAlreadyStartedError,
  type PinoDestinationClosedError,
  type PinoDrainTimeoutError,
  type PinoServer
} from "../src/index"

const destination = pino.destination({ dest: 1, sync: false })
const logger: Logger = pino({ base: null }, destination)
const lifecycleDestination: Parameters<typeof newPinoServer>[1] = destination
const logging: PinoServer = newPinoServer(logger, lifecycleDestination, pinoDrainTimeout(25_000))
const structural: Server = logging
const running: Promise<void> = logging.start(background())
const stopping: Promise<void> = logging.stop(background())

const transport = pino.transport({ target: "pino/file", options: { destination: 1 } })
const transportLogger: Logger = pino({ base: null }, transport)
const lifecycleTransport: Parameters<typeof newPinoServer>[1] = transport
const transportLogging: Server = newPinoServer(transportLogger, lifecycleTransport)

declare const client: Client
declare const broker: Broker<undefined, number, undefined, Readonly<{ id: string }>>
const loggedClient: Client = logClient(client, logger)
const loggedUnary: Middleware = logUnaryMiddleware(logger)
const loggedWeb: (request: Request) => Response | Promise<Response> = logWebHandler(
  () => new Response(),
  logger
)
const loggedBroker: typeof broker = logBroker(broker, logger)

declare const already: PinoAlreadyStartedError
declare const closed: PinoDestinationClosedError
declare const timeout: PinoDrainTimeoutError
void [
  structural,
  running,
  stopping,
  transportLogging,
  loggedClient,
  loggedUnary,
  loggedWeb,
  loggedBroker,
  already.status,
  closed.code,
  timeout.timeoutMs
]
