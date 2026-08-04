import type { Context } from "@go-like/context"

import type { ConfigObject, ConfigSource, ConfigSourceSnapshot } from "./config"
import { frozenClone } from "./value"

/** Creates a stable in-memory source from a deeply copied and frozen configuration object. */
export function objectSource(name: string, value: ConfigObject): ConfigSource {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("configuration source name must be non-empty")
  }
  const stable = frozenClone(value)
  if (Array.isArray(stable)) throw new TypeError("configuration source root must be an object")
  const snapshot: ConfigSourceSnapshot = Object.freeze({ value: stable, revision: null })
  return Object.freeze({
    name,
    /** Returns the construction-time immutable source document for every requested Context. */
    load(_ctx: Context): Promise<ConfigSourceSnapshot> {
      return Promise.resolve(snapshot)
    }
  })
}
