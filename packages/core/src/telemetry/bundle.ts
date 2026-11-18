import { waitForContext, withoutCancel, type Context } from "../context/index"
import { toError } from "../internal/errors"
import type { LogHandler } from "../log/index"
import type { MeterProvider } from "../metric/index"
import { newTraceContextPropagator } from "../trace/w3c"
import type { Propagator, TracerProvider } from "../trace/index"

import { installHandlers } from "./internal/fanout"
import { isTelemetry, markTelemetry } from "./internal/resource"
import {
  createState,
  enterRoot,
  installState,
  stateFrom,
  writeState,
  type StateInput
} from "./internal/state"
import type {
  CompletionLogMode,
  Telemetry,
  TelemetryAlreadyStartedError,
  TelemetryLifecycle,
  TelemetryOptions
} from "./types"

interface Slot {
  readonly group: "log" | "signal"
  readonly lifecycle: TelemetryLifecycle
  stopPromise: Promise<void> | null
}

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: (value?: PromiseLike<void>) => void
  readonly reject: (reason?: unknown) => void
}

interface Bundle {
  readonly input: Omit<StateInput, "resource" | "span" | "operation">
  readonly slots: Slot[]
  phase: "idle" | "admitting" | "running" | "draining" | "stopped"
  readonly admission: Deferred
  readonly terminal: Deferred
  launched: Promise<void>[]
  drain: Promise<void> | null
  /** The context that bounds phase 1 of the owner drain. Later callers only wait. */
  drainCaller: Context | null
}

const bundles = new WeakMap<object, Bundle>()
const completionModes: readonly CompletionLogMode[] = ["all", "failures", "none"]

/** Validates providers before any I/O and returns a bundle. The default propagator is W3C. */
export function newTelemetry(options: TelemetryOptions = {}): Telemetry {
  const seen = new Set<object>()
  const tracer = readTracer(options.tracerProvider, seen)
  const meters = readMeters(options.meterProviders, seen)
  const handlers = readLogs(options.logHandlers, seen)
  const propagator = readPropagator(options.propagator, seen)
  const completionLogs = readCompletion(options.completionLogs)
  const ignoreRequest = readIgnore(options.ignoreRequest)
  const slots: Slot[] = []
  for (const handler of handlers) pushLifecycle(slots, handler.lifecycle, "log")
  if (tracer !== null) pushLifecycle(slots, tracer.lifecycle, "signal")
  for (const meter of meters) pushLifecycle(slots, meter.lifecycle, "signal")
  const bundle: Bundle = {
    input: {
      tracer,
      meters,
      handlers: installHandlers(handlers),
      propagator,
      completionLogs,
      ignoreRequest
    },
    slots,
    phase: "idle",
    admission: Promise.withResolvers<void>(),
    terminal: Promise.withResolvers<void>(),
    launched: [],
    drain: null,
    drainCaller: null
  }
  void bundle.admission.promise.catch(() => {})
  void bundle.terminal.promise.catch(() => {})
  const telemetry = Object.freeze({
    /** Admits every lifecycle, then stays pending until the first native terminal. */
    start(ctx: Context): Promise<void> {
      return startBundle(bundle, ctx)
    },
    /** Starts one owner drain. The caller context bounds only this wait. */
    stop(ctx: Context): Promise<void> {
      return stopBundle(bundle, ctx)
    }
  }) as Telemetry
  bundles.set(telemetry, bundle)
  markTelemetry(telemetry)
  return telemetry
}

/**
 * Carries `telemetry` on ctx for code that runs outside `newApp`.
 * The active span is kept. Bound log attributes and the resource are reset.
 */
export function withTelemetry(ctx: Context, telemetry: Telemetry): Context {
  const bundle = readBundle(telemetry)
  const previous = stateFrom(ctx)
  return writeState(
    ctx,
    createState({
      ...bundle.input,
      resource: Object.freeze({}),
      span: previous?.span ?? null,
      operation: previous?.operation ?? ""
    })
  )
}

