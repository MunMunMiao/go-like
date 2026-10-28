import type { ConfigObject, ConfigValue } from "./config"

/** Tests whether a runtime value is an ordinary object accepted by the config boundary. */
export function isConfigObject(value: unknown): value is ConfigObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Tests whether a property name can mutate or confuse an ordinary output object. */
export function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor"
}

/** Copies one JSON-like value while rejecting accessors, cycles, holes, symbols, and exotic values. */
export function cloneValue(value: unknown, path: readonly string[] = []): ConfigValue {
  return cloneValueSeen(value, path, new WeakSet<object>())
}

/** Recursively copies an admitted value while tracking only its active ancestry for cycle detection. */
function cloneValueSeen(
  value: unknown,
  path: readonly string[],
  active: WeakSet<object>
): ConfigValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value
    throw new TypeError(`invalid configuration number at ${formatPath(path)}`)
  }
  if (typeof value !== "object")
    throw new TypeError(`invalid configuration value at ${formatPath(path)}`)
  if (active.has(value)) throw new TypeError(`cyclic configuration value at ${formatPath(path)}`)
  active.add(value)
  try {
    if (Array.isArray(value)) return cloneArray(value, path, active)
    if (isConfigObject(value)) return cloneObject(value, path, active)
    throw new TypeError(`invalid configuration object at ${formatPath(path)}`)
  } finally {
    active.delete(value)
  }
}

/** Copies an array only when its complete own-property shape is dense and data-only. */
function cloneArray(
  value: readonly unknown[],
  path: readonly string[],
  active: WeakSet<object>
): readonly ConfigValue[] {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`configuration array contains a symbol at ${formatPath(path)}`)
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes("length")) {
    throw new TypeError(`configuration array has an unsupported property at ${formatPath(path)}`)
  }
  const output: ConfigValue[] = []
  for (let index = 0; index < value.length; index += 1) {
    const segment = String(index)
    const descriptor = Object.getOwnPropertyDescriptor(value, segment)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `invalid configuration array entry at ${formatPath(path.concat(segment))}`
      )
    }
    output.push(cloneValueSeen(descriptor.value, path.concat(segment), active))
  }
  return output
}

/** Copies every own string data property of an ordinary object without invoking accessors. */
function cloneObject(
  value: ConfigObject,
  path: readonly string[],
  active: WeakSet<object>
): ConfigObject {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`configuration object contains a symbol at ${formatPath(path)}`)
  }
  const output: { [key: string]: ConfigValue } = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    const propertyPath = path.concat(key)
    if (isUnsafeKey(key))
      throw new TypeError(`unsafe configuration key at ${formatPath(propertyPath)}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`invalid configuration property at ${formatPath(propertyPath)}`)
    }
    output[key] = cloneValueSeen(descriptor.value, propertyPath, active)
  }
  return output
}

/** Formats a structural location without including the value found there. */
function formatPath(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".")
}

/** Deeply freezes an admitted JSON-like value and returns its continuous input type. */
export function freezeValue<T extends ConfigValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeValue(item)
  } else if (isConfigObject(value)) {
    for (const item of Object.values(value)) freezeValue(item)
  }
  return Object.freeze(value)
}

/** Validates, independently clones, re-admits, and deeply freezes a JSON-like value. */
export function frozenClone<T extends ConfigValue>(value: T): T {
  cloneValue(value)
  const cloned = structuredClone(value)
  cloneValue(cloned)
  return freezeValue(cloned)
}
