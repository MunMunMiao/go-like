import { coreVersion } from "../../internal/version"
import type { Context } from "../../context/index"
import type { Attributes } from "../types"
import type { Span, SpanContext, SpanKind, SpanLink } from "../../trace/index"
import type { PropagationCarrier, Unit, UnitResult, UnitScope } from "../provider"
import { AttributeKey, LogEvent, MetricName, SemconvValue } from "../semconv"

import { completionSuppressed, rememberUnitClock } from "./body"
import { carrierReader } from "./carriers"
import { writeLog, type AppStopReason } from "./events"
import { anyEnabled } from "./fanout"
import { recordCoreCounter, recordCoreHistogram, recordHttpActive } from "./instruments"
import { classifyUnit, completionAllowed, type UnitClassification } from "./outcome"
import {
  coreScope,
  detachSpan,
  enterScope,
  isValidSpanContext,
  stateFrom,
  withOperation,
  withSpan
} from "./state"

export type { AppStopReason }

/** Units only the kernel and core own. */
export type InternalUnit =
  | { readonly kind: "http.server"; readonly method: string; readonly scheme: "http" | "https" }
  | { readonly kind: "app.start" }
  | {
      readonly kind: "app.stop"
      readonly reason: AppStopReason
      readonly startLink: SpanContext | null
    }
  | { readonly kind: "config.load" }
  | { readonly kind: "config.reload"; readonly loadLink: SpanContext | null }
  | { readonly kind: "registry.register"; readonly service: string }
  | { readonly kind: "registry.deregister"; readonly service: string }

/** Every unit kind core knows how to record. */
export type CoreUnit = Unit | InternalUnit

const emptyAttributes: Attributes = Object.freeze({})
const emptyLinks: readonly SpanLink[] = Object.freeze([])
const httpMethodPattern = /^[A-Z][A-Z0-9]*$/
const scopeSpans = new WeakMap<UnitScope, Span>()

/**
 * Starts a public or internal unit.
 * Returns an inert scope, with no clock and no attribute objects, when ctx is not observing.
 */
export function beginCoreUnit(
  ctx: Context,
  unit: CoreUnit,
  carrier?: PropagationCarrier | null
): UnitScope {
  const state = stateFrom(ctx)
  if (state === null || state.active !== true) return inert(ctx)
  const selectedCarrier = carrier ?? null
  const extracted = inbound(unit)
    ? extractParent(ctx, unit, selectedCarrier)
    : { ctx, remote: false }
  const root = unitRoot(unit, extracted.remote, selectedCarrier, ctx)
  const name = spanName(unit)
  const kind = spanKind(unit)
  const links = spanLinks(unit)
  let span: Span | null = null
  if (state.tracer !== null) {
    try {
      span = state.tracer.startSpan(extracted.ctx, coreScope(coreVersion), name, {
        kind,
        attributes: startAttributes(unit),
        links,
        root
      })
    } catch {
      span = null
    }
  }
  const unitCtx =
    span === null ? withOperation(extracted.ctx, name) : withSpan(extracted.ctx, span, name)
  const meters = state.meters.length > 0
  const logs = state.fanout.length > 0
  const timed = state.tracer !== null || meters || logs
  const startedAt = timed ? performance.now() : 0
  const http = unit.kind === "http.server" ? httpMethod(unit.method) : null
  if (http !== null && meters && unit.kind === "http.server") {
    recordHttpActive(unitCtx, http.attribute, unit.scheme, 1)
  }
  let ended = false
  const scope: UnitScope = {
    ctx: unitCtx,
    /** Runs the callback inside the provider bridge, passing the unit context. */
    run<R>(fn: (ctx: Context) => R): R {
      return enterScope(unitCtx, () => fn(unitCtx))
    },
    /** Records the unit outcome once. */
    end(result?: UnitResult): void {
      if (ended) return
      ended = true
      if (http !== null && meters && unit.kind === "http.server") {
        recordHttpActive(unitCtx, http.attribute, unit.scheme, -1)
      }
      if (!timed) {
        finishSpan(span, null, emptyAttributes)
        return
      }
      const classification = classifyUnit(unit.kind, result, unitCtx)
      const durationMs = Math.max(0, performance.now() - startedAt)
      if (meters && Number.isFinite(durationMs))
        recordMetrics(unitCtx, unit, classification, durationMs, result)
      finishSpan(span, classification, endAttributes(unit, classification, durationMs, result))
      if (completionSuppressed(scope)) return
      const mode = state.completionLogs
      if (!completionAllowed(mode, unit.kind, classification.outcome)) return
      if (!logs || !anyEnabled(state.fanout, unitCtx, classification.level)) return
      writeLog(
        unitCtx,
        classification.level,
        completionEvent(unit, classification),
        completionMessage(unit, classification),
        logAttributes(unit, classification, durationMs, result)
      )
    }
  }
  if (span !== null) scopeSpans.set(scope, span)
  if (timed) rememberUnitClock(scope, startedAt)
  return scope
}

