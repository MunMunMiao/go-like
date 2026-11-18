/**
 * The only telemetry import other core domains use.
 * Names live here so call sites do not spell semantic-convention strings themselves.
 */
export { AttributeKey, LogEvent, LogField, SemconvValue } from "../semconv"
export { installTelemetry, whenTelemetryAdmitted } from "../bundle"
export { endAtBodyEnd, pullInScope } from "./body"
export type { BodyEndOptions } from "./body"
export { injectHeaders } from "./carriers"
export { logEvent, recordEvent, type AppStopReason, type CoreEvent } from "./events"
export { errorType, rpcFailure } from "./outcome"
export { isTelemetry, markHealthResponse, resourceFromAppInfo } from "./resource"
export type { ResourceIdentity } from "./resource"
export { detachSpan, enterRoot, enterScope, ignoredRequest, withOperation } from "./state"
export { beginCoreUnit, unitSpanContext, type CoreUnit, type InternalUnit } from "./units"
