import {
  afterFunc,
  background,
  canceled,
  cause,
  withCancel,
  withCancelCause,
  withTimeout as withContextTimeout,
  withValue,
  type Context
} from "@go-like/context"

import { secure, timeout, tlsConfig, withConnClose, withTimeout } from "./options"
import { fromServerContext } from "./transport-info"
import type { Client, Listener, Option, Transport, TransportHandler } from "./types"

/** Creates a fresh structural Transport for one isolated conformance case. */
export type TransportFactory = () => Transport | Promise<Transport>

/** Injects one real provider-owned listener failure without exposing provider internals. */
export interface TransportConformanceFaultHarness {
  /** Makes listener terminate unexpectedly with cause while ctx remains active. */
  failListener(ctx: Context, listener: Listener, cause: Error): void | Promise<void>
}

/** Configures the provider-neutral Transport conformance suite. */
export interface TransportConformanceOptions {
  readonly listenAddress: string
  readonly faultHarness: TransportConformanceFaultHarness | null
  readonly operationTimeoutMs?: number
  /** Requires dial-before-listen to fail with TransportStateError. Default true. */
  readonly dialBeforeListen?: boolean
  /** Requires the handler to observe the caller's Request object. Default true. */
  readonly preservesRequestIdentity?: boolean
  /** Requires secure and TLS admission to fail as unsupported. Default true. */
  readonly unsupportedSecurity?: boolean
  /** Requires connectionClose to reject the next fetch. Default true. */
  readonly connectionCloseEndsClient?: boolean
  /** Requires a thrown handler to reject fetch instead of returning a Response. Default true. */
  readonly handlerFailuresReject?: boolean
  /** Substring addr() must contain. An empty string skips that check. Default "memory:". */
  readonly boundAddressIncludes?: string
  /** Requires an unread or partly read body to keep the handler Context alive until cancel. Default true. */
  readonly observeOpenBody?: boolean
  /** Requires request abort to preserve the caller's Error identity. Default true. */
  readonly preservesClientAbortCause?: boolean
  /** Requires serve cancellation to fail an in-flight fetch with TransportClosedError. Default true. */
  readonly serveCancelRejectsFetch?: boolean
}

/** Describes one runner-neutral Transport conformance case. */
export interface TransportConformanceCase {
  readonly name: string
  /** Executes the case and rejects when the public contract is violated. */
  run(): Promise<void>
}

interface SnapshotConformanceOptions {
  readonly listenAddress: string
  readonly faultHarness: TransportConformanceFaultHarness | null
  readonly operationTimeoutMs: number
  readonly dialBeforeListen: boolean
  readonly preservesRequestIdentity: boolean
  readonly unsupportedSecurity: boolean
  readonly connectionCloseEndsClient: boolean
  readonly handlerFailuresReject: boolean
  readonly boundAddressIncludes: string
  readonly observeOpenBody: boolean
  readonly preservesClientAbortCause: boolean
  readonly serveCancelRejectsFetch: boolean
}

/** Started serve promise kept beside its readiness barrier. */
interface OpenServe {
  readonly serving: Promise<void>
}

interface Settled {
  readonly ok: boolean
  readonly value: unknown
}

const DefaultConformanceTimeoutMs = 2_000
const DerivedDeadlineMs = 60_000

/** Fails one transport conformance assertion with a stable diagnostic. */
function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

/** Captures fulfillment or rejection without leaving an unhandled Promise. */
async function settled(operation: Promise<unknown>): Promise<Settled> {
  try {
    return { ok: true, value: await operation }
  } catch (value) {
    return { ok: false, value }
  }
}

/** Returns one inert Response for conformance handlers. */
function staticOk(): Response {
  return new Response("ok")
}

/** Builds one POST request against a memory URL or a host:port authority. */
function request(address: string, path = "/orders.v1/get", signal?: AbortSignal): Request {
  const init: RequestInit = { method: "POST", body: "{}" }
  if (signal !== undefined) init.signal = signal
  const base = address.includes("://") ? address : `http://${address}`
  return new Request(new URL(path, base), init)
}

/** Reads one optional boolean conformance flag. */
function requiredBoolean(value: boolean | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    throw new TypeError(`transport conformance ${name} must be a boolean`)
  }
  return value
}

/** Reads one optional string conformance flag. An empty string is meaningful. */
function requiredString(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== "string") {
    throw new TypeError(`transport conformance ${name} must be a string`)
  }
  return value
}

/** Waits until queued Promise work can no longer hide an already settled operation. */
async function taskBoundary(): Promise<void> {
  await new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, 0)
  })
}

/** Returns whether a terminal operation remains pending after queued Promise work settles. */
async function remainsPending(operation: Promise<unknown>): Promise<boolean> {
  let done = false
  /** Records either terminal outcome through one shared callable. */
  function markSettled(): void {
    done = true
  }
  void Promise.resolve(operation).then(markSettled, markSettled)
  await Promise.resolve()
  await Promise.resolve()
  return !done
}

