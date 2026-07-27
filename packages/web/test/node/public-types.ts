import type { Server } from "@likego/core"
import type {
  NodeServerAlreadyStartedError,
  NodeServerForceCloseError,
  NodeServerOption,
  NodeServerOptions,
  NodeServer,
  NodeServerUnexpectedCloseError
} from "../../src/node"
import { newNodeServer } from "../../src/node"

const defaults: NodeServerOptions = {
  hostname: "127.0.0.1",
  port: 0,
  shutdownTimeoutMs: 25_000
}
const configureHostname: NodeServerOption = (options) => ({
  hostname: "localhost",
  port: options.port,
  shutdownTimeoutMs: options.shutdownTimeoutMs
})
const configured: NodeServerOptions = configureHostname(defaults)
void configured

const server: NodeServer = newNodeServer(() => new Response())
const coreServer: Server = server
void coreServer

const running: Promise<void> = server.start({} as never)
const endpoint: Promise<string> = server.endpoint({} as never)
const stopping: Promise<void> = server.stop({} as never)
void [running, endpoint, stopping]

declare const alreadyStarted: NodeServerAlreadyStartedError
const alreadyCode: "LIKEGO_NODE_SERVER_ALREADY_STARTED" = alreadyStarted.code
void alreadyCode

declare const forceClose: NodeServerForceCloseError
const forceCode: "LIKEGO_NODE_SERVER_FORCE_CLOSE" = forceClose.code
void forceCode

declare const unexpectedClose: NodeServerUnexpectedCloseError
const unexpectedCode: "LIKEGO_NODE_SERVER_UNEXPECTED_CLOSE" = unexpectedClose.code
void unexpectedCode