/** Returns the unit span identity, or null when the unit was not traced. */
export function unitSpanContext(scope: UnitScope): SpanContext | null {
  const span = scopeSpans.get(scope)
  if (span === undefined) return null
  try {
    const context = span.spanContext()
    return isValidSpanContext(context) ? context : null
  } catch {
    return null
  }
}

/** Scope used when telemetry is off. `run` calls the callback on the same turn. */
function inert(ctx: Context): UnitScope {
  return {
    ctx,
    /** Calls `fn` with the original context. */
    run<R>(fn: (ctx: Context) => R): R {
      return fn(ctx)
    },
    /** Disabled units have nothing to finish. */
    end(): void {}
  }
}

/** Inbound units may extract a remote parent. `rpc.server` with a null carrier does not. */
function inbound(unit: CoreUnit): boolean {
  if (unit.kind === "http.server" || unit.kind === "messaging.process") return true
  if (unit.kind === "rpc.server") return true
  return unit.kind === "job.run" && unit.trigger === "queue"
}

/** Reports whether extraction installed a valid remote span on `ctx`. */
function extractedRemoteParent(ctx: Context): boolean {
  const span = stateFrom(ctx)?.span
  if (span === undefined || span === null) return false
  try {
    const context = span.spanContext()
    return context.isRemote === true && isValidSpanContext(context)
  } catch {
    return false
  }
}

/**
 * Extracts a remote parent after the previous span has been removed.
 * Success is a valid remote span on the result. An empty, malformed, or
 * throwing carrier does not keep the span that was already on `ctx`.
 * `rpc.server` with a null carrier keeps that explicit parent.
 */
function extractParent(
  ctx: Context,
  unit: CoreUnit,
  carrier: PropagationCarrier | null
): { readonly ctx: Context; readonly remote: boolean } {
  if (unit.kind === "rpc.server" && carrier === null) return { ctx, remote: false }
  const propagator = stateFrom(ctx)?.propagator
  if (carrier === null || propagator === null || propagator === undefined) {
    return { ctx: detachSpan(ctx), remote: false }
  }
  const cleared = detachSpan(ctx)
  try {
    const next = propagator.extract(cleared, carrierReader(carrier))
    if (extractedRemoteParent(next)) return { ctx: next, remote: true }
    return { ctx: detachSpan(next), remote: false }
  } catch {
    return { ctx: cleared, remote: false }
  }
}

/** Root rule R7. `rpc.server` with no carrier nests under a valid explicit span. */
function unitRoot(
  unit: CoreUnit,
  remote: boolean,
  carrier: PropagationCarrier | null,
  explicit: Context
): boolean {
  switch (unit.kind) {
    case "rpc.client":
    case "messaging.publish":
    case "job.enqueue":
    case "config.load":
    case "registry.register":
    case "registry.deregister":
      return false
    case "app.start":
    case "app.stop":
    case "config.reload":
      return true
    case "job.run":
      return unit.trigger === "schedule" ? true : !remote
    case "rpc.server":
      if (carrier === null) return !hasValidSpan(explicit)
      return !remote
    case "http.server":
    case "messaging.process":
      return !remote
  }
}

