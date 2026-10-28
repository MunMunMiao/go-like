import { objectSource, type ConfigObject, type ConfigSource, type ConfigValue } from "./config"

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>

/** Decodes one selected environment string into a configuration value. */
export type EnvValueDecoder = (
  value: string,
  environmentName: string,
  path: readonly string[]
) => ConfigValue

export interface EnvSourceOptions {
  readonly name?: string
  readonly prefix?: string
  readonly separator?: string
  readonly lowercase?: boolean
  /** Decodes a selected value; omitted values remain strings. */
  readonly decode?: EnvValueDecoder
}

interface EnvEntry {
  readonly path: readonly string[]
  readonly value: ConfigValue
}

interface EnvNode {
  readonly children: Map<string, EnvNode>
  value: ConfigValue
  occupied: boolean
}

const UnsafeSegments = new Set(["__proto__", "constructor", "prototype"])

/** Returns the default environment value without guessing booleans or numbers. */
function identityValue(
  value: string,
  _environmentName: string,
  _path: readonly string[]
): ConfigValue {
  return value
}

/** Creates one empty path trie node used to reject ambiguous mappings. */
function newNode(): EnvNode {
  return { children: new Map(), value: null, occupied: false }
}

/** Appends one path segment without spread syntax or mutation of the captured path. */
function appendPath(path: readonly string[], segment: string): readonly string[] {
  const appended = path.slice()
  appended.push(segment)
  return appended
}

/** Deeply copies one runtime callback value into the supported immutable config domain. */
function copyConfigValue(
  value: unknown,
  active: Set<object>,
  path: readonly string[]
): ConfigValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`invalid environment value at ${path.join(".")}`)
    return value
  }
  if (typeof value !== "object")
    throw new TypeError(`invalid environment value at ${path.join(".")}`)
  if (active.has(value)) throw new TypeError(`cyclic environment value at ${path.join(".")}`)
  active.add(value)
  if (Array.isArray(value)) {
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1
    ) {
      active.delete(value)
      throw new TypeError(`invalid environment value at ${path.join(".")}`)
    }
    const result: ConfigValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        active.delete(value)
        throw new TypeError(`invalid environment value at ${path.join(".")}`)
      }
      result.push(copyConfigValue(descriptor.value, active, appendPath(path, String(index))))
    }
    active.delete(value)
    return Object.freeze(result)
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    active.delete(value)
    throw new TypeError(`invalid environment value at ${path.join(".")}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    active.delete(value)
    throw new TypeError(`invalid environment value at ${path.join(".")}`)
  }
  const result: Record<string, ConfigValue> = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    if (UnsafeSegments.has(key)) {
      active.delete(value)
      throw new TypeError(`unsafe environment value key at ${appendPath(path, key).join(".")}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      active.delete(value)
      throw new TypeError(`invalid environment value at ${appendPath(path, key).join(".")}`)
    }
    result[key] = copyConfigValue(descriptor.value, active, appendPath(path, key))
  }
  active.delete(value)
  return Object.freeze(result)
}

/** Splits and validates one selected environment name into its configuration path. */
function environmentPath(
  environmentName: string,
  prefix: string,
  separator: string,
  lowercase: boolean
): readonly string[] | null {
  if (!environmentName.startsWith(prefix)) return null
  const suffix = environmentName.slice(prefix.length)
  if (suffix.length === 0) return null
  const rawSegments = suffix.split(separator)
  const segments: string[] = []
  for (const rawSegment of rawSegments) {
    if (rawSegment.length === 0)
      throw new TypeError("environment key contains an empty path segment")
    const segment = lowercase ? rawSegment.toLowerCase() : rawSegment
    if (UnsafeSegments.has(segment.toLowerCase())) throw new TypeError("unsafe environment path")
    segments.push(segment)
  }
  return Object.freeze(segments)
}

/** Inserts one decoded entry and rejects duplicates or scalar/object path conflicts. */
function insertEntry(root: EnvNode, entry: EnvEntry): void {
  let node = root
  for (const segment of entry.path) {
    if (node.occupied) throw new TypeError("environment paths conflict")
    let child = node.children.get(segment)
    if (child === undefined) {
      child = newNode()
      node.children.set(segment, child)
    }
    node = child
  }
  if (node.occupied) throw new TypeError("duplicate environment path")
  node.value = entry.value
  node.occupied = true
}

/** Orders materialized trie entries by their public configuration key. */
function compareEntries(
  left: readonly [string, EnvNode],
  right: readonly [string, EnvNode]
): number {
  return left[0].localeCompare(right[0])
}

/** Materializes one validated trie into a plain configuration object. */
function materializeNode(node: EnvNode): ConfigObject {
  const output: Record<string, ConfigValue> = {}
  const entries = Array.from(node.children.entries()).sort(compareEntries)
  for (const entry of entries) {
    const key = entry[0]
    const child = entry[1]
    if (child.occupied) {
      output[key] = child.value
    } else {
      output[key] = materializeNode(child)
    }
  }
  return Object.freeze(output)
}

/**
 * Creates a stable configuration source from an explicitly supplied environment record.
 *
 * The adapter never reads a runtime global. Selected keys are captured, normalized, decoded,
 * validated, and deeply copied during construction.
 */
export function envSource(
  environment: EnvironmentRecord,
  options: EnvSourceOptions = {}
): ConfigSource {
  if (environment === null || typeof environment !== "object") {
    throw new TypeError("environment record must be an object")
  }
  const name = options.name ?? "env"
  const prefix = options.prefix ?? ""
  const separator = options.separator ?? "__"
  const lowercase = options.lowercase ?? true
  const decode = options.decode ?? identityValue
  if (typeof name !== "string" || name.length === 0)
    throw new TypeError("environment source name must be non-empty")
  if (typeof prefix !== "string") throw new TypeError("environment prefix must be a string")
  if (typeof separator !== "string" || separator.length === 0) {
    throw new TypeError("environment separator must be non-empty")
  }
  if (typeof lowercase !== "boolean")
    throw new TypeError("environment lowercase option must be boolean")
  if (typeof decode !== "function") throw new TypeError("environment decoder must be callable")

  const entries: EnvEntry[] = []
  const names = Object.keys(environment).sort()
  for (const environmentName of names) {
    const path = environmentPath(environmentName, prefix, separator, lowercase)
    if (path === null) continue
    const descriptor = Object.getOwnPropertyDescriptor(environment, environmentName)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("environment record must contain only data properties")
    }
    const rawValue: unknown = descriptor.value
    if (rawValue === undefined) continue
    if (typeof rawValue !== "string")
      throw new TypeError("environment values must be strings or undefined")
    const decoded: unknown = decode(rawValue, environmentName, path)
    entries.push({ path, value: copyConfigValue(decoded, new Set(), path) })
  }

  const root = newNode()
  for (const entry of entries) insertEntry(root, entry)
  return objectSource(name, materializeNode(root))
}