/** Cancels an operation only when it is still pending; a completed resource keeps its identity. */
async function cancelIfPending<T>(
  operation: (ctx: Context) => Promise<T>,
  label: string
): Promise<Settled> {
  const [ctx, cancel] = withCancel(background())
  const running = settled(operation(ctx))
  await taskBoundary()
  if (await remainsPending(running)) {
    cancel()
    const canceledResult = await running
    check(
      canceledResult.ok === false && canceledResult.value === canceled,
      `${label} must preserve canceled`
    )
    return canceledResult
  }
  const completed = await running
  cancel()
  return completed
}

/** Waits for listeners that publish accepted() and returns immediately otherwise. */
async function whenReady(listener: Listener): Promise<void> {
  const accepted: unknown = Reflect.get(listener, "accepted")
  if (typeof accepted !== "function") return
  await Reflect.apply(accepted, listener, [])
}

/** Starts one serve call and waits until the listener can admit a request. */
async function openServe(
  listener: Listener,
  ctx: Context,
  handler: TransportHandler
): Promise<OpenServe> {
  const serving = listener.serve(ctx, handler)
  await whenReady(listener)
  return Object.freeze({ serving })
}

/** Resolves once ctx becomes terminal. */
async function untilCanceled(ctx: Context): Promise<void> {
  if (ctx.err() !== null) return
  await new Promise<void>(function wait(resolve): void {
    afterFunc(ctx, function done(): void {
      resolve()
    })
  })
}

/** Returns the Error name when value is an Error. */
function errorName(value: unknown): string {
  return value instanceof Error ? value.name : ""
}

/** Validates and freezes the complete conformance configuration. */
function snapshotConformanceOptions(
  options: TransportConformanceOptions
): SnapshotConformanceOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("transport conformance options must be an object")
  }
  if (typeof options.listenAddress !== "string" || options.listenAddress.length === 0) {
    throw new TypeError("transport conformance listenAddress must be a non-empty string")
  }
  if (!("faultHarness" in options)) {
    throw new TypeError("transport conformance faultHarness must be an object or null")
  }
  const faultHarness = options.faultHarness
  if (faultHarness !== null) {
    if (typeof faultHarness !== "object") {
      throw new TypeError("transport conformance faultHarness must be an object or null")
    }
    if (typeof faultHarness.failListener !== "function") {
      throw new TypeError("transport conformance faultHarness.failListener must be a function")
    }
  }
  const operationTimeoutMs = options.operationTimeoutMs ?? DefaultConformanceTimeoutMs
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new RangeError("transport conformance operationTimeoutMs must be a positive safe integer")
  }
  return Object.freeze({
    listenAddress: options.listenAddress,
    faultHarness,
    operationTimeoutMs,
    dialBeforeListen: requiredBoolean(options.dialBeforeListen, "dialBeforeListen", true),
    preservesRequestIdentity: requiredBoolean(
      options.preservesRequestIdentity,
      "preservesRequestIdentity",
      true
    ),
    unsupportedSecurity: requiredBoolean(options.unsupportedSecurity, "unsupportedSecurity", true),
    connectionCloseEndsClient: requiredBoolean(
      options.connectionCloseEndsClient,
      "connectionCloseEndsClient",
      true
    ),
    handlerFailuresReject: requiredBoolean(
      options.handlerFailuresReject,
      "handlerFailuresReject",
      true
    ),
    boundAddressIncludes: requiredString(
      options.boundAddressIncludes,
      "boundAddressIncludes",
      "memory:"
    ),
    observeOpenBody: requiredBoolean(options.observeOpenBody, "observeOpenBody", true),
    preservesClientAbortCause: requiredBoolean(
      options.preservesClientAbortCause,
      "preservesClientAbortCause",
      true
    ),
    serveCancelRejectsFetch: requiredBoolean(
      options.serveCancelRejectsFetch,
      "serveCancelRejectsFetch",
      true
    )
  })
}

/** Serves one handler and closes both sides after scenario. */
async function withExchange(
  transport: Transport,
  address: string,
  handler: TransportHandler,
  scenario: (client: Client, listener: Listener, serving: Promise<void>) => Promise<void>
): Promise<void> {
  const listener = await transport.listen(background(), address)
  const opened = await openServe(listener, background(), handler)
  const serving = opened.serving
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  try {
    await scenario(client, listener, serving)
  } finally {
    await settled(client.close(background()))
    await settled(listener.close(background()))
    await settled(serving)
  }
}

/** Checks option order, defaults, and the absence of a codec field. */
async function appliesOptions(factory: TransportFactory): Promise<void> {
  const transport = await Promise.resolve(factory())
  check(transport.string().length > 0, "transport string() must be non-empty")
  check(
    transport.kind?.() === "memory" || transport.string().length > 0,
    "transport kind is optional"
  )
  const defaults = transport.options()
  check(defaults.logger === null, "default logger must be null")
  check(defaults.timeoutMs === 0, "default timeout must be zero")
  check(defaults.secure === false, "default secure must be false")
  check(defaults.tlsConfig === null, "default tlsConfig must be null")
  check(!("codec" in defaults), "codec is not a transport option")
  transport.init(timeout(5), timeout(9))
  const snapshot = transport.options()
  transport.init(timeout(11))
  check(snapshot.timeoutMs === 9, "option snapshots must be immutable")
  check(transport.options().timeoutMs === 11, "later init must replace timeout")
  let invalid = false
  try {
    transport.init(1 as never)
  } catch (error) {
    invalid = error instanceof TypeError
  }
  check(invalid, "init must reject a non-function option")
}

