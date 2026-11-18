import type { ConfigObject, ConfigValue } from "./config"
import { cloneValue, isConfigObject } from "./value"

/** Merges source documents in order into an independent ordinary object. */
export function mergeObjects(values: readonly ConfigObject[]): ConfigObject {
  let result: ConfigObject = {}
  for (const value of values) result = mergeObjectPair(result, value, [])
  return result
}

/** Merges two ordinary objects recursively, replacing every non-object value as a complete unit. */
function mergeObjectPair(
  left: ConfigObject,
  right: ConfigObject,
  path: readonly string[]
): ConfigObject {
  const output: { [key: string]: ConfigValue } = {}
  copyMissing(output, left, path)
  for (const [key, incoming] of Object.entries(right)) {
    const propertyPath = path.concat(key)
    const current = output[key]
    if (current !== undefined && isConfigObject(current) && isConfigObject(incoming)) {
      output[key] = mergeObjectPair(current, incoming, propertyPath)
    } else {
      output[key] = cloneValue(incoming, propertyPath)
    }
  }
  return output
}

/** Copies all left-hand keys before later sources recursively override them. */
function copyMissing(
  output: { [key: string]: ConfigValue },
  value: ConfigObject,
  path: readonly string[]
): void {
  for (const [key, incoming] of Object.entries(value)) {
    output[key] = cloneValue(incoming, path.concat(key))
  }
}
