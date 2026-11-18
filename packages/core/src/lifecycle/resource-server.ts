import { waitForContext, withoutCancel, type Context } from "../context/index"
import { toError } from "../internal/errors"

import type { Server } from "./index"

/**
 * How an application-owned native resource is admitted, drained, and watched.
 * `terminal` is observed by the kernel through a private channel after admission.
 */
export interface ResourceServerOptions {
  /** Admission step waited by `start`, for example `queue.waitUntilReady()`. */
  readonly open?: (ctx: Context) => Promise<void>
  /**
   * Native terminal, for example `connection.closed()`.
   * An `Error` resolution or a rejection fails the App. A clean resolution uses `GO_LIKE_RESOURCE_CLOSED`.
   */
  readonly terminal?: Promise<Error | void | undefined>
  /** The one owner drain. Called at most once with `withoutCancel` of the first stop context. */
  readonly close: (ctx: Context) => Promise<void>
}

/** Failure from `newResourceServer`: a second start, or a clean terminal that arrived before stop. */
export interface ResourceServerError extends Error {
  readonly name: "ResourceServerError"
  readonly code: "GO_LIKE_RESOURCE_ALREADY_STARTED" | "GO_LIKE_RESOURCE_CLOSED"
}

const terminals = new WeakMap<Server, Promise<Error | void | undefined>>()

type Phase = "idle" | "opening" | "admitted" | "stopping" | "stopped" | "failed"

/**
 * Adapts an application-owned resource to a one-shot `Server` for `resources(...)`.
 * `start` resolves when `open` does. `open` failing never calls `close`.
 * `stop` before `start` marks the server stopped. After admission, `close` runs once.
 */
export function newResourceServer(options: ResourceServerOptions): Server {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("resource server options must be an object")
  }
  if (typeof options.close !== "function")
    throw new TypeError("resource server close must be a function")
  if (options.open !== undefined && typeof options.open !== "function") {
    throw new TypeError("resource server open must be a function")
  }
  if (options.terminal !== undefined && !isThenable(options.terminal)) {
    throw new TypeError("resource server terminal must be a promise")
  }
  const open = options.open
  const terminal = options.terminal
  let phase: Phase = "idle"
  let drain: Promise<void> | null = null

  const server: Server = {
    /** Waits for admission. A second call rejects without touching the native resource. */
    async start(ctx: Context): Promise<void> {
      if (phase !== "idle")
        throw resourceError(
          "GO_LIKE_RESOURCE_ALREADY_STARTED",
          "resource server has already started"
        )
      phase = "opening"
      if (open !== undefined) {
        try {
          await open(ctx)
        } catch (error) {
          if (phase === "opening") phase = "failed"
          throw toError(error, "resource server open failed")
        }
      }
      if (phase === "opening") phase = "admitted"
    },
    /** Starts or joins the one owner drain. The caller context bounds only this wait. */
    stop(ctx: Context): Promise<void> {
      if (phase === "idle") {
        phase = "stopped"
        return Promise.resolve()
      }
      if (phase === "failed") return Promise.resolve()
      if (drain === null) {
        phase = "stopping"
        const owner = withoutCancel(ctx)
        try {
          drain = Promise.resolve(options.close(owner)).then(
            () => {
              phase = "stopped"
            },
            (error: unknown) => {
              phase = "stopped"
              throw toError(error, "resource server close failed")
            }
          )
        } catch (error) {
          phase = "stopped"
          drain = Promise.reject(toError(error, "resource server close failed"))
        }
        void drain.catch(() => {})
      }
      return waitForContext(ctx, drain)
    }
  }
  if (terminal !== undefined) terminals.set(server, terminal)
  return server
}

/** Reads the terminal registered for a server created by `newResourceServer`. */
export function resourceTerminal(server: Server): Promise<Error | void | undefined> | undefined {
  return terminals.get(server)
}

/** Error used when a watched terminal resolves without an Error before stop. */
export function closedResourceFailure(): ResourceServerError {
  return resourceError("GO_LIKE_RESOURCE_CLOSED", "resource closed before stop")
}

/** Builds one frozen resource-server error. */
function resourceError(code: ResourceServerError["code"], message: string): ResourceServerError {
  const error = new Error(message) as ResourceServerError
  Object.defineProperty(error, "name", { value: "ResourceServerError" })
  Object.defineProperty(error, "code", { value: code })
  return error
}

/** Reports whether a value has a callable `then`. */
function isThenable(value: unknown): value is Promise<Error | void | undefined> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  )
}