/** Installs the bundle and the App resource. The App context carries no span. */
export function installTelemetry(
  ctx: Context,
  telemetry: Telemetry,
  resource: StateInput["resource"]
): Context {
  return installState(ctx, { ...readBundle(telemetry).input, resource, span: null, operation: "" })
}

/** Resolves when admission finishes and rejects with the admission error. */
export function whenTelemetryAdmitted(telemetry: Telemetry): Promise<void> {
  return readBundle(telemetry).admission.promise
}

/** Reads a bundle created by this core copy. */
function readBundle(telemetry: Telemetry): Bundle {
  const bundle = bundles.get(telemetry)
  if (bundle === undefined || !isTelemetry(telemetry)) {
    throw new TypeError("telemetry must be a Telemetry bundle")
  }
  return bundle
}

/** Admits providers in order, then returns the native-terminal promise. */
async function startBundle(bundle: Bundle, ctx: Context): Promise<void> {
  if (bundle.phase !== "idle") throw alreadyStarted()
  bundle.phase = "admitting"
  try {
    await admit(bundle, ctx)
  } catch (error) {
    const failure = toError(error, "telemetry start failed")
    if (bundle.phase === "admitting") bundle.phase = "stopped"
    bundle.admission.reject(failure)
    bundle.terminal.reject(failure)
    throw failure
  }
  if (bundle.phase !== "admitting") {
    const failure = alreadyStarted()
    bundle.admission.reject(failure)
    bundle.terminal.reject(failure)
    throw failure
  }
  bundle.phase = "running"
  bundle.admission.resolve()
  watchTerminals(bundle)
  return bundle.terminal.promise
}

/** Launches each lifecycle and checks the next microtask for an immediate rejection. */
async function admit(bundle: Bundle, ctx: Context): Promise<void> {
  const launched: Array<{ readonly slot: Slot; readonly promise: Promise<void> }> = []
  for (let index = 0; index < bundle.slots.length; index += 1) {
    const slot = bundle.slots[index]
    if (slot === undefined) continue
    if (bundle.phase !== "admitting") throw alreadyStarted()
    const promise = launch(ctx, slot, index)
    launched.push({ slot, promise })
    await Promise.resolve()
    const outcome = await probe(promise)
    if (outcome.state === "error") {
      const primary = toError(outcome.error, `telemetry[${index}] start`)
      const rollbackErrors = await rollback(ctx, launched.slice(0, -1))
      if (rollbackErrors.length === 0) throw primary
      throw new AggregateError([primary, ...rollbackErrors], "telemetry start failed")
    }
  }
  bundle.launched = launched.map((item) => item.promise)
}

/** Invokes `start` inside a root scope so implicit context does not leak between providers. */
function launch(ctx: Context, slot: Slot, index: number): Promise<void> {
  try {
    const started = enterRoot(ctx, () => Promise.resolve(slot.lifecycle.start(ctx)))
    void started.catch(() => {})
    return started
  } catch (error) {
    const rejected = Promise.reject(toError(error, `telemetry[${index}] start`))
    void rejected.catch(() => {})
    return rejected
  }
}

/** Stops already-admitted providers in reverse. The provider that failed is left to its owner. */
async function rollback(
  ctx: Context,
  launched: readonly { readonly slot: Slot; readonly promise: Promise<void> }[]
): Promise<Error[]> {
  const owner = withoutCancel(ctx)
  const errors: Error[] = []
  for (let index = launched.length - 1; index >= 0; index -= 1) {
    const item = launched[index]
    if (item === undefined) continue
    const failure = await stopSlot(item.slot, owner)
    if (failure !== null) errors.push(failure)
  }
  return errors
}

/** Resolves the public start promise from the native lifecycle promises. */
function watchTerminals(bundle: Bundle): void {
  if (bundle.launched.length === 0) {
    bundle.terminal.resolve()
    return
  }
  void Promise.all(bundle.launched).then(
    () => {
      // A drain moves the phase off "running" before the native terminal settles.
      // The app still joins this promise, so it has to settle in that case too.
      bundle.terminal.resolve()
    },
    (error: unknown) => {
      if (bundle.phase === "running") {
        bundle.terminal.reject(toError(error, "telemetry terminal"))
        return
      }
      bundle.terminal.resolve()
    }
  )
}

