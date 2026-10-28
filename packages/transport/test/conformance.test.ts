import { expect, test } from "bun:test"

import { afterFunc, canceled, cause, withCancelCause, type Context } from "@go-like/context"
import type { Client, Listener, Transport, TransportHandler } from "../src/index"
import { transportConformanceCases, type TransportConformanceFaultHarness } from "../src/testing"
import { newMemoryTransport } from "@go-like/transport-memory"
import { failMemoryListener } from "../memory/src/testing"

const faultHarness: TransportConformanceFaultHarness = Object.freeze({
  /** Injects one real listener terminal without reaching into its state machine. */
  failListener(ctx: Context, listener: Listener, cause: Error): void {
    failMemoryListener(ctx, listener, cause)
  }
})

const cases = transportConformanceCases(newMemoryTransport, {
  listenAddress: "memory://conformance",
  faultHarness,
  operationTimeoutMs: 2_000
})

for (const entry of cases) {
  test(`conformance: ${entry.name}`, entry.run)
}

test("rejects malformed conformance configuration", () => {
  const factory = (): Transport => newMemoryTransport()
  expect(() => transportConformanceCases(factory, null as never)).toThrow(TypeError)
  expect(() =>
    transportConformanceCases(factory, {
      listenAddress: "",
      faultHarness: null
    })
  ).toThrow(TypeError)
  expect(() =>
    transportConformanceCases(factory, { listenAddress: "memory://x" } as never)
  ).toThrow(TypeError)
  expect(() =>
    transportConformanceCases(factory, {
      listenAddress: "memory://x",
      faultHarness: 1 as never
    })
  ).toThrow(TypeError)
  expect(() =>
    transportConformanceCases(factory, {
      listenAddress: "memory://x",
      faultHarness: { failListener: "no" } as never
    })
  ).toThrow(TypeError)
  expect(() =>
    transportConformanceCases(factory, {
      listenAddress: "memory://x",
      faultHarness: null,
      operationTimeoutMs: 0
    })
  ).toThrow(RangeError)
  expect(() =>
    transportConformanceCases(factory, {
      listenAddress: "memory://x",
      faultHarness: null,
      dialBeforeListen: "no" as never
    })
  ).toThrow(TypeError)
  expect(() =>
    transportConformanceCases(factory, {
      listenAddress: "memory://x",
      faultHarness: null,
      boundAddressIncludes: 1 as never
    })
  ).toThrow(TypeError)
  const omitted = transportConformanceCases(factory, {
    listenAddress: "memory://x",
    faultHarness: null
  })
  expect(omitted.some((entry) => entry.name.includes("listener failure"))).toBe(false)
})

test("reports a failed conformance assertion", async () => {
  const failed = transportConformanceCases(
    () => ({
      init(): void {},
      options() {
        return { logger: null, timeoutMs: 0, secure: false, tlsConfig: null }
      },
      dial(): Promise<never> {
        return Promise.reject(new Error("unused"))
      },
      listen(): Promise<never> {
        return Promise.reject(new Error("unused"))
      },
      string(): string {
        return ""
      }
    }),
    { listenAddress: "memory://unused", faultHarness: null }
  )
  await expect(failed[0]?.run()).rejects.toThrow("transport string() must be non-empty")
})

/** Opens one manually settled Promise. */
function openGate(): { readonly promise: Promise<void>; resolve(): void } {
  let settle = function noop(): void {}
  const promise = new Promise<void>(function capture(done): void {
    settle = done
  })
  return Object.freeze({
    promise,
    /** Settles the gate once callers are waiting on it. */
    resolve(): void {
      settle()
    }
  })
}

