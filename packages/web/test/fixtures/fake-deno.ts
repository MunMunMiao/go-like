import type {
  DenoRuntime,
  DenoServeInfo,
  DenoServeOptions,
  DenoServerHandle
} from "../../src/deno-server"

type DenoFetch = Parameters<DenoRuntime["serve"]>[1]

/** One request delivered to the adapter whose completion the test controls. */
export interface FakeRequest {
  readonly result: Response | Promise<Response>
  /** Settles the request's info.completed promise as a normal completion. */
  complete(): void
  /** Rejects the request's info.completed promise as Deno does for an aborted connection. */
  fail(error: unknown): void
}

/** Controllable stand-in for a Deno HTTP server that flags every unsafe stop ordering. */
export class FakeDenoServer implements DenoServerHandle {
  addr: unknown = { transport: "tcp", hostname: "127.0.0.1", port: 4321 }
  readonly finished: Promise<void>
  shutdownCalls = 0
  abortEvents = 0
  unsafeAborts = 0
  hangOnShutdown = false
  shutdownFailure: unknown = null
  shutdownRejection: unknown = null
  readonly #finished = Promise.withResolvers<void>()
  #done = false

  constructor() {
    this.finished = this.#finished.promise
  }

  /** Attaches the serve signal the way Deno does: abort forces the server to finish. */
  listen(signal: AbortSignal): void {
    signal.addEventListener(
      "abort",
      () => {
        this.abortEvents += 1
        if (this.shutdownCalls > 0 || this.#done) this.unsafeAborts += 1
        else this.finish()
      },
      { once: true }
    )
  }

  /** Settles server.finished successfully, as Deno does once the server has stopped. */
  finish(): void {
    this.#done = true
    this.#finished.resolve()
  }

  /** Rejects server.finished, as Deno does when the server dies abnormally. */
  crash(error: unknown): void {
    this.#done = true
    this.#finished.reject(error)
  }

  /** Mirrors Deno: the shutdown promise settles first, then server.finished resolves. */
  shutdown(): Promise<void> {
    if (this.shutdownFailure !== null) throw this.shutdownFailure
    this.shutdownCalls += 1
    if (this.hangOnShutdown) return new Promise<void>(() => undefined)
    queueMicrotask(() => {
      this.finish()
    })
    if (this.shutdownRejection !== null) return Promise.reject(this.shutdownRejection)
    return Promise.resolve()
  }
}

/** Controllable stand-in for the Deno global that records every serve call. */
export class FakeDeno implements DenoRuntime {
  readonly server = new FakeDenoServer()
  readonly serveCalls: DenoServeOptions[] = []
  serveFailure: unknown = null
  #fetch: DenoFetch | null = null

  serve(options: DenoServeOptions, fetch: DenoFetch): DenoServerHandle {
    this.serveCalls.push(options)
    if (this.serveFailure !== null) throw this.serveFailure
    this.#fetch = fetch
    this.server.listen(options.signal)
    return this.server
  }

  /** Delivers one request to the adapter with a test-controlled info.completed. */
  request(url = "http://localhost/"): FakeRequest {
    const fetch = this.#fetch
    if (fetch === null) throw new Error("Deno.serve was not called")
    const completed = Promise.withResolvers<void>()
    const info: DenoServeInfo = { completed: completed.promise }
    return {
      result: fetch(new Request(url), info),
      complete: () => {
        completed.resolve()
      },
      fail: (error) => {
        completed.reject(error)
      }
    }
  }
}
