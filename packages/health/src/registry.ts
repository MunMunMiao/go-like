import {
  afterFunc,
  canceled,
  cause,
  withTimeoutCause,
  type CancelFunc,
  type Context,
  type StopFunc
} from "@go-like/context"

export type ProbeKind = "live" | "ready"

/** Performs one liveness or readiness check under the supplied Context. */
export type Probe = (ctx: Context) => void | Promise<void>

export interface ProbeOptions {
  readonly timeoutMs?: number
}

export interface ProbeResult {
  readonly name: string
  readonly ok: boolean
  readonly error: Error | null
}

export interface ProbeReport {
  readonly kind: ProbeKind
  readonly ok: boolean
  readonly checks: readonly ProbeResult[]
}

export interface ProbeRegistry {
  /** Registers one named probe and returns an idempotent unregister function. */
  register(kind: ProbeKind, name: string, probe: Probe, options?: ProbeOptions): () => boolean

  /** Runs a stable registration snapshot concurrently and returns results in registration order. */
  check(ctx: Context, kind: ProbeKind): Promise<ProbeReport>
}

interface Registration {
  readonly kind: ProbeKind
  readonly name: string
  readonly probe: Probe
  readonly timeoutMs: number
  active: boolean
}

const defaultTimeoutMs = 1_000
const publicNamePattern = /^[A-Za-z0-9._-]+$/

/** Recognizes Error values across realms when the runtime provides Error.isError. */
function isError(value: unknown): value is Error {
  const errorConstructor: unknown = Error
  if (
    typeof errorConstructor === "function" &&
    "isError" in errorConstructor &&
    typeof errorConstructor.isError === "function"
  ) {
    return errorConstructor.isError(value)
  }
  return value instanceof Error
}

/** Rejects probe kinds outside the public liveness and readiness contract. */
function assertKind(kind: ProbeKind): void {
  if (kind !== "live" && kind !== "ready") throw new TypeError("kind must be live or ready")
}

/** Rejects names that could leak or destabilize the public health payload. */
function assertName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || !publicNamePattern.test(name)) {
    throw new TypeError("name must be a non-empty public identifier")
  }
}

/** Preserves Error identity and normalizes every other rejection at the probe boundary. */
function normalizeProbeError(name: string, value: unknown): Error {
  if (isError(value)) return value
  return Object.freeze(
    new Error(`probe "${name}" rejected with a non-Error value`, { cause: value })
  )
}

/** Normalizes the registered terminal cause of one canceled child Context. */
function cancellationError(name: string, ctx: Context): Error {
  return normalizeProbeError(name, cause(ctx))
}

/** Builds one immutable probe result. */
function freezeResult(name: string, ok: boolean, error: Error | null): ProbeResult {
  return Object.freeze({ name, ok, error })
}

/** Builds one immutable failed probe result. */
function failedResult(name: string, error: Error): ProbeResult {
  return freezeResult(name, false, error)
}

/** Observes a structural thenable exactly once without trusting a declared return type. */
function observeProbeValue(value: unknown): Promise<void> | null {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    !("then" in value)
  ) {
    return null
  }
  const then = value.then
  if (typeof then !== "function") return null
  return new Promise<void>((resolve, reject) => {
    try {
      then.call(value, resolve, reject)
    } catch (error) {
      reject(error)
    }
  })
}

/** Invokes one probe and converts synchronous boundary failures into values. */
function invokeProbe(
  name: string,
  invoke: () => void | Promise<void>
): Promise<void> | null | Error {
  try {
    return observeProbeValue(invoke())
  } catch (error) {
    return normalizeProbeError(name, error)
  }
}

/** Registers one child cancellation observer or returns its normalized boundary failure. */
function registerCancellation(
  name: string,
  child: Context,
  finishCancellation: () => void
): StopFunc | Error {
  try {
    return afterFunc(child, finishCancellation)
  } catch (error) {
    return normalizeProbeError(name, error)
  }
}

