import { withValue, type Context } from "@go-like/context"

/** Accepts one metadata value or an ordered group of values for the same key. */
export type MetadataValue = string | readonly string[]

/** Describes caller-owned metadata input before validation and normalization. */
export type MetadataInput = Readonly<Record<string, MetadataValue>>

/** Holds an immutable lower-case metadata snapshot with ordered multi-values. */
export type Metadata = Readonly<Record<string, readonly string[]>>

/** Selects server metadata keys that may be copied into one downstream client Context. */
export interface PropagationOptions {
  /** Matches complete normalized metadata keys. */
  readonly exact?: readonly string[]
  /** Matches normalized metadata keys beginning with one of these prefixes. */
  readonly prefix?: readonly string[]
}

const MetadataBrand = new WeakSet<object>()
const EmptyValues: readonly string[] = Object.freeze([])
const clientContextKey = Object.freeze({})
const serverContextKey = Object.freeze({})

interface MetadataBuilder {
  readonly entries: Map<string, string[]>
}

interface PropagationRules {
  readonly exact: ReadonlySet<string>
  readonly prefix: readonly string[]
}

/** Reports whether value is a non-array object suitable for record inspection. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Returns whether value contains only complete UTF-16 scalar sequences. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Validates and lower-cases one provider-neutral metadata key. */
function normalizeKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError("metadata key must be a non-empty well-formed string")
  }
  return value.toLowerCase()
}

/** Validates one provider-neutral metadata value. */
function metadataValue(value: unknown): string {
  if (typeof value !== "string" || !isWellFormed(value)) {
    throw new TypeError("metadata value must be a well-formed string")
  }
  return value
}

/** Copies and validates one single or ordered multi-value input. */
function snapshotValues(value: unknown): readonly string[] {
  if (typeof value === "string") return Object.freeze([metadataValue(value)])
  if (!Array.isArray(value)) {
    throw new TypeError("metadata entry must be a string or a string array")
  }
  if (
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError("metadata value array must be dense and contain only indexed values")
  }
  const copied: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("metadata value array must contain only data values")
    }
    copied.push(metadataValue(descriptor.value))
  }
  return Object.freeze(copied)
}

/** Creates an empty metadata builder. */
function newBuilder(): MetadataBuilder {
  return { entries: new Map() }
}

/** Adds or replaces one normalized entry. */
function updateBuilder(
  builder: MetadataBuilder,
  key: string,
  values: readonly string[],
  replace: boolean
): void {
  const current = builder.entries.get(key)
  const next = replace || current === undefined ? [] : current.slice()
  for (const value of values) next.push(value)
  builder.entries.set(key, next)
}

/** Validates one input record and appends every normalized value to a new builder. */
function builderFromInput(input: unknown): MetadataBuilder {
  if (!isRecord(input)) throw new TypeError("metadata must be a plain record")
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("metadata must be a plain record")
  }
  if (Object.getOwnPropertySymbols(input).length !== 0) {
    throw new TypeError("metadata must contain only string keys")
  }
  const builder = newBuilder()
  for (const rawKey of Object.keys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, rawKey)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("metadata must contain only data properties")
    }
    updateBuilder(builder, normalizeKey(rawKey), snapshotValues(descriptor.value), false)
  }
  return builder
}

/** Freezes one builder into a deterministic metadata snapshot. */
function freezeBuilder(builder: MetadataBuilder): Metadata {
  const entries: [string, readonly string[]][] = []
  const keys = Array.from(builder.entries.keys()).sort()
  for (const key of keys) {
    const values = builder.entries.get(key)
    if (values === undefined) continue
    entries.push([key, Object.freeze(values.slice())])
  }
  const snapshot: Metadata = Object.freeze(Object.fromEntries(entries))
  MetadataBrand.add(snapshot)
  return snapshot
}