/** Span name. RPC `_OTHER` is `go_like`. An unknown HTTP method is `HTTP`. */
function spanName(unit: CoreUnit): string {
  switch (unit.kind) {
    case "rpc.server":
    case "rpc.client":
      return unit.method === SemconvValue.other ? "go_like" : unit.method
    case "http.server":
      return httpMethod(unit.method).name
    case "messaging.publish":
      return "publish"
    case "messaging.process":
      return `process ${unit.subscription}`
    case "job.run":
      return `run ${unit.name}`
    case "job.enqueue":
      return `enqueue ${unit.name}`
    case "app.start":
      return "app start"
    case "app.stop":
      return "app stop"
    case "config.load":
      return "config load"
    case "config.reload":
      return "config reload"
    case "registry.register":
      return "registry register"
    case "registry.deregister":
      return "registry deregister"
  }
}

/** OTel span kind for one unit. */
function spanKind(unit: CoreUnit): SpanKind {
  switch (unit.kind) {
    case "rpc.server":
    case "http.server":
      return "server"
    case "rpc.client":
      return "client"
    case "messaging.publish":
    case "job.enqueue":
      return "producer"
    case "messaging.process":
      return "consumer"
    case "job.run":
      return unit.trigger === "queue" ? "consumer" : "internal"
    default:
      return "internal"
  }
}

/** Causal links. Invalid identities are omitted. */
function spanLinks(unit: CoreUnit): readonly SpanLink[] {
  const context =
    unit.kind === "app.stop" ? unit.startLink : unit.kind === "config.reload" ? unit.loadLink : null
  if (context === null || !isValidSpanContext(context)) return emptyLinks
  return Object.freeze([Object.freeze({ context, attributes: emptyAttributes })])
}

/** Attributes recorded when the span starts. Called only when a tracer is installed. */
function startAttributes(unit: CoreUnit): Attributes {
  switch (unit.kind) {
    case "rpc.server":
    case "rpc.client":
      return defined([
        [AttributeKey.rpcSystemName, unit.system],
        [AttributeKey.rpcMethod, unit.method],
        [AttributeKey.rpcStream, unit.stream]
      ])
    case "http.server":
      return defined([
        [AttributeKey.httpRequestMethod, httpMethod(unit.method).attribute],
        [AttributeKey.urlScheme, unit.scheme]
      ])
    case "messaging.publish":
      return defined([
        [AttributeKey.messagingSystemName, unit.system],
        [AttributeKey.messagingOperationName, SemconvValue.messagingOperationNamePublish],
        [AttributeKey.messagingOperationType, SemconvValue.messagingOperationTypeSend],
        [AttributeKey.messagingDestinationName, unit.destination],
        [AttributeKey.messagingMessageBodySize, unit.bodySize]
      ])
    case "messaging.process":
      return defined([
        [AttributeKey.messagingSystemName, unit.system],
        [AttributeKey.messagingOperationName, SemconvValue.messagingOperationNameProcess],
        [AttributeKey.messagingOperationType, SemconvValue.messagingOperationTypeProcess],
        [AttributeKey.messagingDestinationTemplate, unit.subscription],
        [AttributeKey.messagingDestinationName, unit.destination],
        [AttributeKey.messagingMessageBodySize, unit.bodySize]
      ])
    case "job.run":
      return defined([
        [AttributeKey.jobName, unit.name],
        [AttributeKey.jobTrigger, unit.trigger],
        [AttributeKey.jobSystem, unit.system],
        [AttributeKey.jobId, unit.id],
        [AttributeKey.jobAttempt, unit.attempt]
      ])
    case "job.enqueue":
      return defined([
        [AttributeKey.jobName, unit.name],
        [AttributeKey.jobSystem, unit.system],
        [AttributeKey.jobQueue, unit.queue]
      ])
    case "app.stop":
      return defined([[AttributeKey.appStopReason, unit.reason]])
    case "registry.register":
    case "registry.deregister":
      return defined([[AttributeKey.registryService, unit.service]])
    default:
      return emptyAttributes
  }
}

