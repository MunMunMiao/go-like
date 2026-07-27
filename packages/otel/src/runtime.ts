import type { Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"

import {
  newOtelAlreadyStartedError,
  newOtelShutdownTimeoutError,
  normalizeOtelError,
  type OtelServerState
} from "./errors"
import { defaultOtelShutdownTimeoutMs, type OtelServer } from "./types"

const maximumTimerDelay = 2_147_483_647
const doneSucceeded = Object.freeze({ kind: "succeeded" })

/** Minimal native provider lifecycle required by the adapter. */
export interface OtelProviderLike {
  /** Flushes and closes the provider according to the official SDK contract. */
  shutdown(): Promise<void>
}

/** Structural provider bundle reserved for package testing. */
export interface OtelProviderBundleLike {
  readonly tracerProvider?: OtelProviderLike
  readonly meterProvider?: OtelProviderLike
}

interface OtelConfig {
  shutdownTimeoutMs: number
}

/** Applies one Go-style lifecycle option without describing telemetry business config. */
export type OtelOption = (config: OtelConfig) => void

interface ProviderShutdown {
  readonly completed: Promise<void>
  /** Returns native failures observed so far in trace-then-metric order. */
  errors(): readonly Error[]
}

/** Deliberately consumes a rejection exposed through the stable terminal barrier. */
function consumeOtelPromise(_value: unknown): void {}

/** Configures the owner wait boundary without fabricating provider terminal state. */
export function otelShutdownTimeout(timeoutMs: number): OtelOption {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > maximumTimerDelay) {
    throw new RangeError(
      `OpenTelemetry shutdown timeout must be an integer between zero and ${maximumTimerDelay} milliseconds`
    )
  }
  return (config) => {
    config.shutdownTimeoutMs = timeoutMs
  }
}

/** Validates one borrowed native provider lifecycle. */
function provider(value: OtelProviderLike | undefined, label: string): OtelProviderLike | null {
  if (value === undefined) return null
  if (value === null || typeof value !== "object" || typeof value.shutdown !== "function") {
    throw new TypeError(`${label} must be an official OpenTelemetry provider`)
  }
  return value
}

/** Captures the application provider identities without cloning or configuring them. */
function captureProviders(
  value: OtelProviderBundleLike
): readonly [OtelProviderLike | null, OtelProviderLike | null] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("OpenTelemetry providers must be an object")
  }
  const tracerProvider = provider(value.tracerProvider, "tracerProvider")
  const meterProvider = provider(value.meterProvider, "meterProvider")
  if (tracerProvider === null && meterProvider === null) {
    throw new TypeError("at least one OpenTelemetry provider is required")
  }
  if (tracerProvider !== null && tracerProvider === meterProvider) {
    throw new TypeError("tracerProvider and meterProvider must not share one shutdown identity")
  }
  return Object.freeze([tracerProvider, meterProvider])
}

/** Turns one immutable terminal signal into a stable Promise. */
function terminalPromise(controller: AbortController): Promise<void> {
  const promise = new Promise<void>(
    /** Mirrors the controller reason through the public terminal barrier. */
    function waitForTerminal(resolve, reject) {
      /** Publishes the immutable success or failure reason. */
      function terminalReached(): void {
        const reason: unknown = controller.signal.reason
        if (reason === doneSucceeded) resolve()
        else reject(reason)
      }
      controller.signal.addEventListener("abort", terminalReached, { once: true })
    }
  )
  void promise.catch(consumeOtelPromise)
  return promise
}

/** Calls one native provider shutdown and preserves an Error rejection by identity. */
function shutdownProvider(label: string, value: OtelProviderLike): Promise<void> {
  try {
    return Promise.resolve(value.shutdown()).catch((failure: unknown) => {
      throw normalizeOtelError(`${label} provider shutdown`, failure)
    })
  } catch (failure) {
    return Promise.reject(normalizeOtelError(`${label} provider shutdown`, failure))
  }
}

/** Starts every supplied provider shutdown concurrently and records deterministic failures. */
function shutdownProviders(
  tracerProvider: OtelProviderLike | null,
  meterProvider: OtelProviderLike | null
): ProviderShutdown {
  let traceFailure: Error | null = null
  let metricFailure: Error | null = null
  const operations: Promise<void>[] = []
  if (tracerProvider !== null) {
    operations.push(
      shutdownProvider("trace", tracerProvider).catch((failure: unknown) => {
        traceFailure = normalizeOtelError("trace provider shutdown", failure)
      })
    )
  }
  if (meterProvider !== null) {
    operations.push(
      shutdownProvider("metric", meterProvider).catch((failure: unknown) => {
        metricFailure = normalizeOtelError("metric provider shutdown", failure)
      })
    )
  }
  const completed = Promise.all(operations).then(() => {})
  return Object.freeze({
    completed,
    /** Returns only failures already observed without exposing mutable storage. */
    errors(): readonly Error[] {
      const errors: Error[] = []
      if (traceFailure !== null) errors.push(traceFailure)
      if (metricFailure !== null) errors.push(metricFailure)
      return Object.freeze(errors)
    }
  })
}