/** Checks that init does not change a client created earlier. */
async function preservesExistingResources(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  check(options.operationTimeoutMs > 0, "conformance operation timeout must be positive")
  transport.init(timeout(0))
  await withExchange(
    transport,
    options.listenAddress,
    async function slow(_ctx, _request): Promise<Response> {
      await new Promise<void>(function wait(resolve): void {
        setTimeout(resolve, 40)
      })
      return new Response("slow")
    },
    async function scenario(client, listener): Promise<void> {
      transport.init(timeout(1))
      const response = await client.fetch(background(), request(listener.addr()))
      check(response.status === 200, "existing client must keep the timeout captured at dial")
      await response.arrayBuffer()
    }
  )
}

/** Checks pre-canceled dial and listen admission. */
async function rejectsCanceledCreation(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const [ctx, cancel] = withCancel(background())
  cancel()
  const dialed = await settled(transport.dial(ctx, options.listenAddress))
  const listened = await settled(transport.listen(ctx, options.listenAddress))
  check(
    dialed.ok === false && dialed.value === canceled,
    "pre-canceled dial must preserve canceled"
  )
  check(
    listened.ok === false && listened.value === canceled,
    "pre-canceled listen must preserve canceled"
  )
}

/** Checks address publication, one-shot serve, and optional dial-before-listen. */
async function servesOnce(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  if (options.dialBeforeListen) {
    const missing = await settled(transport.dial(background(), options.listenAddress))
    check(
      missing.ok === false && errorName(missing.value) === "TransportStateError",
      "dial before listen must fail"
    )
  }
  const listener = await transport.listen(background(), options.listenAddress)
  let client: Client | null = null
  let serving: Promise<void> | null = null
  try {
    check(listener.addr().length > 0, "listener address must be non-empty")
    if (options.boundAddressIncludes.length > 0) {
      check(
        listener.addr().includes(options.boundAddressIncludes),
        "listener must publish its bound address"
      )
    }
    const opened = await openServe(listener, background(), staticOk)
    serving = opened.serving
    client = await transport.dial(background(), listener.addr(), withTimeout(0))
    const response = await client.fetch(background(), request(listener.addr()))
    check(response.status === 200, "the admitted serve handler must run")
    await response.arrayBuffer()
    const second = await settled(listener.serve(background(), staticOk))
    check(
      second.ok === false && errorName(second.value) === "TransportStateError",
      "serve is one-shot"
    )
  } finally {
    if (client !== null) await settled(client.close(background()))
    await settled(listener.close(background()))
    if (serving !== null) await settled(serving)
  }
}

/** Checks serve cancellation and that a pre-canceled serve does not consume the one-shot. */
async function cancelsServe(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const listener = await transport.listen(background(), options.listenAddress)
  const [preCanceled, cancelPre] = withCancel(background())
  cancelPre()
  const rejected = await settled(listener.serve(preCanceled, staticOk))
  check(
    rejected.ok === false && rejected.value === canceled,
    "pre-canceled serve must not be consumed"
  )
  const reason = new Error("serve-stopped")
  const [serveCtx, cancelServe] = withCancelCause(background())
  let entered: (() => void) | undefined
  const ready = new Promise<void>(function capture(resolve): void {
    entered = resolve
  })
  const opened = await openServe(
    listener,
    serveCtx,
    async function handler(ctx): Promise<Response> {
      entered?.()
      await untilCanceled(ctx)
      return new Response("done")
    }
  )
  const serving = opened.serving
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  const pending = settled(client.fetch(background(), request(listener.addr())))
  await ready
  cancelServe(reason)
  const served = await settled(serving)
  const fetched = await pending
  check(
    served.ok === false && served.value === reason,
    "serve cancellation must preserve its cause"
  )
  if (fetched.ok === true && fetched.value instanceof Response) {
    await fetched.value.arrayBuffer()
  }
  if (options.serveCancelRejectsFetch) {
    check(
      fetched.ok === false && errorName(fetched.value) === "TransportClosedError",
      "in-flight fetch must fail when serve stops"
    )
  }
  await settled(client.close(background()))
  await settled(listener.close(background()))
}