/** Attributes added at the end, and only when the span is recording. */
function endAttributes(
  unit: CoreUnit,
  classification: UnitClassification,
  durationMs: number,
  result: UnitResult | undefined
): Attributes {
  const common: Array<readonly [string, string | number | boolean | null]> = [
    [AttributeKey.outcome, classification.outcome],
    [AttributeKey.durationMs, durationMs],
    [AttributeKey.errorType, classification.errorType]
  ]
  if (unit.kind === "rpc.server" || unit.kind === "rpc.client") {
    common.push([AttributeKey.rpcStatusCode, classification.rpcStatusCode])
    const stream = result?.stream
    if (stream !== undefined) {
      common.push(
        [AttributeKey.rpcStreamMessages, stream.messages],
        [AttributeKey.rpcStreamHandshakeMs, stream.handshakeMs],
        [AttributeKey.rpcStreamStatus, stream.status]
      )
    }
  }
  if (unit.kind === "http.server" && result?.httpStatus !== undefined) {
    common.push([AttributeKey.httpResponseStatusCode, result.httpStatus])
  }
  return defined(common)
}

/** Records the unit's metrics. Attribute keys outside the instrument schema are dropped later. */
function recordMetrics(
  ctx: Context,
  unit: CoreUnit,
  classification: UnitClassification,
  durationMs: number,
  result: UnitResult | undefined
): void {
  const seconds = durationMs / 1000
  const errorLabel = classification.errorType
  switch (unit.kind) {
    case "rpc.server":
    case "rpc.client":
      recordCoreHistogram(
        ctx,
        unit.kind === "rpc.server"
          ? MetricName.rpcServerCallDuration
          : MetricName.rpcClientCallDuration,
        seconds,
        defined([
          [AttributeKey.rpcSystemName, unit.system],
          [AttributeKey.rpcMethod, unit.method],
          [AttributeKey.rpcStatusCode, classification.rpcStatusCode],
          [AttributeKey.errorType, errorLabel]
        ])
      )
      if (result?.stream !== undefined) {
        recordCoreCounter(ctx, MetricName.rpcStreamMessages, result.stream.messages, {
          [AttributeKey.rpcSystemName]: unit.system,
          [AttributeKey.rpcMethod]: unit.method,
          [AttributeKey.rpcDirection]:
            unit.kind === "rpc.server" ? SemconvValue.directionSent : SemconvValue.directionReceived
        })
      }
      return
    case "http.server":
      recordCoreHistogram(
        ctx,
        MetricName.httpServerRequestDuration,
        seconds,
        defined([
          [AttributeKey.httpRequestMethod, httpMethod(unit.method).attribute],
          [AttributeKey.httpResponseStatusCode, result?.httpStatus ?? null],
          [AttributeKey.urlScheme, unit.scheme],
          [AttributeKey.errorType, errorLabel]
        ])
      )
      return
    case "messaging.publish":
      recordCoreHistogram(
        ctx,
        MetricName.messagingClientOperationDuration,
        seconds,
        defined([
          [AttributeKey.messagingSystemName, unit.system],
          [AttributeKey.messagingOperationName, SemconvValue.messagingOperationNamePublish],
          [AttributeKey.messagingOperationType, SemconvValue.messagingOperationTypeSend],
          [AttributeKey.errorType, errorLabel]
        ])
      )
      return
    case "messaging.process":
      recordCoreHistogram(
        ctx,
        MetricName.messagingProcessDuration,
        seconds,
        defined([
          [AttributeKey.messagingSystemName, unit.system],
          [AttributeKey.messagingOperationName, SemconvValue.messagingOperationNameProcess],
          [AttributeKey.errorType, errorLabel]
        ])
      )
      return
    case "job.run":
      recordCoreHistogram(
        ctx,
        MetricName.jobRunDuration,
        seconds,
        defined([
          [AttributeKey.jobName, unit.name],
          [AttributeKey.jobTrigger, unit.trigger],
          [AttributeKey.jobSystem, unit.system],
          [AttributeKey.errorType, errorLabel]
        ])
      )
      return
    case "config.reload":
      recordCoreCounter(
        ctx,
        MetricName.configReloads,
        1,
        defined([[AttributeKey.errorType, errorLabel]])
      )
      return
    default:
      return
  }
}

