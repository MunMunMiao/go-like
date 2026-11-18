import { CORE_SCHEMA, loadAll } from "js-yaml/browser"

import type { ConfigObject } from "@go-like/core/config"
import { admitConfigObject } from "@go-like/core/config/provider"

/** Rejects YAML integers that cannot be represented exactly in the ConfigValue number domain. */
function requireSafeIntegers(value: unknown): void {
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
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) requireSafeIntegers(item)
  }
}

/** Decodes one strict YAML 1.2 object document into the portable configuration value domain. */
export function decodeYaml(text: string, origin: string): ConfigObject {
  if (typeof text !== "string") throw new TypeError("YAML configuration input must be a string")
  if (typeof origin !== "string" || origin.length === 0 || !origin.isWellFormed()) {
    throw new TypeError("YAML configuration origin must be a non-empty string")
  }

  let documents: unknown[]
  try {
    documents = loadAll(text, {
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

  const decoded: unknown = documents[0]
  requireSafeIntegers(decoded)
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError("YAML configuration root must be an object")
  }
  return admitConfigObject(decoded, origin)
}
