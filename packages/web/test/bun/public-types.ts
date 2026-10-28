import type { Server } from "@go-like/core"
import type {
  BunServerAlreadyStartedError,
  BunServerForceCloseError,
  BunServerOption,
  BunServerOptions,
  BunServer
} from "../../src/bun"
import { newBunServer } from "../../src/bun"

const defaults: BunServerOptions = {
  hostname: "127.0.0.1",
  port: 0,
  shutdownTimeoutMs: 25_000
}
const configureHostname: BunServerOption = (options) => ({
  hostname: "localhost",
  port: options.port,
  shutdownTimeoutMs: options.shutdownTimeoutMs
})
const configured: BunServerOptions = configureHostname(defaults)
void configured

const server: BunServer = newBunServer(() => new Response())
const coreServer: Server = server
void coreServer

const running: Promise<void> = server.start({} as never)
const protocol: string = server.protocol()
const endpoint: Promise<string> = server.endpoint({} as never)
const stopping: Promise<void> = server.stop({} as never)
void [running, protocol, endpoint, stopping]

declare const alreadyStarted: BunServerAlreadyStartedError
const alreadyName: "BunServerAlreadyStartedError" = alreadyStarted.name
const alreadyCode: "GO_LIKE_BUN_SERVER_ALREADY_STARTED" = alreadyStarted.code
const alreadyStatus: "starting" | "running" | "stopping" | "stopped" | "failed" =
  alreadyStarted.status
void [alreadyName, alreadyCode, alreadyStatus]

declare const forceClose: BunServerForceCloseError
const forceName: "BunServerForceCloseError" = forceClose.name
const forceCode: "GO_LIKE_BUN_SERVER_FORCE_CLOSE" = forceClose.code
const forceTimeout: number = forceClose.timeoutMs
const forceActive: number = forceClose.activeRequests
void [forceName, forceCode, forceTimeout, forceActive]
