import type { Context } from "@go-like/core/context"
import type { LogLevel, LogRecord, LogValue } from "@go-like/core/log"
import { LogField, type Scope } from "@go-like/core/telemetry"
import { LogSeverityNumber } from "@go-like/core/telemetry/provider"
import type {
  AnyValue,
  Attributes as OtelAttributes,
  LoggerProvider as ApiLoggerProvider
} from "@opentelemetry/api"

import { toOtelContext } from "./bridge"
import { providerLifecycle, readShutdownTimeout } from "./lifecycle"
import type { OtelLogHandler, OtelLogsOptions, Shutdownable } from "./types"

const severityText: Readonly<Record<LogLevel, string>> = Object.freeze({
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR"
})

function anyValue(value: LogValue): AnyValue {
  if (value instanceof Error) return value.name
  if (Array.isArray(value)) return value as AnyValue
  if (typeof value === "object" && value !== null) {
    const out: Record<string, AnyValue> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = anyValue(entry as LogValue)
    return out
  }
  return value as AnyValue
}

/**
 * Adapts an application SDK LoggerProvider.
 * `enabled` calls `logger.enabled`. `handle` calls `logger.emit`. There is no `withAttrs`.
 */
export function newOtelLogHandler(
  provider: ApiLoggerProvider & Shutdownable,
  options: OtelLogsOptions = {}
): OtelLogHandler {
  if (typeof provider?.getLogger !== "function" || typeof provider.shutdown !== "function") {
    throw new TypeError("provider must be an OpenTelemetry SDK LoggerProvider")
  }
  const scope: Scope = options.scope ?? { name: "go-like" }
  const logger =
    scope.version === undefined
      ? provider.getLogger(scope.name)
      : provider.getLogger(scope.name, scope.version)
  const lifecycle = providerLifecycle(provider, readShutdownTimeout(options.shutdownTimeoutMs))
  return Object.freeze({
    enabled: (ctx: Context, level: LogLevel) =>
      logger.enabled({
        severityNumber: LogSeverityNumber[level],
        context: toOtelContext(ctx, false)
      }),
    handle(ctx: Context, record: LogRecord): void {
      const attributes: Record<string, AnyValue> = {}
      let exception: unknown
      for (const [key, value] of Object.entries(record.attrs)) {
        if (key === LogField.exception) exception = value
        else attributes[key] = anyValue(value)
      }
      logger.emit({
        ...(record.event === "" ? {} : { eventName: record.event }),
        ...(exception === undefined ? {} : { exception }),
        timestamp: record.time,
        severityNumber: LogSeverityNumber[record.level],
        severityText: severityText[record.level],
        body: record.message,
        attributes: attributes as OtelAttributes,
        context: toOtelContext(ctx, false)
      })
    },
    lifecycle
  })
}