/** Checks that a handler Context stays alive until its Response body ends. */
async function derivesHandlerContext(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const key = Object.freeze({ name: "conformance" })
  const [serveCtx, cancelServe] = withContextTimeout(withValue(background(), key, "kept"), 30_000)
  const contexts = new Map<string, Context>()
  let releaseCancel: (() => void) | undefined
  const cancelGate = new Promise<void>(function captureCancel(resolve): void {
    releaseCancel = resolve
  })
  const listener = await transport.listen(background(), options.listenAddress)
  const opened = await openServe(listener, serveCtx, function handler(ctx, seen): Response {
    const path = new URL(seen.url).pathname
    contexts.set(path, ctx)
    check(ctx.err() === null, "handler Context must be active while the handler runs")
    check(seen instanceof Request, "handler must observe the Request")
    if (path === "/empty") return new Response(null, { status: 204 })
    if (path === "/cancel") {
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Stays open until the case releases the source. */
          async pull(controller): Promise<void> {
            await cancelGate
            try {
              controller.close()
            } catch {
              // Consumer cancellation already terminated the body.
            }
          }
        })
      )
    }
    if (path === "/error") {
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Fails the first read. */
          start(controller): void {
            controller.error(new Error("broke"))
          }
        })
      )
    }
    return new Response("ok", { status: 201 })
  })
  const serving = opened.serving
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  let hanging: Response | null = null
  try {
    const body = await client.fetch(background(), request(listener.addr(), "/body"))
    const bodyCtx = contexts.get("/body") ?? null
    check(body.status === 201, "handler status must pass through")
    check(bodyCtx !== null && bodyCtx !== serveCtx, "handler Context must be derived")
    check(bodyCtx !== null && bodyCtx.value(key) === "kept", "handler Context must inherit values")
    check(
      bodyCtx !== null && bodyCtx.deadline()[1] === true,
      "handler Context must inherit the serve deadline"
    )
    expectBytes(await body.arrayBuffer(), "ok")
    check(
      bodyCtx !== null && bodyCtx.err() === canceled,
      "Response body EOF must cancel the handler Context"
    )

    const empty = await client.fetch(background(), request(listener.addr(), "/empty"))
    const emptyCtx = contexts.get("/empty") ?? null
    check(empty.status === 204, "null body status must pass through")
    check(
      emptyCtx !== null && emptyCtx.err() === canceled,
      "a null Response body must cancel the handler Context at delivery"
    )

    if (options.observeOpenBody) {
      hanging = await client.fetch(background(), request(listener.addr(), "/cancel"))
      const cancelCtx = contexts.get("/cancel") ?? null
      check(
        cancelCtx !== null && cancelCtx.err() === null,
        "an open body must keep the handler Context active"
      )
      await hanging.body?.cancel(new Error("stop"))
      check(
        cancelCtx !== null && cancelCtx.err() === canceled,
        "Response body cancel must cancel the handler Context"
      )
    }

    const brokenResult = await settled(
      client.fetch(background(), request(listener.addr(), "/error"))
    )
    const errorCtx = contexts.get("/error") ?? null
    if (brokenResult.ok === true && brokenResult.value instanceof Response) {
      await settled(brokenResult.value.arrayBuffer())
    }
    check(
      errorCtx !== null && errorCtx.err() === canceled,
      "a Response body error must cancel the handler Context"
    )
  } finally {
    releaseCancel?.()
    await settled(hanging?.body?.cancel() ?? Promise.resolve())
    await settled(client.close(background()))
    await settled(listener.close(background()))
    await settled(serving)
    cancelServe()
  }
}

/** Checks that a buffered body has the expected UTF-8 text. */
function expectBytes(bytes: ArrayBuffer, text: string): void {
  check(new TextDecoder().decode(bytes) === text, "Response body bytes must pass through")
}

/** Names how a probed Response body terminates. */
type BodyEnd = "end" | "error" | "cancel"

/** Holds what one handler call lets a case observe about its Contexts. */
interface BodyProbe {
  readonly ctx: Context
  /** A far-future deadline derived from ctx, as a handler or caller would derive it. */
  readonly child: Context
  /** Cancels child so a failing case never leaves its timer armed. */
  readonly release: () => void
  /** Records whether ctx or child was canceled while the body was still being produced. */
  canceledWhileProducing: boolean
}

/** Derives the probed child Context from one handler Context. */
function newProbe(ctx: Context): BodyProbe {
  const [child, release] = withContextTimeout(ctx, DerivedDeadlineMs)
  return { ctx, child, release, canceledWhileProducing: false }
}

/** Streams a first chunk, then ends, errors, or closes once gate opens, noting Context state per pull. */
function probedBody(
  probe: BodyProbe,
  end: BodyEnd,
  gate: Promise<void>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let pulls = 0
  return new ReadableStream<Uint8Array>(
    {
      /** Notes a Context canceled before the body reached any terminal state. */
      async pull(controller): Promise<void> {
        pulls += 1
        const pull = pulls
        if (probe.ctx.err() !== null || probe.child.err() !== null) {
          probe.canceledWhileProducing = true
        }
        if (pull === 1) {
          controller.enqueue(encoder.encode("a"))
          return
        }
        await gate
        try {
          if (end === "error") controller.error(new Error("broke"))
          else if (end === "end" && pull === 2) controller.enqueue(encoder.encode("b"))
          else controller.close()
        } catch {
          // Consumer cancellation already terminated the body.
        }
      }
    },
    { highWaterMark: 0 }
  )
}