/** Combines provider failures and an optional owner timeout in stable order. */
function shutdownFailure(shutdown: ProviderShutdown, timeout: Error | null): Error | null {
  const errors: Error[] = []
  for (const error of shutdown.errors()) errors.push(error)
  if (timeout !== null) errors.push(timeout)
  const first = errors[0]
  if (first === undefined) return null
  if (errors.length === 1) return first
  return new AggregateError(errors, "OpenTelemetry provider shutdown failed")
}

/** Converts one failure-valued owner result into the Server stop contract. */
function stopResult(result: Promise<Error | null>): Promise<void> {
  return result.then((failure) => {
    if (failure !== null) throw failure
  })
}

/** Creates a lifecycle-only Server over application-configured native providers. */
export function newOtelServerWithProviders(
  providers: OtelProviderBundleLike,
  options: readonly OtelOption[]
): OtelServer {
  const [tracerProvider, meterProvider] = captureProviders(providers)
  const config: OtelConfig = { shutdownTimeoutMs: defaultOtelShutdownTimeoutMs }
  for (const option of options) {
    if (typeof option !== "function")
      throw new TypeError("OpenTelemetry server option must be a function")
    option(config)
  }
  let state: OtelServerState = "idle"
  let ownerWaiter: Promise<void> | null = null
  let ownerShutdown: Promise<void> | null = null
  let terminalSettled = false
  const terminal = new AbortController()
  const done = terminalPromise(terminal)

  /** Publishes the provider shutdown result exactly once. */
  function finish(failure: Error | null): void {
    if (terminalSettled) return
    terminalSettled = true
    if (failure === null) {
      state = "stopped"
      terminal.abort(doneSucceeded)
      return
    }
    state = "failed"
    terminal.abort(failure)
  }

  /** Starts or joins shutdown while separating the owner deadline from terminal. */
  function beginOwnerShutdown(): Promise<void> {
    if (ownerWaiter !== null) return ownerWaiter
    state = "stopping"
    const deadline = performance.now() + config.shutdownTimeoutMs
    let timeoutFailure: Error | null = null
    let ownerPublished = false
    let terminalPublished = false
    let resolveOwner: (failure: Error | null) => void = consumeOtelPromise
    const owner = new Promise<Error | null>((resolve) => {
      resolveOwner = resolve
    })
    let timer: ReturnType<typeof setTimeout> | null = null

    /** Publishes a frozen owner-wait snapshot at most once. */
    function publishOwner(failure: Error | null): void {
      if (ownerPublished) return
      ownerPublished = true
      resolveOwner(failure)
    }

    let shutdown: ProviderShutdown

    /** Ends only the owner wait; providers remain live until their Promises settle. */
    function deadlineExceeded(): void {
      if (terminalPublished || ownerPublished) return
      timeoutFailure = newOtelShutdownTimeoutError(config.shutdownTimeoutMs)
      publishOwner(shutdownFailure(shutdown, timeoutFailure))
    }

    if (config.shutdownTimeoutMs > 0) {
      timer = setTimeout(deadlineExceeded, config.shutdownTimeoutMs)
    }
    shutdown = shutdownProviders(tracerProvider, meterProvider)
    if (performance.now() >= deadline) deadlineExceeded()

    const terminalResult = shutdown.completed.then(() => {
      if (performance.now() >= deadline) deadlineExceeded()
      terminalPublished = true
      if (timer !== null) clearTimeout(timer)
      const failure = shutdownFailure(shutdown, timeoutFailure)
      publishOwner(failure)
      return failure
    })
    ownerWaiter = stopResult(owner)
    ownerShutdown = terminalResult.then(finish)
    void terminalResult.catch(consumeOtelPromise)
    void ownerWaiter.catch(consumeOtelPromise)
    void ownerShutdown.catch(consumeOtelPromise)
    return ownerWaiter
  }

  return Object.freeze({
    /** Accepts lifecycle ownership without creating or configuring a provider. */
    start(ctx: Context): Promise<void> {
      if (state !== "idle") return Promise.reject(newOtelAlreadyStartedError(state))
      state = "starting"
      const running = waitForContext(ctx, Promise.resolve()).then(
        () => {
          state = "running"
          return done
        },
        (failure: unknown) => {
          state = "failed"
          finish(normalizeOtelError("OpenTelemetry provider startup", failure))
          throw failure
        }
      )
      void running.catch(consumeOtelPromise)
      return running
    },
    /** Joins provider shutdown while caller Context only bounds this invocation. */
    stop(stopContext: Context): Promise<void> {
      if (state === "idle") return Promise.resolve()
      if (state === "failed" && ownerWaiter === null) return waitForContext(stopContext, done)
      return waitForContext(stopContext, beginOwnerShutdown())
    }
  })
}
