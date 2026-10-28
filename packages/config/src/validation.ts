import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { ConfigValue } from "./config"
import { newValidationError, normalizeError } from "./errors"
import { frozenClone } from "./value"

export interface CapturedSchema<Input extends ConfigValue, Output extends ConfigValue> {
  readonly receiver: StandardSchemaV1.Props<Input, Output>
  readonly validate: StandardSchemaV1.Props<Input, Output>["validate"]
}

type InspectedResult<T extends ConfigValue> =
  | { readonly kind: "issues"; readonly count: number }
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "malformed"; readonly cause?: Error }

/** Creates a fixed, secret-safe cause for a non-conforming validator result. */
function malformedResultCause(): Error {
  return Object.freeze(new Error("standard schema returned a malformed result"))
}

/** Captures the Standard Schema v1 properties and validator exactly once without invoking validation. */
export function captureSchema<Input extends ConfigValue, Output extends ConfigValue>(
  schema: StandardSchemaV1<Input, Output>
): CapturedSchema<Input, Output> {
  try {
    const standard = schema["~standard"]
    if (standard === null || typeof standard !== "object")
      throw new TypeError("invalid standard schema")
    const version = standard.version
    const vendor = standard.vendor
    const validate = standard.validate
    if (
      version !== 1 ||
      typeof vendor !== "string" ||
      vendor.length === 0 ||
      typeof validate !== "function"
    ) {
      throw new TypeError("invalid standard schema")
    }
    return Object.freeze({ receiver: standard, validate })
  } catch {
    throw new TypeError("invalid standard schema")
  }
}

/** Validates and independently freezes a merged document through the captured Standard Schema contract. */
export async function validateConfig<Input extends ConfigValue, Output extends ConfigValue>(
  captured: CapturedSchema<Input, Output>,
  value: ConfigValue
): Promise<Output> {
  let result: unknown
  try {
    result = await captured.validate.call(captured.receiver, value)
  } catch (error) {
    throw newValidationError("threw", 0, normalizeError(error))
  }
  const inspected = inspectResult<Output>(result)
  if (inspected.kind === "issues") throw newValidationError("issues", inspected.count)
  if (inspected.kind === "malformed") {
    throw newValidationError("malformed-result", 0, inspected.cause)
  }
  try {
    return frozenClone(inspected.value)
  } catch (error) {
    throw newValidationError("invalid-output", 0, normalizeError(error))
  }
}

/** Reads a validator result once and converts vendor-owned shape failures into a neutral description. */
function inspectResult<T extends ConfigValue>(value: unknown): InspectedResult<T> {
  try {
    if (value === null || typeof value !== "object")
      return { kind: "malformed", cause: malformedResultCause() }
    if ("issues" in value) {
      const issues = value.issues
      if (!Array.isArray(issues)) return { kind: "malformed", cause: malformedResultCause() }
      return { kind: "issues", count: issues.length }
    }
    if (hasValue<T>(value)) return { kind: "value", value: value.value }
    return { kind: "malformed", cause: malformedResultCause() }
  } catch (error) {
    return { kind: "malformed", cause: normalizeError(error) }
  }
}

/** Narrows a successful Standard Schema result while preserving its declared output type. */
function hasValue<T extends ConfigValue>(value: object): value is { readonly value: T } {
  return "value" in value
}