/** Reports whether ctx becomes terminal within timeoutMs. */
async function endsWithin(ctx: Context, timeoutMs: number): Promise<boolean> {
  const [bound, cancelBound] = withContextTimeout(background(), timeoutMs)
  try {
    await Promise.race([untilCanceled(ctx), untilCanceled(bound)])
  } finally {
    cancelBound()
  }
  return ctx.err() !== null
}

/** Returns the probe recorded for path, or fails the case when the handler never ran. */
function probeFor(probes: ReadonlyMap<string, BodyProbe>, path: string): BodyProbe {
  const probe = probes.get(path)
  if (probe === undefined) throw new Error(`the handler must run for ${path}`)
  return probe
}

/** Checks that the derived Context of one probe was canceled by its body's terminal state. */
async function expectReleased(
  probe: BodyProbe,
  options: SnapshotConformanceOptions,
  terminal: string
): Promise<void> {
  const released =
    (await endsWithin(probe.child, options.operationTimeoutMs)) && probe.child.err() === canceled
  check(released, `a derived Context must be canceled when the Response body ${terminal}`)
}

/** Checks that a Context derived from the handler Context follows the Response body's end. */
async function releasesDerivedContext(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const probes = new Map<string, BodyProbe>()
  let release: (() => void) | undefined
  const held = new Promise<void>(function captureRelease(resolve): void {
    release = resolve
  })
  await withExchange(
    transport,
    options.listenAddress,
    function handler(ctx, seen): Response {
      const path = new URL(seen.url).pathname
      const probe = newProbe(ctx)
      probes.set(path, probe)
      const end = path.slice(1) as BodyEnd
      return new Response(probedBody(probe, end, end === "cancel" ? held : Promise.resolve()))
    },
    async function scenario(client, listener): Promise<void> {
      try {
        const ended = await client.fetch(background(), request(listener.addr(), "/end"))
        expectBytes(await ended.arrayBuffer(), "ab")
        await expectReleased(probeFor(probes, "/end"), options, "ends")

        const errored = await settled(
          client.fetch(background(), request(listener.addr(), "/error"))
        )
        if (errored.ok === true && errored.value instanceof Response) {
          await settled(errored.value.arrayBuffer())
        }
        await expectReleased(probeFor(probes, "/error"), options, "errors")

        if (options.observeOpenBody) {
          const hanging = await client.fetch(background(), request(listener.addr(), "/cancel"))
          const reader = hanging.body?.getReader()
          await reader?.read()
          await reader?.cancel(new Error("stop"))
          await expectReleased(probeFor(probes, "/cancel"), options, "is canceled")
        }
      } finally {
        release?.()
        for (const probe of probes.values()) probe.release()
      }
    }
  )
}

/** Checks that the handler Context stays active until its Response body reaches a terminal state. */
async function keepsContextActive(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const probes = new Map<string, BodyProbe>()
  let openBody: (() => void) | undefined
  const gate = options.observeOpenBody
    ? new Promise<void>(function captureOpen(resolve): void {
        openBody = resolve
      })
    : Promise.resolve()
  await withExchange(
    transport,
    options.listenAddress,
    function handler(ctx, seen): Response {
      const probe = newProbe(ctx)
      probes.set(new URL(seen.url).pathname, probe)
      return new Response(probedBody(probe, "end", gate))
    },
    async function scenario(client, listener): Promise<void> {
      try {
        const response = await client.fetch(background(), request(listener.addr(), "/body"))
        const probe = probeFor(probes, "/body")
        if (options.observeOpenBody) {
          check(
            probe.ctx.err() === null && probe.child.err() === null,
            "the handler Context must stay active while the Response body is unread"
          )
          const reader = response.body?.getReader()
          let step = await reader?.read()
          check(
            probe.ctx.err() === null && probe.child.err() === null,
            "the handler Context must stay active while the Response body is partly read"
          )
          openBody?.()
          while (step !== undefined && !step.done) step = await reader?.read()
        } else {
          await response.arrayBuffer()
        }
        check(
          !probe.canceledWhileProducing,
          "the handler Context must stay active while the Response body is produced"
        )
      } finally {
        openBody?.()
        for (const probe of probes.values()) probe.release()
      }
    }
  )
}

/** Checks Request and Response identity. */
async function exchangesIdentity(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const seen: { request: Request | null } = { request: null }
  const produced = new Response("body", { status: 200, headers: { "x-memory": "1" } })
  await withExchange(
    transport,
    options.listenAddress,
    function handler(_ctx, incoming): Response {
      seen.request = incoming
      return produced
    },
    async function scenario(client, listener): Promise<void> {
      const original = request(listener.addr(), "/payment.v1/pay")
      const response = await client.fetch(background(), original)
      if (options.preservesRequestIdentity) {
        check(seen.request === original, "the handler must observe the caller's Request")
      }
      check(response.status === produced.status, "handler status must pass through")
      check(response.headers.get("x-memory") === "1", "handler headers must pass through")
      expectBytes(await response.arrayBuffer(), "body")
      const info = fromServerContext
      check(typeof info === "function", "server context reader stays available")
    }
  )
}

