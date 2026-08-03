import type { Broker } from "@likego/broker"
import type { Client } from "@likego/client"
import type { Server } from "@likego/core"
import type { Middleware } from "@likego/server"
import winston, { type Logger } from "winston"

import {
  logBroker,
  logClient,
  logUnaryMiddleware,
  logWebHandler,
  newWinstonServer,
  type WinstonAlreadyStartedError,
  type WinstonLoggerClosedError,
  type WinstonLoggerFinishedError,
  type WinstonServer
} from "../src/index"

const logger: Logger = winston.createLogger({
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
})
const logging: WinstonServer = newWinstonServer(logger)
const structural: Server = logging
declare const client: Client
declare const broker: Broker<void, void, void, unknown>
declare const webHandler: (request: Request) => Response | Promise<Response>
const loggedClient: Client = logClient(client, logger)
const loggedBroker: Broker<void, void, void, unknown> = logBroker(broker, logger)
const loggedUnary: Middleware = logUnaryMiddleware(logger)
const loggedWeb: (request: Request) => Response | Promise<Response> = logWebHandler(
  webHandler,
  logger
)

declare const already: WinstonAlreadyStartedError
declare const closed: WinstonLoggerClosedError
declare const finished: WinstonLoggerFinishedError
void [
  structural,
  loggedClient,
  loggedBroker,
  loggedUnary,
  loggedWeb,
  already.status,
  closed.code,
  finished.code
]
