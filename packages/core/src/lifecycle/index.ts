/**
 * Lifecycle participant sockets.
 * `Server` is what an App owns after admission. `Endpointer` publishes an address.
 * `newResourceServer` is the adapter for an application-owned native resource.
 */
import type { Context } from "../context/index"

export type { ResourceServerError, ResourceServerOptions } from "./resource-server"
export { newResourceServer } from "./resource-server"

/**
 * A resident participant the App owns after admission.
 * In `server(...)`, `start` may stay pending until the native terminal.
 * In `resources(...)`, `start` resolves when the resource is usable and rejects when admission fails.
 */
export interface Server {
  /** Admits the participant. */
  start(ctx: Context): Promise<void>
  /** Starts one owner drain. The caller context bounds only this wait. */
  stop(ctx: Context): Promise<void>
}

/**
 * Optional capability of a server-tier participant that publishes an address.
 * Every `Endpointer` in one App must report the same protocol.
 */
export interface Endpointer {
  /** Synchronous protocol discriminator. */
  protocol(): string
  /** Actual endpoint after any asynchronous bind. */
  endpoint(ctx: Context): string | Promise<string>
}
