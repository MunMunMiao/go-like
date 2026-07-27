import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { BodyCodec } from "./endpoint"

interface CapturedSchema<T> {
  readonly receiver: StandardSchemaV1.Props<unknown, T>
  readonly validate: StandardSchemaV1.Props<unknown, T>["validate"]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Captures one Standard Schema validator without retaining a mutable method lookup. */
function captureSchema<T>(schema: StandardSchemaV1<unknown, T>): CapturedSchema<T> {
  try {
    const standard = schema["~standard"]
    if (
      standard === null ||
      typeof standard !== "object" ||
      standard.version !== 1 ||
      typeof standard.vendor !== "string" ||
      standard.vendor.length === 0 ||
      typeof standard.validate !== "function"
    ) {
      throw new TypeError("json codec requires a Standard Schema v1 validator")
    }
    return Object.freeze({ receiver: standard, validate: standard.validate })
  } catch {
    throw new TypeError("json codec requires a Standard Schema v1 validator")
  }
}

/** Validates one JSON-compatible value and rejects malformed validator results. */
async function validate<T>(schema: CapturedSchema<T>, value: unknown): Promise<T> {
  let result: unknown
  try {
    result = await schema.validate.call(schema.receiver, value)
  } catch (cause) {
    throw new TypeError("json body validation failed", { cause })
  }
  if (result === null || typeof result !== "object") {
    throw new TypeError("json body validator returned an invalid result")
  }
  if ("issues" in result && result.issues !== undefined) {
    if (!Array.isArray(result.issues)) {
      throw new TypeError("json body validator returned an invalid result")
    }
    throw new TypeError(`json body validation failed with ${result.issues.length} issue(s)`)
  }
  if (!hasValue<T>(result)) throw new TypeError("json body validator returned an invalid result")
  return result.value
}

/** Narrows one successful Standard Schema result. */
function hasValue<T>(value: object): value is { readonly value: T } {
  return "value" in value
}

/** Creates a Web-API JSON codec backed by any Standard Schema v1 validator. */
export function jsonCodec<T>(schema: StandardSchemaV1<unknown, T>): BodyCodec<T> {
  const captured = captureSchema(schema)

  /** Encodes one typed value as UTF-8 JSON. */
  async function encode(value: T): Promise<Uint8Array> {
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError("json body is not serializable")
    return encoder.encode(json)
  }

  /** Decodes UTF-8 JSON and validates the parsed value. */
  async function decode(body: Uint8Array): Promise<T> {
    let value: unknown
    try {
      value = JSON.parse(decoder.decode(body))
    } catch (cause) {
      throw new TypeError("json body is invalid", { cause })
    }
    return await validate(captured, value)
  }

  return Object.freeze({ contentType: "application/json", encode, decode })
}