/** Checks that one handler failure does not fail another exchange. */
async function isolatesHandlerFailure(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  let releaseFailure: (() => void) | undefined
  const gate = new Promise<void>(function capture(resolve): void {
    releaseFailure = resolve
  })
  await withExchange(
    transport,
    options.listenAddress,
    async function handler(_ctx, incoming): Promise<Response> {
      if (new URL(incoming.url).pathname === "/fail") {
        await gate
        throw new Error("isolated")
      }
      return new Response("ok")
    },
    async function scenario(client, listener): Promise<void> {
      const good = client.fetch(background(), request(listener.addr(), "/ok"))
      const bad = settled(client.fetch(background(), request(listener.addr(), "/fail")))
      const goodResponse = await good
      check(goodResponse.status === 200, "a sibling handler failure must not fail this exchange")
      await goodResponse.arrayBuffer()
      releaseFailure?.()
      const failed = await bad
      if (options.handlerFailuresReject) {
        check(
          failed.ok === false && failed.value instanceof Error,
          "the failing handler must reject"
        )
      } else if (failed.ok === true && failed.value instanceof Response) {
        await failed.value.arrayBuffer()
      }
      const later = await client.fetch(background(), request(listener.addr(), "/later"))
      check(later.status === 200, "the listener must accept a later exchange")
      await later.arrayBuffer()
    }
  )
}

/** Checks operation timeout and connection close. */
async function timesOutAndCloses(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const listener = await transport.listen(background(), options.listenAddress)
  const opened = await openServe(
    listener,
    background(),
    async function handler(ctx, incoming): Promise<Response> {
      if (new URL(incoming.url).pathname === "/slow") await untilCanceled(ctx)
      return new Response("ok")
    }
  )
  const serving = opened.serving
  const client = await transport.dial(background(), listener.addr(), withTimeout(50))
  const timed = await settled(client.fetch(background(), request(listener.addr(), "/slow")))
  check(
    timed.ok === false && errorName(timed.value) === "DeadlineExceeded",
    "fetch must surface the dial timeout"
  )
  await settled(client.close(background()))
  if (options.connectionCloseEndsClient) {
    const closing = await transport.dial(
      background(),
      listener.addr(),
      withTimeout(0),
      withConnClose()
    )
    const first = await closing.fetch(background(), request(listener.addr(), "/once"))
    check(first.status === 200, "connectionClose still returns the first Response")
    await first.arrayBuffer()
    const second = await settled(closing.fetch(background(), request(listener.addr(), "/twice")))
    check(
      second.ok === false && errorName(second.value) === "TransportClosedError",
      "connectionClose must reject the next fetch"
    )
    await settled(closing.close(background()))
  }
  const [closeCtx, cancelClose] = withCancel(background())
  cancelClose()
  const listenerClose = await settled(listener.close(closeCtx))
  check(
    listenerClose.ok === false && listenerClose.value === canceled,
    "pre-canceled close must not close the listener"
  )
  await settled(listener.close(background()))
  await settled(serving)
}

/** Checks unsupported secure and TLS admission without failing init. */
async function rejectsUnsupported(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const secured = await Promise.resolve(factory())
  secured.init(secure(true))
  check(secured.options().secure === true, "init(secure) must be observable before admission")
  const listened = await settled(secured.listen(background(), options.listenAddress))
  check(
    listened.ok === false && errorName(listened.value) === "UnsupportedTransportCapabilityError",
    "secure memory listeners are unsupported"
  )
  const tls = await Promise.resolve(factory())
  tls.init(
    tlsConfig({
      serverName: "memory.internal",
      caCertificate: null,
      certificateChain: null,
      privateKey: null
    })
  )
  const dialed = await settled(tls.dial(background(), options.listenAddress))
  check(
    dialed.ok === false && errorName(dialed.value) === "UnsupportedTransportCapabilityError",
    "TLS memory dials are unsupported"
  )
}

/** Checks client close ownership and request abortion. */
async function cancelsWithClient(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const reason = new Error("client-abort")
  const observed: { ctx: Context | null } = { ctx: null }
  let entered: (() => void) | undefined
  const ready = new Promise<void>(function capture(resolve): void {
    entered = resolve
  })
  const listener = await transport.listen(background(), options.listenAddress)
  const opened = await openServe(
    listener,
    background(),
    async function handler(ctx, incoming): Promise<Response> {
      if (new URL(incoming.url).pathname !== "/abort") return new Response("ok")
      observed.ctx = ctx
      entered?.()
      await untilCanceled(ctx)
      return new Response("aborted")
    }
  )
  const serving = opened.serving
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  const controller = new AbortController()
  const pending = settled(
    client.fetch(background(), request(listener.addr(), "/abort", controller.signal))
  )
  await ready
  controller.abort(reason)
  const aborted = await pending
  const handlerCtx = observed.ctx
  check(aborted.ok === false && aborted.value === reason, "request abort must reject fetch")
  check(handlerCtx !== null, "request abort must reach the handler")
  if (handlerCtx !== null) await untilCanceled(handlerCtx)
  check(
    handlerCtx !== null && handlerCtx.err() === canceled,
    "request abort must cancel the handler Context"
  )
  if (options.preservesClientAbortCause) {
    check(
      handlerCtx !== null && cause(handlerCtx) === reason,
      "request abort must preserve the caller cause"
    )
  }
  await settled(client.close(background()))
  const replacement = await transport.dial(background(), listener.addr(), withTimeout(0))
  const healthy = await replacement.fetch(background(), request(listener.addr(), "/health"))
  check(healthy.status === 200, "closing a client must not close the listener")
  await healthy.arrayBuffer()
  await settled(replacement.close(background()))
  await settled(listener.close(background()))
  await settled(serving)
}