/**
 * Drains the bundle once.
 * Stop before start drains every lifecycle without admission and rejects a later start.
 */
function stopBundle(bundle: Bundle, ctx: Context): Promise<void> {
  if (bundle.drain === null) {
    if (bundle.phase === "idle" || bundle.phase === "admitting" || bundle.phase === "running") {
      bundle.phase = "draining"
    }
    bundle.drainCaller = ctx
    const owner = withoutCancel(ctx)
    bundle.drain = runDrain(bundle, owner, ctx).then(
      () => {
        bundle.phase = "stopped"
        rejectAdmissionIfPending(bundle)
      },
      (error: unknown) => {
        bundle.phase = "stopped"
        rejectAdmissionIfPending(bundle)
        throw toError(error, "telemetry stop failed")
      }
    )
  }
  const drain = bundle.drain
  return waitForContext(ctx, drain)
}

/** Phase 1 stops tracers and meters. Phase 2 stops log handlers, immediately if the caller expires. */
async function runDrain(bundle: Bundle, owner: Context, caller: Context): Promise<void> {
  const errors: Error[] = []
  const phase1 = bundle.slots.filter((slot) => slot.group === "signal")
  const phase2 = bundle.slots.filter((slot) => slot.group === "log")
  const first = Promise.all(phase1.map((slot) => stopSlot(slot, owner))).then(collectErrors)
  let expired = false
  try {
    errors.push(...(await waitForContext(caller, first)))
  } catch {
    expired = true
  }
  const second = await Promise.all(phase2.map((slot) => stopSlot(slot, owner)))
  errors.push(...second.filter((error): error is Error => error !== null))
  if (expired) {
    const late = await first
    errors.push(...late)
  }
  const failure =
    errors.length === 1
      ? errors[0]
      : errors.length > 1
        ? new AggregateError(errors, "telemetry stop failed")
        : null
  if (failure !== undefined && failure !== null) throw failure
}

/** Starts or joins the one owner stop for a slot. */
function stopSlot(slot: Slot, owner: Context): Promise<Error | null> {
  if (slot.stopPromise === null) {
    try {
      const stopped = Promise.resolve(slot.lifecycle.stop(owner))
      slot.stopPromise = stopped
      void stopped.catch(() => {})
    } catch (error) {
      const rejected = Promise.reject(toError(error, "telemetry stop"))
      slot.stopPromise = rejected
      void rejected.catch(() => {})
    }
  }
  return slot.stopPromise.then(
    () => null,
    (error: unknown) => toError(error, "telemetry stop")
  )
}

/** Rejects a start that never admitted so a later `start` is refused. */
function rejectAdmissionIfPending(bundle: Bundle): void {
  if (bundle.launched.length > 0) return
  bundle.admission.reject(alreadyStarted())
  bundle.terminal.reject(alreadyStarted())
}

/** Keeps the Error values returned by slot stops. */
function collectErrors(errors: readonly (Error | null)[]): Error[] {
  return errors.filter((error): error is Error => error !== null)
}

/**
 * Distinguishes a still-pending start from one that already settled.
 * The settlement reaction is queued before the probe microtask, so an already-rejected start is visible.
 */
function probe(
  promise: Promise<void>
): Promise<
  | { readonly state: "pending" }
  | { readonly state: "ok" }
  | { readonly state: "error"; readonly error: unknown }
> {
  return new Promise((resolve) => {
    let settled = false
    /** Resolves the probe once. */
    const finish = (
      outcome:
        | { readonly state: "pending" }
        | { readonly state: "ok" }
        | { readonly state: "error"; readonly error: unknown }
    ): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    promise.then(
      () => {
        finish({ state: "ok" })
      },
      (error: unknown) => {
        finish({ state: "error", error })
      }
    )
    queueMicrotask(() => {
      finish({ state: "pending" })
    })
  })
}

