import type { StandardSchemaV1 } from "@standard-schema/spec"

import type {
  ConfigAlreadyLoadedError,
  ConfigNotFoundError,
  ConfigSourceError,
  ConfigValidationError
} from "./config"

/** Normalizes a boundary rejection without retaining or stringifying a non-Error value. */
export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value
  return Object.freeze(new Error("configuration operation failed with a non-Error value"))
}

/** Builds an immutable source-boundary error that preserves an Error rejection as its cause. */
export function newSourceError(
  sourceName: string,
  phase: ConfigSourceError["phase"],
  value: unknown
): ConfigSourceError {
  const error = new Error(`configuration source "${sourceName}" failed during ${phase}`, {
    cause: normalizeError(value)
  })
  const details: Pick<ConfigSourceError, "name" | "code" | "sourceName" | "phase"> = {
    name: "ConfigSourceError",
    code: "GO_LIKE_CONFIG_SOURCE",
    sourceName,
    phase
  }
  return Object.freeze(Object.assign(error, details))
}

/** Builds a secret-safe validation error with framework-owned placeholder issues only. */
export function newValidationError(
  reason: ConfigValidationError["reason"],
  issueCount: number,
  cause?: Error
): ConfigValidationError {
  const issues: StandardSchemaV1.Issue[] = []
  for (let index = 0; index < issueCount; index += 1) {
    issues.push(Object.freeze({ message: "configuration validation failed" }))
  }
  const error = new Error(
    "configuration validation failed",
    cause === undefined ? undefined : { cause }
  )
  const details: Pick<ConfigValidationError, "name" | "code" | "reason" | "issues"> = {
    name: "ConfigValidationError",
    code: "GO_LIKE_CONFIG_VALIDATION",
    reason,
    issues: Object.freeze(issues)
  }
  return Object.freeze(Object.assign(error, details))
}

/** Builds the immutable error returned when a current root or dotted value is absent. */
export function newNotFoundError(key: string): ConfigNotFoundError {
  const error = new Error(
    key.length === 0
      ? "configuration has not been loaded"
      : `configuration value "${key}" not found`
  )
  const details: Pick<ConfigNotFoundError, "name" | "code" | "key"> = {
    name: "ConfigNotFoundError",
    code: "GO_LIKE_CONFIG_NOT_FOUND",
    key
  }
  return Object.freeze(Object.assign(error, details))
}

/** Builds the immutable error returned for every repeated one-shot load attempt. */
export function newAlreadyLoadedError(
  status: ConfigAlreadyLoadedError["status"]
): ConfigAlreadyLoadedError {
  const error = new Error("configuration has already loaded")
  const details: Pick<ConfigAlreadyLoadedError, "name" | "code" | "status"> = {
    name: "ConfigAlreadyLoadedError",
    code: "GO_LIKE_CONFIG_ALREADY_LOADED",
    status
  }
  return Object.freeze(Object.assign(error, details))
}

/** Preserves one primary lifecycle failure while retaining later cleanup failures in order. */
export function aggregateFailures(primary: Error, cleanup: readonly Error[]): Error {
  if (cleanup.length === 0) return primary
  const failures = [primary]
  for (const failure of cleanup) failures.push(failure)
  return Object.freeze(new AggregateError(failures, "configuration lifecycle failed"))
}