/** Checks public defaults and rejection of a structurally negative timeout. */
async function validatesOptions(factory: TransportFactory): Promise<void> {
  const transport = await Promise.resolve(factory())
  const defaults = transport.options()
  check(defaults.logger === null, "default logger must be null")
  check(defaults.timeoutMs === 0, "default timeout must be zero")
  check(defaults.secure === false, "default secure must be false")
  check(defaults.tlsConfig === null, "default tlsConfig must be null")
  check(!("codec" in defaults), "codec is not a transport option")
  const malformed: Option = function malformed(current) {
    return Object.freeze({
      logger: current.logger,
      timeoutMs: -1,
      secure: current.secure,
      tlsConfig: current.tlsConfig
    })
  }
  let invalid = false
  try {
    transport.init(malformed)
  } catch (error) {
    invalid = error instanceof RangeError
  }
  check(invalid, "init must reject a negative timeout")
}

/** Checks that canceling an in-flight dial or listen preserves identity and later admission. */
async function cancelsStartedCreation(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const probedListener = await cancelIfPending(
    (ctx) => transport.listen(ctx, options.listenAddress),
    "started Transport.listen"
  )
  if (probedListener.ok === true && isListener(probedListener.value)) {
    await probedListener.value.close(background())
  }
  const listener = await transport.listen(background(), options.listenAddress)
  const opened = await openServe(listener, background(), () => new Response("ok"))
  const serving = opened.serving
  try {
    const probedClient = await cancelIfPending(
      (ctx) => transport.dial(ctx, listener.addr()),
      "started Transport.dial"
    )
    if (probedClient.ok === true && isClient(probedClient.value)) {
      await probedClient.value.close(background())
    }
    const client = await transport.dial(background(), listener.addr(), withTimeout(0))
    const response = await client.fetch(background(), request(listener.addr()))
    check(response.status === 200, "a later dial must still be admitted")
    await response.arrayBuffer()
    await client.close(background())
  } finally {
    await settled(listener.close(background()))
    await settled(serving)
  }
}

/** Checks that close admission is caller-scoped and an in-flight handler keeps cleanup pending. */
async function scopesClose(
  factory: TransportFactory,
  options: SnapshotConformanceOptions
): Promise<void> {
  const transport = await Promise.resolve(factory())
  let release: (() => void) | undefined
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  let entered: (() => void) | undefined
  const ready = new Promise<void>(function captureReady(resolve): void {
    entered = resolve
  })
  const listener = await transport.listen(background(), options.listenAddress)
  const opened = await openServe(listener, background(), async function handler(_ctx, incoming) {
    if (new URL(incoming.url).pathname === "/hold") {
      entered?.()
      await gate
      return new Response("held")
    }
    return new Response("ok")
  })
  const serving = opened.serving
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  let held: Promise<Settled> | null = null
  try {
    const [preCanceled, cancelPre] = withCancel(background())
    cancelPre()
    const clientClose = await settled(client.close(preCanceled))
    check(
      clientClose.ok === false && clientClose.value === canceled,
      "pre-canceled client.close must preserve canceled"
    )
    const stillOpen = await client.fetch(background(), request(listener.addr(), "/ok"))
    check(stillOpen.status === 200, "pre-canceled client.close must not close the client")
    await stillOpen.arrayBuffer()
    const listenerPre = await settled(listener.close(preCanceled))
    check(
      listenerPre.ok === false && listenerPre.value === canceled,
      "pre-canceled listener.close must preserve canceled"
    )
    const stillServing = await client.fetch(background(), request(listener.addr(), "/ok"))
    check(stillServing.status === 200, "pre-canceled listener.close must not start cleanup")
    await stillServing.arrayBuffer()
    held = settled(client.fetch(background(), request(listener.addr(), "/hold")))
    await ready
    const [closeCtx, cancelClose] = withCancel(background())
    const closing = listener.close(closeCtx)
    check(
      await remainsPending(closing),
      "started listener.close must wait for the in-flight handler"
    )
    cancelClose()
    const waiter = await settled(closing)
    check(
      waiter.ok === false && waiter.value === canceled,
      "canceling a started close rejects only that caller"
    )
    release?.()
    await held
    await settled(client.close(background()))
    const joined = await settled(listener.close(background()))
    check(joined.ok === true, "a later listener.close must join cleanup")
    const served = await settled(serving)
    check(served.ok === true, "serve must settle after the in-flight handler returns")
  } finally {
    release?.()
    if (held !== null) await held
    await settled(client.close(background()))
    await settled(listener.close(background()))
    await settled(serving)
  }
}

