import type { Context } from "../../context/index"
import { isError, toError } from "../../internal/errors"
import type { LogAttrs, LogLevel, LogRecord } from "../../log/index"
import { AttributeKey, LogEvent, LogField, MetricName, SemconvValue, SpanEvent } from "../semconv"

import { anyEnabled, deliver } from "./fanout"
import { onInstrumentFailure, recordCoreCounter, recordCoreGauge } from "./instruments"
import { errorType } from "./outcome"
import { stateFrom } from "./state"

/** Why an App entered its stop sequence. The first reason wins. */
export type AppStopReason = "requested" | "server_failed" | "context_canceled" | "start_failed"

const emptyAttrs: LogAttrs = Object.freeze({})

/** Units and diagnostics core records through one call. */
export type CoreEvent =
  | {
      readonly kind: "retry.scheduled"
      readonly attempt: number
      readonly delayMs: number
      readonly error: unknown
    }
  | {
      readonly kind: "circuit_breaker.transition"
      readonly name: string
      readonly state: "closed" | "open" | "half_open"
    }
  | { readonly kind: "rate_limit.rejected" }
  | {
      readonly kind: "registry.watch.updated"
      readonly service: string
      readonly instances: number
    }
  | { readonly kind: "registry.watch.failed"; readonly service: string; readonly error: unknown }
  | { readonly kind: "config.terminal"; readonly error: unknown }
  | { readonly kind: "app.ready"; readonly ready: boolean }
  | { readonly kind: "app.stopping"; readonly reason: AppStopReason }
  | {
      readonly kind: "server.failed"
      readonly tier: "telemetry" | "resource" | "server"
      readonly index: number
      readonly error: unknown
    }

/**
 * Writes one log record when a handler is installed and enabled.
 * Completion records use this path so they never reach the console fallback.
 */
export function writeLog(
  ctx: Context,
  level: LogLevel,
  event: string,
  message: string,
  attrs?: LogAttrs
): void {
  const state = stateFrom(ctx)
  if (state === null || state.fanout.length === 0) return
  if (!anyEnabled(state.fanout, ctx, level)) return
  deliver(ctx, state.fanout, record(level, event, message, attrs))
}

/**
 * Writes one diagnostic event.
 * With no log handler, only `error` is written, as one JSON line on `console.error`.
 */
export function logEvent(
  ctx: Context,
  level: LogLevel,
  event: string,
  message: string,
  attrs?: LogAttrs
): void {
  const state = stateFrom(ctx)
  if (state === null || state.fanout.length === 0) {
    if (level === "error") writeDiagnosticFallback(state?.operation ?? "", event, attrs)
    return
  }
  if (!anyEnabled(state.fanout, ctx, level)) return
  deliver(ctx, state.fanout, record(level, event, message, attrs))
}

/** Records one core event's span event, metric, and log line. Disabled contexts return after one lookup. */
export function recordEvent(ctx: Context, event: CoreEvent): void {
  const state = stateFrom(ctx)
  if (state === null || state.active !== true) {
    if (event.kind === "server.failed" || event.kind === "config.terminal") {
      writeDiagnosticFallback("", diagnosticName(event), diagnosticAttrs(event))
    }
    return
  }
  switch (event.kind) {
    case "retry.scheduled":
      addSpanEvent(ctx, SpanEvent.retry, {
        [AttributeKey.retryAttempt]: event.attempt,
        [AttributeKey.retryDelayMs]: event.delayMs
      })
      recordCoreCounter(ctx, MetricName.retryAttempts, 1, {
        [AttributeKey.operation]: operationOf(state.operation)
      })
      logEvent(ctx, "debug", LogEvent.retryScheduled, "retry scheduled", {
        [AttributeKey.retryAttempt]: event.attempt,
        [AttributeKey.retryDelayMs]: event.delayMs,
        [LogField.exception]: exceptionAttr(event.error)
      })
      return
    case "circuit_breaker.transition":
      addSpanEvent(ctx, SpanEvent.circuitBreakerTransition, {
        [AttributeKey.circuitBreakerName]: event.name,
        [AttributeKey.circuitBreakerState]: event.state
      })
      recordCoreCounter(ctx, MetricName.circuitBreakerTransitions, 1, {
        [AttributeKey.operation]: operationOf(state.operation),
        [AttributeKey.circuitBreakerName]: event.name,
        [AttributeKey.circuitBreakerState]: event.state
      })
      logEvent(
        ctx,
        event.state === "open" ? "warn" : "info",
        LogEvent.circuitBreakerTransition,
        "circuit breaker transition",
        {
          [AttributeKey.circuitBreakerName]: event.name,
          [AttributeKey.circuitBreakerState]: event.state
        }
      )
      return
    case "rate_limit.rejected":
      addSpanEvent(ctx, SpanEvent.rateLimited, {})
      recordCoreCounter(ctx, MetricName.rateLimitRejections, 1, {
        [AttributeKey.operation]: operationOf(state.operation)
      })
      logEvent(ctx, "debug", LogEvent.rateLimitRejected, "rate limit rejected", {
        [AttributeKey.operation]: operationOf(state.operation)
      })
      return
    case "registry.watch.updated":
      recordCoreCounter(ctx, MetricName.registryWatchUpdates, 1, {
        [AttributeKey.registryService]: event.service
      })
      logEvent(ctx, "debug", LogEvent.registryWatchUpdated, "registry watch updated", {
        [AttributeKey.registryService]: event.service,
        [AttributeKey.registryInstances]: event.instances
      })
      return
    case "registry.watch.failed":
      recordCoreCounter(ctx, MetricName.registryWatchUpdates, 1, {
        [AttributeKey.registryService]: event.service,
        [AttributeKey.errorType]: errorType(event.error, ctx)
      })
      logEvent(ctx, "warn", LogEvent.registryWatchFailed, "registry watch failed", {
        [AttributeKey.registryService]: event.service,
        [LogField.exception]: exceptionAttr(event.error)
      })
      return
    case "config.terminal":
      logEvent(ctx, "error", LogEvent.configTerminal, "config terminal", {
        [LogField.exception]: exceptionAttr(event.error)
      })
      return
    case "app.ready":
      recordCoreGauge(ctx, MetricName.appReady, event.ready ? 1 : 0)
      logEvent(ctx, "info", LogEvent.appReady, "app ready", {})
      return
    case "app.stopping":
      recordCoreGauge(ctx, MetricName.appReady, 0)
      logEvent(ctx, "info", LogEvent.appStopping, "app stopping", {
        [AttributeKey.appStopReason]: event.reason
      })
      return
    case "server.failed":
      addSpanEvent(ctx, SpanEvent.serverFailed, {
        [AttributeKey.serverIndex]: event.index,
        [AttributeKey.lifecycleTier]: event.tier
      })
      logEvent(ctx, "error", LogEvent.serverFailed, "server failed", {
        [AttributeKey.serverIndex]: event.index,
        [AttributeKey.lifecycleTier]: event.tier,
        [LogField.exception]: exceptionAttr(event.error)
      })
      return
    default:
      return
  }
}