/** Builds the stable already-started error. The code also means the bundle is not startable. */
function alreadyStarted(): TelemetryAlreadyStartedError {
  const error = new Error("telemetry has already started") as TelemetryAlreadyStartedError
  Object.defineProperty(error, "name", { value: "TelemetryAlreadyStartedError" })
  Object.defineProperty(error, "code", { value: "GO_LIKE_TELEMETRY_ALREADY_STARTED" })
  return error
}

/** Reads the optional tracer and claims its identity. */
function readTracer(value: TracerProvider | undefined, seen: Set<object>): TracerProvider | null {
  if (value === undefined) return null
  const provider = readObject(value, "tracer provider")
  claim(provider, seen)
  requireFunction(provider, "startSpan", "tracer provider")
  requireLifecycle(provider, "tracer provider")
  return value
}

/** Reads the meter list. */
function readMeters(
  value: readonly MeterProvider[] | undefined,
  seen: Set<object>
): readonly MeterProvider[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError("meter providers must be an array")
  for (const meter of value) {
    const provider = readObject(meter, "meter provider")
    claim(provider, seen)
    requireFunction(provider, "instrument", "meter provider")
    requireLifecycle(provider, "meter provider")
  }
  return value
}

/** Reads the log-handler list. */
function readLogs(
  value: readonly LogHandler[] | undefined,
  seen: Set<object>
): readonly LogHandler[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError("log handlers must be an array")
  for (const handler of value) {
    const provider = readObject(handler, "log handler")
    claim(provider, seen)
    requireFunction(provider, "enabled", "log handler")
    requireFunction(provider, "handle", "log handler")
    requireLifecycle(provider, "log handler")
  }
  return value
}

/** `undefined` selects W3C. `null` disables propagation. */
function readPropagator(
  value: Propagator | null | undefined,
  seen: Set<object>
): Propagator | null {
  if (value === undefined) return newTraceContextPropagator()
  if (value === null) return null
  const propagator = readObject(value, "propagator")
  claim(propagator, seen)
  requireFunction(propagator, "inject", "propagator")
  requireFunction(propagator, "extract", "propagator")
  requireFunction(propagator, "fields", "propagator")
  return value
}

/** Validates the completion-log mode. */
function readCompletion(value: CompletionLogMode | undefined): CompletionLogMode {
  if (value === undefined) return "failures"
  if (!completionModes.includes(value)) throw new TypeError("completionLogs is invalid")
  return value
}

/** Validates the request filter. */
function readIgnore(
  value: TelemetryOptions["ignoreRequest"]
): ((request: Request) => boolean) | null {
  if (value === undefined) return null
  if (typeof value !== "function") throw new TypeError("ignoreRequest must be a function")
  return value
}

/** Rejects a second use of the same provider object. */
function claim(value: object, seen: Set<object>): void {
  if (seen.has(value)) throw new TypeError("telemetry provider is duplicated")
  seen.add(value)
}

/** Requires a non-null object. */
function readObject(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null) throw new TypeError(`${label} must be an object`)
  return value
}

/** Requires one function member. */
function requireFunction(value: object, method: string, label: string): void {
  if (typeof Reflect.get(value, method) !== "function") {
    throw new TypeError(`${label} is missing ${method}`)
  }
}

/** A lifecycle member must be absent or implement both methods. */
function requireLifecycle(value: object, label: string): void {
  const lifecycle: unknown = Reflect.get(value, "lifecycle")
  if (lifecycle === undefined) return
  if (typeof lifecycle !== "object" || lifecycle === null) {
    throw new TypeError(`${label} lifecycle is incomplete`)
  }
  if (
    typeof Reflect.get(lifecycle, "start") !== "function" ||
    typeof Reflect.get(lifecycle, "stop") !== "function"
  ) {
    throw new TypeError(`${label} lifecycle is incomplete`)
  }
}

/** Adds a lifecycle slot when the provider has one. */
function pushLifecycle(
  slots: Slot[],
  lifecycle: TelemetryLifecycle | undefined,
  group: Slot["group"]
): void {
  if (lifecycle === undefined) return
  slots.push({ group, lifecycle, stopPromise: null })
}
