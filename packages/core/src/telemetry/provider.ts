/**
 * Plug-facing telemetry SDK.
 * Owning plugs start units here. Socket plugs read correlation, resource, and severity helpers here.
 * Application code does not import this entry.
 */
import type { Context } from "../context/index"

import { injectHeaders, injectRecord } from "./internal/carriers"
import { logEvent } from "./internal/events"
import { beginCoreUnit } from "./internal/units"
import {
  isValidSpanContext,
  logCorrelation,
  observing,
  resourceFromContext,
  withRemoteSpanContext
} from "./internal/state"

export { injectHeaders, injectRecord, logEvent }
export { isValidSpanContext, logCorrelation, observing, resourceFromContext, withRemoteSpanContext }

/**
 * Unit kinds a plug may own.
 * Core-only kinds stay on the internal contract.
 */
export type Unit =
  | {
      readonly kind: "rpc.server"
      readonly system: string
      readonly method: string
      readonly stream: boolean
    }
  | {
      readonly kind: "rpc.client"
      readonly system: string
      readonly method: string
      readonly stream: boolean
    }
  | {
      readonly kind: "messaging.publish"
      readonly system: string
      readonly destination: string
      readonly bodySize: number
    }
  | {
      readonly kind: "messaging.process"
      readonly system: string
      readonly subscription: string
      readonly destination: string
      readonly bodySize: number
    }
  | {
      readonly kind: "job.run"
      readonly system: string
      readonly name: string
      readonly trigger: "schedule" | "queue"
      readonly id: string | null
      readonly attempt: number
    }
  | {
      readonly kind: "job.enqueue"
      readonly system: string
      readonly name: string
      readonly queue: string
    }

/** Terminal result of one streaming RPC unit. */
export interface StreamResult {
  readonly messages: number
  readonly handshakeMs: number
  readonly status: "success" | "canceled" | "truncated" | "error"
  /** Terminal error code when `status` is `"error"`. */
  readonly code: string | null
}

/**
 * Result passed to `UnitScope.end`.
 * `rpcStatusCode` is a ServiceError code or `"ok"` for `go_like`, and an upper-case gRPC status name otherwise.
 */
export interface UnitResult {
  /** Classified into a bounded `error.type`. Never copied into a log message. */
  readonly error?: unknown
  /** Protocol status. Defaults to `"ok"` on success for RPC units. */
  readonly rpcStatusCode?: string
  /** Server-side caller fault. Span status stays UNSET. */
  readonly callerFault?: boolean
  readonly httpStatus?: number
  readonly stream?: StreamResult
}

/** Scope returned by `beginUnit`: the unit context, one implicit-scope run, and a single end. */
export interface UnitScope {
  /** Context carrying the extracted parent and the unit span. */
  readonly ctx: Context
  /** Runs `fn` inside `TracerProvider.enter` when the provider has a bridge. */
  run<R>(fn: (ctx: Context) => R): R
  /** Completes the unit once. Later calls do nothing. */
  end(result?: UnitResult): void
}

/** Fetch headers or a string record used as a propagation carrier. */
export type PropagationCarrier = Headers | Readonly<Record<string, string>>

/**
 * Starts one plug-owned unit.
 * A null carrier on `rpc.server` nests under the explicit context span and never under an implicit span.
 */
export function beginUnit(
  ctx: Context,
  unit: Unit,
  carrier?: PropagationCarrier | null
): UnitScope {
  return beginCoreUnit(ctx, unit, carrier)
}

/** Correlation fields every log plug writes. `trace_flags` is two lowercase hex digits. */
export interface LogCorrelation {
  readonly trace_id: string
  readonly span_id: string
  readonly trace_flags: string
}

/** OTel severity numbers for the four log levels. */
export const LogSeverityNumber = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17
} as const