/** Completion-log attributes. Built only after the mode and level gates pass. */
function logAttributes(
  unit: CoreUnit,
  classification: UnitClassification,
  durationMs: number,
  result: UnitResult | undefined
): Attributes {
  return endAttributes(unit, classification, durationMs, result)
}

/** Completion event name. A failed reload uses the distinct failure event. */
function completionEvent(unit: CoreUnit, classification: UnitClassification): string {
  switch (unit.kind) {
    case "rpc.server":
      return LogEvent.rpcServerCompleted
    case "rpc.client":
      return LogEvent.rpcClientCompleted
    case "http.server":
      return LogEvent.httpServerCompleted
    case "messaging.publish":
      return LogEvent.messagingPublishCompleted
    case "messaging.process":
      return LogEvent.messagingProcessCompleted
    case "job.run":
      return LogEvent.jobRunCompleted
    case "job.enqueue":
      return LogEvent.jobEnqueueCompleted
    case "app.start":
      return LogEvent.appStarted
    case "app.stop":
      return LogEvent.appStopped
    case "config.load":
      return LogEvent.configLoaded
    case "config.reload":
      return classification.outcome === "failure"
        ? LogEvent.configReloadFailed
        : LogEvent.configReloaded
    case "registry.register":
      return LogEvent.registryRegistered
    case "registry.deregister":
      return LogEvent.registryDeregistered
  }
}

/** Stable completion message. It never contains error text. */
function completionMessage(unit: CoreUnit, classification: UnitClassification): string {
  if (unit.kind === "config.reload" && classification.outcome === "failure")
    return "config reload failed"
  return completionEvent(unit, classification)
}

/** Ends the span. Status description is never set, and `recordError` is never called. */
function finishSpan(
  span: Span | null,
  classification: UnitClassification | null,
  attributes: Attributes
): void {
  if (span === null) return
  try {
    if (classification !== null && span.isRecording()) {
      if (classification.spanStatus === "error") span.setStatus("error")
      if (Object.keys(attributes).length > 0) span.setAttributes(attributes)
    }
    span.end()
  } catch {
    // A plug fault while ending a span does not fail the unit's caller.
  }
}

/** Keeps non-null attribute values and freezes the map. */
function defined(
  entries: ReadonlyArray<readonly [string, string | number | boolean | null]>
): Attributes {
  const selected: Record<string, string | number | boolean> = {}
  for (const [key, value] of entries) {
    if (value === null) continue
    selected[key] = value
  }
  return Object.freeze(selected)
}

/** Maps an HTTP method onto the span name and the bounded attribute value. */
function httpMethod(method: string): { readonly name: string; readonly attribute: string } {
  if (httpMethodPattern.test(method) && method !== "HTTP")
    return { name: method, attribute: method }
  return { name: "HTTP", attribute: SemconvValue.other }
}

/** Reports whether ctx carries a valid span identity. */
function hasValidSpan(ctx: Context): boolean {
  const span = stateFrom(ctx)?.span
  if (span === undefined || span === null) return false
  try {
    return isValidSpanContext(span.spanContext())
  } catch {
    return false
  }
}
