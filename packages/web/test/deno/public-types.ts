import type { Server } from "@go-like/core"
import type {
  DenoServerAlreadyStartedError,
  DenoServerForceCloseError,
  DenoServerOption,
  DenoServerOptions,
  DenoServer,
  DenoServerUnexpectedCloseError
} from "../../src/deno"
import { newDenoServer } from "../../src/deno"

const defaults: DenoServerOptions = {
  hostname: "127.0.0.1",
  port: 0,
  shutdownTimeoutMs: 25_000
}
const configureHostname: DenoServerOption = (options) => ({
  hostname: "localhost",
  port: options.port,
  shutdownTimeoutMs: options.shutdownTimeoutMs
})
const configured: DenoServerOptions = configureHostname(defaults)
void configured

const server: DenoServer = newDenoServer(() => new Response())
const coreServer: Server = server
void coreServer

const running: Promise<void> = server.start({} as never)
const protocol: string = server.protocol()
const endpoint: Promise<string> = server.endpoint({} as never)
const stopping: Promise<void> = server.stop({} as never)
void [running, protocol, endpoint, stopping]

declare const alreadyStarted: DenoServerAlreadyStartedError
const alreadyName: "DenoServerAlreadyStartedError" = alreadyStarted.name
const alreadyCode: "GO_LIKE_DENO_SERVER_ALREADY_STARTED" = alreadyStarted.code
const alreadyStatus: "starting" | "running" | "stopping" | "stopped" | "failed" =
  alreadyStarted.status
void [alreadyName, alreadyCode, alreadyStatus]

declare const forceClose: DenoServerForceCloseError
const forceName: "DenoServerForceCloseError" = forceClose.name
const forceCode: "GO_LIKE_DENO_SERVER_FORCE_CLOSE" = forceClose.code
const forceTimeout: number = forceClose.timeoutMs
const forceActive: number = forceClose.activeRequests
void [forceName, forceCode, forceTimeout, forceActive]

declare const unexpectedClose: DenoServerUnexpectedCloseError
const unexpectedName: "DenoServerUnexpectedCloseError" = unexpectedClose.name
const unexpectedCode: "GO_LIKE_DENO_SERVER_UNEXPECTED_CLOSE" = unexpectedClose.code
void [unexpectedName, unexpectedCode]
