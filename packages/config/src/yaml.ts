import { CORE_SCHEMA, loadAll } from "js-yaml/browser"

import type { ConfigObject, ConfigValue } from "./config"
import { cloneValue, isConfigObject } from "./value"

/** Rejects YAML integers that cannot be represented exactly in the ConfigValue number domain. */
function requireSafeIntegers(value: ConfigValue): void {
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError("YAML configuration contains an integer outside the safe number range")
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) requireSafeIntegers(item)
    return
  }
  if (isConfigObject(value)) {
    for (const item of Object.values(value)) requireSafeIntegers(item)
  }
}

/** Decodes one strict YAML 1.2 object document into the portable configuration value domain. */
export function decodeYaml(input: string): ConfigObject {
  if (typeof input !== "string") throw new TypeError("YAML configuration input must be a string")

  let documents: unknown[]
  try {
    documents = loadAll(input, {
      json: false,
      maxAliases: 0,
      schema: CORE_SCHEMA
    })
  } catch {
    throw new TypeError("YAML configuration contains unsupported or invalid syntax")
  }
  if (documents.length !== 1) {
    throw new TypeError("YAML configuration must contain exactly one document")
  }

  const decoded = documents[0]
  const stable = cloneValue(decoded)
  requireSafeIntegers(stable)
  if (!isConfigObject(stable)) {
    throw new TypeError("YAML configuration root must be an object")
  }
  return stable
}