/** Installs the instrument-creation diagnostic once. */
export function armInstrumentDiagnostics(): void {
  if (armed) return
  armed = true
  onInstrumentFailure((ctx, _name, error) => {
    logEvent(ctx, "warn", LogEvent.instrumentFailed, "instrument creation failed", {
      [LogField.exception]: exceptionAttr(error)
    })
  })
}

let armed = false

/** Builds one frozen log record. Attribute copying happens only after the level gate. */
function record(
  level: LogLevel,
  event: string,
  message: string,
  attrs: LogAttrs | undefined
): LogRecord {
  return Object.freeze({
    time: Date.now(),
    level,
    message,
    event,
    attrs: attrs === undefined ? emptyAttrs : copyOwn(attrs)
  })
}

/** Copies own log attributes. A throwing accessor fails the write rather than the process. */
function copyOwn(attrs: LogAttrs): LogAttrs {
  const copy: Record<string, LogAttrs[string]> = {}
  for (const key of Object.keys(attrs)) {
    const value = Object.getOwnPropertyDescriptor(attrs, key)?.value as LogAttrs[string] | undefined
    if (value !== undefined) copy[key] = value
  }
  return Object.freeze(copy)
}

/** Writes the D38 fallback line. The line never contains error text. */
function writeDiagnosticFallback(
  operation: string,
  event: string,
  attrs: LogAttrs | undefined
): void {
  const exception = attrs?.[LogField.exception]
  const line = JSON.stringify({
    "event.name": event,
    "error.type": exception === undefined ? SemconvValue.other : errorType(exception),
    "go_like.operation": operation === "" ? SemconvValue.other : operation
  })
  try {
    console.error(line)
  } catch {
    // A broken console cannot hide the failure that was already returned to the caller.
  }
}

/** Adds a span event when the current span is recording. Plug faults stay inside the call. */
function addSpanEvent(
  ctx: Context,
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>>
): void {
  const span = stateFrom(ctx)?.span
  if (span === undefined || span === null) return
  try {
    if (span.isRecording() !== true) return
    span.addEvent(name, attributes)
  } catch {
    // A span event failure does not change the metric or the log line.
  }
}

/** Uses `_OTHER` when no unit has published an operation identity. */
function operationOf(operation: string): string {
  return operation === "" ? SemconvValue.other : operation
}

/** Preserves an Error and wraps every other diagnostic value. */
function exceptionAttr(value: unknown): Error {
  return isError(value) ? value : toError(value, "diagnostic rejected with a non-Error value")
}

/** Event name used when telemetry is inactive and only the error fallback can run. */
function diagnosticName(event: CoreEvent): string {
  return event.kind === "server.failed" ? LogEvent.serverFailed : LogEvent.configTerminal
}

/** Attributes for the inactive-telemetry fallback. */
function diagnosticAttrs(
  event: Extract<CoreEvent, { readonly kind: "server.failed" | "config.terminal" }>
): LogAttrs {
  if (event.kind === "server.failed") {
    return {
      [AttributeKey.serverIndex]: event.index,
      [AttributeKey.lifecycleTier]: event.tier,
      [LogField.exception]: exceptionAttr(event.error)
    }
  }
  return { [LogField.exception]: exceptionAttr(event.error) }
}

armInstrumentDiagnostics()