/** Builds a transport whose dial and listen stay pending until ctx ends. */
function newCoverageTransport(): Transport {
  let handler: TransportHandler | null = null
  let serveCtx: Context | null = null
  let resolveServe = function noop(): void {}
  let rejectServe = function noop(_error: Error): void {}
  let serveSettled = false
  let served = false
  const accepted = openGate()
  /** Settles serve at most once. */
  function finishServe(error: Error | null): void {
    if (serveSettled) return
    serveSettled = true
    if (error === null) resolveServe()
    else rejectServe(error)
  }
  return Object.freeze({
    /** Coverage transports do not carry options. */
    init(): void {},
    /** Returns the neutral option snapshot. */
    options() {
      return Object.freeze({ logger: null, timeoutMs: 0, secure: false, tlsConfig: null })
    },
    /** Stays pending while ctx can still be canceled. */
    dial(ctx: Context): Promise<Client> {
      if (ctx.done() !== null) {
        return new Promise<Client>(function pending(_resolve, reject): void {
          afterFunc(ctx, function canceledDial(): void {
            reject(ctx.err() ?? canceled)
          })
        })
      }
      return Promise.resolve(
        Object.freeze({
          /** Runs the installed handler and turns a throw into an HTTP-shaped 500. */
          async fetch(_ctx: Context, request: Request): Promise<Response> {
            const active = handler
            const owner = serveCtx
            if (active === null || owner === null)
              throw new Error("coverage listener is not serving")
            const [child] = withCancelCause(owner)
            try {
              const produced = await active(child, request)
              if (!(produced instanceof Response)) return new Response("no", { status: 500 })
              return produced
            } catch {
              return new Response("no", { status: 500 })
            }
          },
          /** Coverage clients have no owned exchanges. */
          close(): Promise<void> {
            return Promise.resolve()
          }
        })
      )
    },
    /** Stays pending while ctx can still be canceled. */
    listen(ctx: Context): Promise<Listener> {
      if (ctx.done() !== null) {
        return new Promise<Listener>(function pending(_resolve, reject): void {
          afterFunc(ctx, function canceledListen(): void {
            reject(ctx.err() ?? canceled)
          })
        })
      }
      const listener: Listener & { accepted(): Promise<void> } = Object.freeze({
        /** Returns the host:port form used to cover request URL joining. */
        addr(): string {
          return "127.0.0.1:9"
        },
        /** Resolves once serve has installed the handler. */
        accepted(): Promise<void> {
          return accepted.promise
        },
        /** Admits one handler and rejects serve with the Context cause. */
        serve(nextCtx: Context, next: TransportHandler): Promise<void> {
          const failure = cause(nextCtx) ?? nextCtx.err()
          if (failure !== null) return Promise.reject(failure)
          if (served) return Promise.reject(new Error("serve is one-shot"))
          served = true
          handler = next
          serveCtx = nextCtx
          const promise = new Promise<void>(function capture(resolve, reject): void {
            resolveServe = resolve
            rejectServe = reject
          })
          if (nextCtx.done() !== null) {
            afterFunc(nextCtx, function serveEnded(): void {
              finishServe(cause(nextCtx) ?? nextCtx.err() ?? canceled)
            })
          }
          accepted.resolve()
          return promise
        },
        /** Joins serve without failing an in-flight response. */
        close(nextCtx: Context): Promise<void> {
          const failure = cause(nextCtx) ?? nextCtx.err()
          if (failure !== null) return Promise.reject(failure)
          finishServe(null)
          return Promise.resolve()
        }
      })
      return Promise.resolve(listener)
    },
    /** Returns the stable coverage name. */
    string(): string {
      return "coverage"
    }
  })
}

test("covers conformance branches that memory admission settles immediately", async () => {
  const cases = transportConformanceCases(newCoverageTransport, {
    listenAddress: "127.0.0.1:9",
    faultHarness: null,
    dialBeforeListen: false,
    preservesRequestIdentity: false,
    unsupportedSecurity: false,
    connectionCloseEndsClient: false,
    handlerFailuresReject: false,
    boundAddressIncludes: "",
    observeOpenBody: false,
    preservesClientAbortCause: false,
    serveCancelRejectsFetch: false
  })
  const names = [
    "started dial and listen cancellation preserves identity and later admission",
    "serve cancellation preserves the Context terminal error",
    "concurrent handlers isolate one handler failure"
  ]
  for (const name of names) {
    const entry = cases.find(function matches(item): boolean {
      return item.name === name
    })
    if (entry === undefined) throw new Error(`missing conformance case ${name}`)
    await entry.run()
  }
})