/** Runs one registration under its independent timeout and cancellation ancestry. */
function runProbe(parent: Context, registration: Registration): Promise<ProbeResult> {
  let child: Context
  let cancel: CancelFunc
  try {
    const timeoutCause = Object.freeze(new Error(`probe "${registration.name}" timed out`))
    const childPair = withTimeoutCause(parent, registration.timeoutMs, timeoutCause)
    child = childPair[0]
    cancel = childPair[1]
  } catch (error) {
    return Promise.resolve(
      failedResult(registration.name, normalizeProbeError(registration.name, error))
    )
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false

    /** Admits exactly one result and performs best-effort timeout cleanup. */
    const finish = (result: ProbeResult): void => {
      settled = true
      cancel()
      resolve(result)
    }

    /** Converts admitted child cancellation into this probe's failed result. */
    const finishCancellation = (): void => {
      let error: Error
      try {
        error = cancellationError(registration.name, child)
      } catch (inspectionError) {
        error = normalizeProbeError(registration.name, inspectionError)
      }
      finish(failedResult(registration.name, error))
    }

    const cancellationRegistration = registerCancellation(
      registration.name,
      child,
      finishCancellation
    )
    const operation = invokeProbe(registration.name, () => registration.probe(child))
    if (isError(cancellationRegistration)) {
      if (operation !== null && !isError(operation)) void operation.catch(() => {})
      finish(failedResult(registration.name, cancellationRegistration))
      return
    }
    const stopCancel = cancellationRegistration

    /** Publishes an operation result only when it wins cancellation cleanup. */
    const finishOperation = (result: ProbeResult): void => {
      if (settled) return
      const operationAdmitted = stopCancel()
      if (!operationAdmitted) return
      finish(result)
    }

    if (operation === null) {
      finishOperation(freezeResult(registration.name, true, null))
      return
    }
    if (isError(operation)) {
      finishOperation(failedResult(registration.name, operation))
      return
    }

    operation.then(
      () => {
        finishOperation(freezeResult(registration.name, true, null))
      },
      (error: unknown) => {
        finishOperation(
          failedResult(registration.name, normalizeProbeError(registration.name, error))
        )
      }
    )
  })
}

/** Builds an immutable aggregate report while failing empty readiness closed. */
function freezeReport(kind: ProbeKind, checks: readonly ProbeResult[]): ProbeReport {
  const frozenChecks = Object.freeze(checks.slice())
  const checksOk = frozenChecks.every((check) => check.ok)
  return Object.freeze({
    kind,
    ok: checksOk && (kind === "live" || frozenChecks.length > 0),
    checks: frozenChecks
  })
}

/** Creates an idempotent unregister handle without retaining the probe registration. */
function newUnregister(
  registrations: Registration[],
  activeNames: Set<string>,
  kind: ProbeKind,
  name: string
): () => boolean {
  let active = true
  return function unregister(): boolean {
    if (!active) return false
    active = false
    const index = registrations.findIndex((registration) => {
      return registration.kind === kind && registration.name === name
    })
    const registration = registrations[index]
    if (registration !== undefined) {
      registration.active = false
      registrations.splice(index, 1)
    }
    activeNames.delete(name)
    return true
  }
}

/** Creates an in-memory liveness and readiness probe registry. */
export function newProbeRegistry(): ProbeRegistry {
  const registrations: Registration[] = []
  const activeNames = {
    live: new Set<string>(),
    ready: new Set<string>()
  }

  return Object.freeze({
    /** Registers one active name within a probe kind. */
    register(kind: ProbeKind, name: string, probe: Probe, options?: ProbeOptions): () => boolean {
      assertKind(kind)
      assertName(name)
      if (typeof probe !== "function") throw new TypeError("probe must be callable")
      const configuredTimeoutMs = options?.timeoutMs
      const timeoutMs = configuredTimeoutMs === undefined ? defaultTimeoutMs : configuredTimeoutMs
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new RangeError("timeoutMs must be finite and non-negative")
      }
      if (activeNames[kind].has(name)) throw new TypeError(`probe "${name}" is already registered`)

      const registration: Registration = {
        kind,
        name,
        probe,
        timeoutMs,
        active: true
      }
      activeNames[kind].add(name)
      registrations.push(registration)

      return newUnregister(registrations, activeNames[kind], kind, name)
    },

    /** Runs one immutable active-registration snapshot. */
    async check(ctx: Context, kind: ProbeKind): Promise<ProbeReport> {
      assertKind(kind)
      const snapshot = registrations.filter((registration) => {
        return registration.active && registration.kind === kind
      })
      const checks = await Promise.all(snapshot.map((registration) => runProbe(ctx, registration)))
      return freezeReport(kind, checks)
    }
  })
}