/** Returns a validated metadata snapshot, copying unbranded structural inputs. */
function validated(metadata: Metadata): Metadata {
  const candidate: unknown = metadata
  if (isRecord(candidate) && MetadataBrand.has(candidate)) return metadata
  return newMetadata(metadata)
}

/** Copies one metadata snapshot into a mutable builder. */
function builderFromMetadata(metadata: Metadata): MetadataBuilder {
  const snapshot = validated(metadata)
  const builder = newBuilder()
  for (const key of Object.keys(snapshot)) {
    const stored = snapshot[key]
    if (stored !== undefined) updateBuilder(builder, key, stored, true)
  }
  return builder
}

/** Returns whether value is a metadata snapshot created by this package. */
function isStoredMetadata(value: unknown): value is Metadata {
  return isRecord(value) && MetadataBrand.has(value)
}

/** Reads one package-owned metadata domain from Context. */
function contextMetadata(ctx: Context, key: object): Metadata | null {
  const value = ctx.value(key)
  return isStoredMetadata(value) ? value : null
}

/** Validates and lower-cases one explicit propagation rule. */
function propagationRule(value: unknown, kind: "exact" | "prefix"): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError(`metadata propagation ${kind} rule must be a non-empty well-formed string`)
  }
  return value.toLowerCase()
}

/** Copies one dense array of propagation rules without executing accessors. */
function propagationRuleList(value: unknown, kind: "exact" | "prefix"): readonly string[] {
  if (value === undefined) return EmptyValues
  if (
    !Array.isArray(value) ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`metadata propagation ${kind} rules must be a dense string array`)
  }
  const rules: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`metadata propagation ${kind} rules must contain only data values`)
    }
    rules.push(propagationRule(descriptor.value, kind))
  }
  return Object.freeze(rules)
}

/** Validates and snapshots one propagation options record. */
function propagationRules(options: PropagationOptions | undefined): PropagationRules {
  if (options === undefined) {
    return { exact: new Set(), prefix: EmptyValues }
  }
  if (!isRecord(options)) throw new TypeError("metadata propagation options must be a plain record")
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("metadata propagation options must be a plain record")
  }
  if (Object.getOwnPropertySymbols(options).length !== 0) {
    throw new TypeError("metadata propagation options must contain only string keys")
  }
  for (const key of Object.keys(options)) {
    if (key !== "exact" && key !== "prefix") {
      throw new TypeError(`unknown metadata propagation option: ${key}`)
    }
  }
  const exact = Object.getOwnPropertyDescriptor(options, "exact")
  const prefix = Object.getOwnPropertyDescriptor(options, "prefix")
  if (
    (exact !== undefined && !("value" in exact)) ||
    (prefix !== undefined && !("value" in prefix))
  ) {
    throw new TypeError("metadata propagation options must contain only data properties")
  }
  return {
    exact: new Set(propagationRuleList(exact?.value, "exact")),
    prefix: propagationRuleList(prefix?.value, "prefix")
  }
}