/** Reports whether value is a public Listener. */
function isListener(value: unknown): value is Listener {
  return typeof value === "object" && value !== null && "close" in value && "serve" in value
}

/** Reports whether value is a public Client. */
function isClient(value: unknown): value is Client {
  return typeof value === "object" && value !== null && "fetch" in value && "close" in value
}

/** Checks an injected listener failure. */
async function preservesHostFailure(
  factory: TransportFactory,
  options: SnapshotConformanceOptions,
  faultHarness: TransportConformanceFaultHarness
): Promise<void> {
  const transport = await Promise.resolve(factory())
  const listener = await transport.listen(background(), options.listenAddress)
  const serving = listener.serve(background(), staticOk)
  const reason = new Error("host-down")
  await faultHarness.failListener(background(), listener, reason)
  const served = await settled(serving)
  check(served.ok === false && served.value === reason, "listener failure must preserve its cause")
  await settled(listener.close(background()))
}

/** Builds isolated, runner-neutral black-box cases for the public Transport contract. */
export function transportConformanceCases(
  factory: TransportFactory,
  options: TransportConformanceOptions
): readonly TransportConformanceCase[] {
  const snapshot = snapshotConformanceOptions(options)
  const cases: TransportConformanceCase[] = [
    Object.freeze({
      name: "transport applies options in order and returns defensive snapshots",
      /** Runs immutable option ordering and readback assertions. */
      run: async () => appliesOptions(factory)
    }),
    Object.freeze({
      name: "transport exposes defaults and rejects invalid public options",
      /** Runs default readback and malformed reducer assertions. */
      run: async () => validatesOptions(factory)
    }),
    Object.freeze({
      name: "transport init preserves resources created from an earlier option snapshot",
      /** Runs configuration-only init assertions against an existing round trip. */
      run: async () => preservesExistingResources(factory, snapshot)
    }),
    Object.freeze({
      name: "pre-canceled dial and listen stop before resource admission",
      /** Runs pre-canceled creation admission assertions. */
      run: async () => rejectsCanceledCreation(factory, snapshot)
    }),
    Object.freeze({
      name: "started dial and listen cancellation preserves identity and later admission",
      /** Runs in-flight creation cancellation and a later successful admission. */
      run: async () => cancelsStartedCreation(factory, snapshot)
    }),
    Object.freeze({
      name: "listener exposes its bound address and serve is one-shot",
      /** Runs listener address, dial-before-listen, and one-shot assertions. */
      run: async () => servesOnce(factory, snapshot)
    }),
    Object.freeze({
      name: "serve cancellation preserves the Context terminal error",
      /** Runs serve cancellation and pre-canceled one-shot assertions. */
      run: async () => cancelsServe(factory, snapshot)
    }),
    Object.freeze({
      name: "handler Context stays alive until the Response body ends",
      /** Runs handler Context lifetime assertions for EOF, cancel, and error. */
      run: async () => derivesHandlerContext(factory, snapshot)
    }),
    Object.freeze({
      name: "a Context derived from the handler Context is canceled when the Response body ends",
      /** Runs derived Context release assertions for EOF, error, and cancel. */
      run: async () => releasesDerivedContext(factory, snapshot)
    }),
    Object.freeze({
      name: "the handler Context stays active while the Response body is unread or partly read",
      /** Runs handler Context liveness assertions before any terminal body state. */
      run: async () => keepsContextActive(factory, snapshot)
    }),
    Object.freeze({
      name: "client and listener exchange the same Request and Response",
      /** Runs Fetch identity assertions. */
      run: async () => exchangesIdentity(factory, snapshot)
    }),
    Object.freeze({
      name: "concurrent handlers isolate one handler failure",
      /** Runs concurrent dispatch and failure-isolation assertions. */
      run: async () => isolatesHandlerFailure(factory, snapshot)
    }),
    Object.freeze({
      name: "fetch honors dial timeout and connection close",
      /** Runs timeout and connection-close assertions. */
      run: async () => timesOutAndCloses(factory, snapshot)
    }),
    Object.freeze({
      name: "pre-canceled and started close is caller-scoped",
      /** Runs caller-scoped client and listener close assertions. */
      run: async () => scopesClose(factory, snapshot)
    }),
    Object.freeze({
      name: "client abort cancels the handler Context without closing the listener",
      /** Runs abort mapping and client-close ownership assertions. */
      run: async () => cancelsWithClient(factory, snapshot)
    })
  ]
  if (snapshot.unsupportedSecurity) {
    cases.push(
      Object.freeze({
        name: "secure and TLS options are rejected at admission",
        /** Runs unsupported-capability assertions. */
        run: async () => rejectsUnsupported(factory, snapshot)
      })
    )
  }
  const faultHarness = snapshot.faultHarness
  if (faultHarness !== null) {
    cases.push(
      Object.freeze({
        name: "unexpected listener failure preserves its original cause",
        /** Runs optional real provider failure-injection assertions. */
        run: async () => preservesHostFailure(factory, snapshot, faultHarness)
      })
    )
  }
  return Object.freeze(cases)
}
