import { admitConfigObject } from "./value"
import type { ConfigObject } from "./config"

/** Decodes strict JSON whose root is a safe configuration object. `origin` names the TypeError. */
export function jsonDecoder(text: string, origin: string): ConfigObject {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`file "${origin}" must contain a JSON object`)
  }
  return admitConfigObject(value, origin)
}