/** Reports whether one normalized metadata key is selected by explicit rules. */
function matchesPropagationRule(key: string, rules: PropagationRules): boolean {
  if (rules.exact.has(key)) return true
  for (const prefix of rules.prefix) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

/** Creates an immutable normalized metadata snapshot. */
export function newMetadata(input: MetadataInput = Object.freeze({})): Metadata {
  return freezeBuilder(builderFromInput(input))
}

/** Returns a detached immutable copy of metadata. */
export function clone(metadata: Metadata): Metadata {
  return freezeBuilder(builderFromMetadata(metadata))
}

/** Returns the first value for key, or null when key is absent. */
export function get(metadata: Metadata, key: string): string | null {
  return values(metadata, key)[0] ?? null
}

/** Returns every ordered value for key, or a shared empty immutable array. */
export function values(metadata: Metadata, key: string): readonly string[] {
  return validated(metadata)[normalizeKey(key)] ?? EmptyValues
}

/** Returns normalized keys in deterministic order. */
export function keys(metadata: Metadata): readonly string[] {
  return Object.freeze(Object.keys(validated(metadata)))
}

/** Returns a snapshot with values appended to key without mutating metadata. */
export function append(metadata: Metadata, key: string, value: MetadataValue): Metadata {
  const builder = builderFromMetadata(metadata)
  updateBuilder(builder, normalizeKey(key), snapshotValues(value), false)
  return freezeBuilder(builder)
}

/** Returns a snapshot where key contains exactly one value. */
export function set(metadata: Metadata, key: string, value: string): Metadata {
  const builder = builderFromMetadata(metadata)
  updateBuilder(builder, normalizeKey(key), Object.freeze([metadataValue(value)]), true)
  return freezeBuilder(builder)
}

/** Returns a snapshot without key. */
export function remove(metadata: Metadata, key: string): Metadata {
  const builder = builderFromMetadata(metadata)
  builder.entries.delete(normalizeKey(key))
  return freezeBuilder(builder)
}

/** Returns a snapshot where patch replaces matching keys and preserves other keys. */
export function merge(metadata: Metadata, patch: Metadata): Metadata {
  const builder = builderFromMetadata(metadata)
  const patchSnapshot = validated(patch)
  for (const key of Object.keys(patchSnapshot)) {
    const stored = patchSnapshot[key]
    if (stored !== undefined) updateBuilder(builder, key, stored, true)
  }
  return freezeBuilder(builder)
}

/** Returns a child Context carrying an isolated client metadata snapshot. */
export function newClientContext(ctx: Context, metadata: Metadata): Context {
  return withValue(ctx, clientContextKey, clone(metadata))
}

/** Returns client metadata carried by ctx, or null when none is present. */
export function fromClientContext(ctx: Context): Metadata | null {
  return contextMetadata(ctx, clientContextKey)
}

/** Returns a child Context with ordered key/value pairs set on client metadata. */
export function appendToClientContext(ctx: Context, ...keyValues: readonly string[]): Context {
  if (keyValues.length % 2 !== 0) {
    throw new TypeError("appendToClientContext requires key/value pairs")
  }
  let metadata = fromClientContext(ctx) ?? newMetadata()
  for (let index = 0; index < keyValues.length; index += 2) {
    metadata = set(metadata, normalizeKey(keyValues[index]), metadataValue(keyValues[index + 1]))
  }
  return newClientContext(ctx, metadata)
}

/** Returns a child Context with patch merged into its client metadata. */
export function mergeToClientContext(ctx: Context, patch: Metadata): Context {
  return newClientContext(ctx, merge(fromClientContext(ctx) ?? newMetadata(), patch))
}

/** Returns a child Context carrying an isolated server metadata snapshot. */
export function newServerContext(ctx: Context, metadata: Metadata): Context {
  return withValue(ctx, serverContextKey, clone(metadata))
}

/** Returns server metadata carried by ctx, or null when none is present. */
export function fromServerContext(ctx: Context): Metadata | null {
  return contextMetadata(ctx, serverContextKey)
}

/**
 * Copies explicitly selected server metadata into a downstream client Context.
 *
 * Existing client metadata wins on key conflicts. With no rules, no server metadata, or no new
 * matches, the original Context is returned unchanged.
 */
export function propagateToClientContext(ctx: Context, options?: PropagationOptions): Context {
  const rules = propagationRules(options)
  if (rules.exact.size === 0 && rules.prefix.length === 0) return ctx
  const server = fromServerContext(ctx)
  if (server === null) return ctx
  const client = fromClientContext(ctx)
  const builder = client === null ? newBuilder() : builderFromMetadata(client)
  let propagated = false
  for (const key of Object.keys(server)) {
    if (builder.entries.has(key) || !matchesPropagationRule(key, rules)) continue
    const stored = server[key]
    if (stored === undefined) continue
    updateBuilder(builder, key, stored, true)
    propagated = true
  }
  return propagated ? newClientContext(ctx, freezeBuilder(builder)) : ctx
}
