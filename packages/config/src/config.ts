import { background, cause, withCancelCause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import type { StandardSchemaV1 } from "@standard-schema/spec"

import {
  aggregateFailures,
  newAlreadyLoadedError,
  newNotFoundError,
  newSourceError,
  normalizeError
} from "./errors"
import { mergeObjects } from "./merge"
import { objectSource as createObjectSource } from "./source"
import { captureSchema, validateConfig } from "./validation"
import { frozenClone, isConfigObject, isUnsafeKey } from "./value"

export type ConfigScalar = null | boolean | number | string
export type ConfigValue = ConfigScalar | ConfigObject | readonly ConfigValue[]

export interface ConfigObject {
  readonly [key: string]: ConfigValue
}

export interface ConfigSourceSnapshot {
  readonly value: ConfigObject
  readonly revision: string | null
}

export interface ConfigSourceWatcher {
  /** Waits until the adapter has coalesced one pending source change. */
  next(ctx: Context): Promise<void>
  /** Stops the source watcher and releases its resources. */
  stop(ctx: Context): Promise<void>
}

export interface ConfigSource {
  readonly name: string
  /** Loads one complete source document for the supplied operation Context. */
  load(ctx: Context): Promise<ConfigSourceSnapshot>
  /** Opens a source-owned change watcher from the supplied candidate revision. */
  readonly watch?: (ctx: Context, revision: string | null) => Promise<ConfigSourceWatcher>
}

interface ConfigSourceRevision {
  readonly name: string
  readonly revision: string | null
}

interface ConfigPublication<T extends ConfigValue = ConfigObject> {
  readonly version: number
  readonly value: T
  readonly sources: readonly ConfigSourceRevision[]
}

export type ConfigSchema<T extends ConfigValue> = StandardSchemaV1<ConfigObject, T>

/** Resolves one complete merged configuration before schema validation and publication. */
export type ConfigResolver = (
  ctx: Context,
  value: ConfigObject
) => ConfigObject | PromiseLike<ConfigObject>

/** Reads and validates one Kratos-style configuration value. */
export interface Value {
  /** Returns the current immutable value, or null when the path is absent. */
  load(): ConfigValue | null
  /** Validates the current value through a Standard Schema under the caller's Context. */
  scan<Input extends ConfigValue, Output extends ConfigValue>(
    ctx: Context,
    schema: StandardSchemaV1<Input, Output>
  ): Promise<Output>
}

/** Observes one semantic change to a watched Kratos-style dotted path. */
export type Observer = (key: string, value: Value) => void

/** Observes one recoverable background reload failure without owning the reload lifecycle. */
export type ConfigReloadErrorHandler = (error: Error, current: ConfigValue | null) => void

/** Observes the first unrecoverable background failure after initial readiness. */
export type ConfigTerminalErrorHandler = (error: Error) => void | PromiseLike<void>

declare const configOutput: unique symbol

export interface Config<T extends ConfigValue = ConfigObject> {
  readonly [configOutput]?: T
  /** Loads every source, accepts its watchers, and publishes the initial configuration. */
  load(ctx: Context): Promise<void>
  /** Validates the complete current configuration through a Standard Schema. */
  scan<Input extends ConfigValue, Output extends ConfigValue>(
    ctx: Context,
    schema: StandardSchemaV1<Input, Output>
  ): Promise<Output>
  /** Returns a live view of one Kratos-style dotted path. */
  value(key: string): Value
  /** Watches one existing dotted path. A later watch for the same key replaces the observer. */
  watch(key: string, observer: Observer): void
  /** Stops every accepted source watcher and waits for resource release. */
  close(ctx: Context): Promise<void>
}

export interface ConfigAlreadyLoadedError extends Error {
  readonly name: "ConfigAlreadyLoadedError"
  readonly code: "GO_LIKE_CONFIG_ALREADY_LOADED"
  readonly status: "loading" | "loaded" | "closing" | "closed" | "failed"
}

export interface ConfigSourceError extends Error {
  readonly name: "ConfigSourceError"
  readonly code: "GO_LIKE_CONFIG_SOURCE"
  readonly sourceName: string
  readonly phase: "load" | "watch" | "next" | "stop"
}

export interface ConfigNotFoundError extends Error {
  readonly name: "ConfigNotFoundError"
  readonly code: "GO_LIKE_CONFIG_NOT_FOUND"
  readonly key: string
}

export interface ConfigValidationError extends Error {
  readonly name: "ConfigValidationError"
  readonly code: "GO_LIKE_CONFIG_VALIDATION"
  readonly reason: "issues" | "threw" | "malformed-result" | "invalid-output"
  readonly issues: readonly StandardSchemaV1.Issue[]
}

interface CapturedSource {
  readonly name: string
  readonly receiver: ConfigSource
  readonly load: ConfigSource["load"]
  readonly watch: ConfigSource["watch"]
}

interface PreparedConfig {
  readonly value: ConfigValue
  readonly rawValue: ConfigObject | null
  readonly sources: readonly ConfigSourceRevision[]
  readonly watchTargets: readonly WatchTarget[]
}

interface WatchTarget {
  readonly source: CapturedSource
  readonly revision: string | null
}

interface ObserverRecord {
  readonly key: string
  readonly path: readonly string[]
  readonly observer: Observer
  readonly value: Value
  current: ConfigValue
}

type LifecycleState = "idle" | "loading" | "loaded" | "closing" | "closed" | "failed"

const reloadRetryInitialMs = 250
const reloadRetryMaximumMs = 30_000

interface WatcherRuntime {
  readonly sourceName: string
  readonly receiver: ConfigSourceWatcher
  readonly next: ConfigSourceWatcher["next"]
  readonly stop: ConfigSourceWatcher["stop"]
  loop: Promise<void> | null
  stopStarted: boolean
}

interface ConfigSettings {
  sources: readonly CapturedSource[]
  resolvers: readonly ConfigResolver[]
  schema: ReturnType<typeof captureSchema<ConfigObject, ConfigValue>> | null
  reloadErrorHandler: ConfigReloadErrorHandler | null
  terminalErrorHandler: ConfigTerminalErrorHandler | null
}

declare const configOptionOutput: unique symbol

/**
 * Applies one Go-style construction option.
 *
 * The optional symbol only carries the output type selected by `schema`; it has no runtime shape.
 */
export type ConfigOption<T extends ConfigValue = never> = ((settings: ConfigSettings) => void) & {
  readonly [configOptionOutput]?: T
}

type ConfigOptionOutput<Option> = Option extends ConfigOption<infer Output> ? Output : never

type ConfigOutput<Options extends readonly ConfigOption<ConfigValue>[]> = [
  ConfigOptionOutput<Options[number]>
] extends [never]
  ? ConfigObject
  : ConfigOptionOutput<Options[number]>

/** Captures and validates every source capability so later caller mutation cannot replace it. */
function captureSources(sources: readonly ConfigSource[]): readonly CapturedSource[] {
  try {
    const names = new Set<string>()
    const captured: CapturedSource[] = []
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]
      if (source === undefined || source === null || typeof source !== "object") {
        throw new TypeError("invalid configuration source")
      }
      const name = source.name
      const load = source.load
      const watch = source.watch
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        names.has(name) ||
        typeof load !== "function" ||
        (watch !== undefined && typeof watch !== "function")
      ) {
        throw new TypeError("invalid configuration source")
      }
      names.add(name)
      captured.push(Object.freeze({ name, receiver: source, load, watch }))
    }
    return Object.freeze(captured)
  } catch {
    throw new TypeError("invalid configuration sources")
  }
}

/** Configures the complete ordered source list, matching Kratos `WithSource`. */
export function source(
  /** go-like-typed-rest: preserves the Go-style functional-option ABI. */
  ...sources: readonly ConfigSource[]
): ConfigOption {
  const captured = captureSources(sources)
  /** Applies the already-captured ordered source list. */
  function applySource(settings: ConfigSettings): void {
    settings.sources = captured
  }
  return applySource
}

/** Validates and transforms every publication through one Standard Schema. */
export function schema<T extends ConfigValue>(value: ConfigSchema<T>): ConfigOption<T> {
  const captured = captureSchema(value)
  /** Applies the already-captured Standard Schema. */
  function applySchema(settings: ConfigSettings): void {
    settings.schema = captured
  }
  return applySchema
}

/** Appends one explicit post-merge resolver before schema validation. */
export function resolver(value: ConfigResolver): ConfigOption {
  if (typeof value !== "function") throw new TypeError("configuration resolver must be callable")
  /** Appends the already-validated resolver without retaining a mutable option list. */
  function applyResolver(settings: ConfigSettings): void {
    settings.resolvers = Object.freeze(settings.resolvers.concat(value))
  }
  return applyResolver
}

/** Observes recoverable background reload failures without owning the watcher lifecycle. */
export function onReloadError(handler: ConfigReloadErrorHandler): ConfigOption {
  if (typeof handler !== "function")
    throw new TypeError("configuration reload error handler must be callable")
  /** Applies the already-validated reload-error observer. */
  function applyReloadErrorHandler(settings: ConfigSettings): void {
    settings.reloadErrorHandler = handler
  }
  return applyReloadErrorHandler
}

/** Observes the first unrecoverable post-load watcher failure before owner drain begins. */
export function onTerminalError(handler: ConfigTerminalErrorHandler): ConfigOption {
  if (typeof handler !== "function")
    throw new TypeError("configuration terminal error handler must be callable")
  /** Applies the already-validated terminal-error observer. */
  function applyTerminalErrorHandler(settings: ConfigSettings): void {
    settings.terminalErrorHandler = handler
  }
  return applyTerminalErrorHandler
}

/** Returns the caller's specific cancellation cause when its Context is terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  if (failure === null) return null
  return cause(ctx) ?? failure
}

/** Rejects at an operation boundary when its owning Context has been canceled. */
function throwIfCanceled(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Converts a source rejection unless caller cancellation had already won the operation. */
function sourceFailure(
  ctx: Context,
  sourceName: string,
  phase: ConfigSourceError["phase"],
  value: unknown
): Error {
  return contextFailure(ctx) ?? newSourceError(sourceName, phase, value)
}

/** Makes a fulfilled scheduler result contribute only a completion barrier. */
function ignoreScheduledValue(_value: unknown): void {}

/** Makes a rejected scheduler result contribute only a completion barrier. */
function ignoreScheduledFailure(_error: unknown): void {}

/** Observes a hook rejection so application callbacks cannot create unhandled rejections. */
function ignoreHookFailure(_error: unknown): void {}

/** Identifies only the private Error object reserved for intentional runtime shutdown. */
function isIntentionalStopFailure(error: unknown, identity: Error): boolean {
  if (error === identity) return true
  return error instanceof Error && error.cause === identity
}

/** Reports whether one string contains only paired UTF-16 surrogate code units. */
function isWellFormedKey(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Captures one Kratos-style dotted key while retaining go-like's unsafe-key boundary. */
function capturePath(key: string): readonly string[] {
  if (typeof key !== "string" || key.length === 0 || !isWellFormedKey(key)) {
    throw new TypeError("invalid configuration key")
  }
  const path = key.split(".")
  for (const segment of path) {
    if (segment.length === 0 || isUnsafeKey(segment)) {
      throw new TypeError("invalid configuration key")
    }
  }
  return Object.freeze(path)
}

interface PlaceholderParts {
  readonly key: string
  readonly defaultValue: string | null
}

type SelectedValue =
  | { readonly found: false }
  | { readonly found: true; readonly value: ConfigValue }

/** Selects one object-only dotted path without interpreting array indices. */
function selectValue(value: ConfigValue, path: readonly string[]): SelectedValue {
  let selected = value
  for (const segment of path) {
    if (!isConfigObject(selected)) return Object.freeze({ found: false })
    const descriptor = Object.getOwnPropertyDescriptor(selected, segment)
    if (descriptor === undefined || !("value" in descriptor)) {
      return Object.freeze({ found: false })
    }
    selected = descriptor.value
  }
  return Object.freeze({ found: true, value: selected })
}

/** Creates one stable secret-safe placeholder failure. */
function placeholderFailure(reason: "cycle" | "invalid" | "missing" | "non-string"): TypeError {
  if (reason === "cycle") return new TypeError("configuration placeholder cycle detected")
  if (reason === "missing") return new TypeError("configuration placeholder is missing")
  if (reason === "non-string")
    return new TypeError("configuration placeholder must reference a string")
  return new TypeError("invalid configuration placeholder")
}

/** Finds the matching closing brace for one placeholder, including nested defaults. */
function placeholderEnd(value: string, start: number): number {
  let depth = 1
  let index = start + 2
  while (index < value.length) {
    if (value.startsWith("${", index)) {
      depth += 1
      index += 2
      continue
    }
    if (value[index] === "}") {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

/** Splits one placeholder body at its first top-level default delimiter. */
function placeholderParts(value: string): PlaceholderParts {
  const delimiter = value.indexOf(":")
  const key = delimiter === -1 ? value : value.slice(0, delimiter)
  if (key.includes("${") || key.includes("}")) throw placeholderFailure("invalid")
  try {
    capturePath(key)
  } catch {
    throw placeholderFailure("invalid")
  }
  return Object.freeze({
    key,
    defaultValue: delimiter === -1 ? null : value.slice(delimiter + 1)
  })
}

/** Resolves one referenced string or its explicit default against the merged root. */
function resolveReference(
  root: ConfigObject,
  parts: PlaceholderParts,
  stack: readonly string[]
): string {
  const selected = selectValue(root, capturePath(parts.key))
  if (!selected.found) {
    if (parts.defaultValue === null) throw placeholderFailure("missing")
    return resolvePlaceholderString(root, parts.defaultValue, stack)
  }
  if (typeof selected.value !== "string") throw placeholderFailure("non-string")
  if (stack.includes(parts.key)) throw placeholderFailure("cycle")
  const next = stack.concat(parts.key)
  return resolvePlaceholderString(root, selected.value, next)
}

/** Resolves every placeholder in one string without coercing referenced values. */
function resolvePlaceholderString(
  root: ConfigObject,
  value: string,
  stack: readonly string[]
): string {
  let output = ""
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf("${", cursor)
    if (start === -1) return output + value.slice(cursor)
    output += value.slice(cursor, start)
    const end = placeholderEnd(value, start)
    if (end === -1) throw placeholderFailure("invalid")
    const parts = placeholderParts(value.slice(start + 2, end))
    output += resolveReference(root, parts, stack)
    cursor = end + 1
  }
  return output
}

/** Recursively resolves strings in admitted objects and nested arrays. */
function resolvePlaceholderValue(
  root: ConfigObject,
  value: ConfigValue,
  stack: readonly string[]
): ConfigValue {
  if (typeof value === "string") return resolvePlaceholderString(root, value, stack)
  if (Array.isArray(value)) {
    const output: ConfigValue[] = []
    for (const item of value) output.push(resolvePlaceholderValue(root, item, stack))
    return output
  }
  if (!isConfigObject(value)) return value
  const output: { [key: string]: ConfigValue } = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = resolvePlaceholderValue(root, item, stack)
  }
  return output
}

/** Creates an explicit resolver for merged-root `${dotted.key}` placeholders. */
export function placeholderResolver(): ConfigResolver {
  /** Resolves one independently frozen merged document without reading ambient state. */
  function resolvePlaceholders(_ctx: Context, value: ConfigObject): ConfigObject {
    const resolved = resolvePlaceholderValue(value, value, Object.freeze([]))
    if (!isConfigObject(resolved)) throw placeholderFailure("invalid")
    return resolved
  }
  return resolvePlaceholders
}

/** Compares two admitted ConfigValue graphs while ignoring object insertion order. */
function sameValue(left: ConfigValue, right: ConfigValue): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      const leftValue = left[index]
      const rightValue = right[index]
      if (
        leftValue === undefined ||
        rightValue === undefined ||
        !sameValue(leftValue, rightValue)
      ) {
        return false
      }
    }
    return true
  }
  if (!isConfigObject(left) || !isConfigObject(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let index = 0; index < leftKeys.length; index += 1) {
    const leftKey = leftKeys[index]
    const rightKey = rightKeys[index]
    if (leftKey === undefined || rightKey === undefined || leftKey !== rightKey) return false
    const leftValue = left[leftKey]
    const rightValue = right[rightKey]
    if (leftValue === undefined || rightValue === undefined || !sameValue(leftValue, rightValue)) {
      return false
    }
  }
  return true
}

/** Invokes one observer directly so an out-of-contract returned thenable remains observable. */
function observeObserver(observer: Observer, key: string, value: Value): void {
  try {
    const result = observer(key, value)
    void Promise.resolve(result).catch(ignoreHookFailure)
  } catch {
    return
  }
}

/** Captures Go-style options and returns one Kratos-style configuration manager. */
export function newConfig<const Options extends readonly ConfigOption<ConfigValue>[]>(
  /** go-like-typed-rest: preserves the Go-style functional-option ABI. */
  ...options: Options
): Config<ConfigOutput<Options>> {
  const settings: ConfigSettings = {
    sources: Object.freeze([]),
    resolvers: Object.freeze([]),
    schema: null,
    reloadErrorHandler: null,
    terminalErrorHandler: null
  }
  try {
    for (const option of options) {
      if (typeof option !== "function") throw new TypeError("invalid configuration option")
      option(settings)
    }
  } catch {
    throw new TypeError("invalid configuration options")
  }
  const sourceList = settings.sources
  const resolverList = settings.resolvers
  const publicationSchema = settings.schema
  const reloadErrorHandler = settings.reloadErrorHandler
  const terminalErrorHandler = settings.terminalErrorHandler

  let state: LifecycleState = "idle"
  let current: ConfigPublication<ConfigValue> | null = null
  let queueTail: Promise<void> = Promise.resolve()
  let runtimeContext: Context | null = null
  let cancelStartup: ((failure: Error | null) => void) | null = null
  let cancelRuntime: ((failure: Error | null) => void) | null = null
  let dirty = false
  let reloadActive = false
  let reloadRetryDelayMs = reloadRetryInitialMs
  let reloadRetryTimer: ReturnType<typeof setTimeout> | null = null
  let drainStarted = false
  let abnormalPrimary: Error | null = null
  const cleanupFailures: Error[] = []
  const observers = new Map<string, ObserverRecord>()
  const values = new Map<string, Value>()
  const watchers: WatcherRuntime[] = []
  const intentionalStop = Object.freeze(new Error("configuration runtime closed intentionally"))
  let terminalFailure: Error | null = null
  const terminalController = new AbortController()
  const donePromise = new Promise<void>(observeTerminal)
  void donePromise.catch(ignoreHookFailure)

  /** Connects the lifecycle's portable AbortSignal barrier to one Promise settlement. */
  function observeTerminal(resolve: () => void, reject: (error: Error) => void): void {
    /** Settles the stable done Promise from the terminal success or failure fact. */
    function settleTerminal(): void {
      if (terminalFailure === null) resolve()
      else reject(terminalFailure)
    }
    terminalController.signal.addEventListener("abort", settleTerminal, { once: true })
  }

  /** Resolves the stable terminal barrier exactly once. */
  function resolveDone(): void {
    terminalController.abort()
  }

  /** Rejects the stable terminal barrier with the first finalized lifecycle failure. */
  function rejectDone(error: Error): void {
    terminalFailure = error
    terminalController.abort()
  }

  /** Enqueues one complete mutation round and retains a fulfilled exclusive lease after settlement. */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queueTail.then(operation)
    queueTail = result.then(ignoreScheduledValue, ignoreScheduledFailure)
    return result
  }

  /** Loads and admits one complete source snapshot without retaining adapter-owned values. */
  async function loadSource(ctx: Context, source: CapturedSource): Promise<ConfigSourceSnapshot> {
    throwIfCanceled(ctx)
    let pending: Promise<ConfigSourceSnapshot>
    try {
      pending = Promise.resolve(source.load.call(source.receiver, ctx))
    } catch (error) {
      throw sourceFailure(ctx, source.name, "load", error)
    }
    let supplied: ConfigSourceSnapshot
    try {
      supplied = await pending
    } catch (error) {
      throw sourceFailure(ctx, source.name, "load", error)
    }
    throwIfCanceled(ctx)
    try {
      if (supplied === null || typeof supplied !== "object")
        throw new TypeError("invalid source snapshot")
      const value = supplied.value
      const revision = supplied.revision
      if (!isConfigObject(value) || (typeof revision !== "string" && revision !== null)) {
        throw new TypeError("invalid source snapshot")
      }
      return Object.freeze({ value: frozenClone(value), revision })
    } catch (error) {
      throw newSourceError(source.name, "load", error)
    }
  }

  /** Runs ordered resolvers with isolated frozen inputs and re-admits every output. */
  async function resolveMerged(ctx: Context, merged: ConfigObject): Promise<ConfigObject> {
    let current = merged
    for (const resolve of resolverList) {
      throwIfCanceled(ctx)
      const input = frozenClone(current)
      let pending: Promise<ConfigObject>
      try {
        pending = Promise.resolve(resolve(ctx, input))
      } catch (error) {
        throw contextFailure(ctx) ?? normalizeError(error)
      }
      let supplied: ConfigObject
      try {
        supplied = await waitForContext(ctx, pending)
      } catch (error) {
        throw contextFailure(ctx) ?? normalizeError(error)
      }
      throwIfCanceled(ctx)
      try {
        if (!isConfigObject(supplied))
          throw new TypeError("configuration resolver must return an object")
        current = frozenClone(supplied)
      } catch {
        throw new TypeError("invalid configuration resolver output")
      }
    }
    return current
  }

  /** Computes one complete last-good candidate without publishing it. */
  async function prepare(ctx: Context): Promise<PreparedConfig> {
    throwIfCanceled(ctx)
    const values: ConfigObject[] = []
    const revisions: ConfigSourceRevision[] = []
    const watchTargets: WatchTarget[] = []
    for (const source of sourceList) {
      const loaded = await loadSource(ctx, source)
      values.push(loaded.value)
      revisions.push(Object.freeze({ name: source.name, revision: loaded.revision }))
      watchTargets.push(Object.freeze({ source, revision: loaded.revision }))
    }
    const merged = mergeObjects(values)
    const resolved = await resolveMerged(ctx, merged)
    let value: ConfigValue
    let rawValue: ConfigObject | null = null
    if (publicationSchema === null) {
      rawValue = frozenClone(resolved)
      value = rawValue
    } else {
      value = await validateConfig(publicationSchema, resolved)
    }
    throwIfCanceled(ctx)
    return Object.freeze({
      value,
      rawValue,
      sources: Object.freeze(revisions),
      watchTargets: Object.freeze(watchTargets)
    })
  }

  /** Publishes one prepared candidate atomically and isolates every listener failure. */
  function publish(prepared: PreparedConfig): ConfigPublication<ConfigValue> {
    const version = current === null ? 1 : current.version + 1
    let next: ConfigPublication<ConfigValue>
    if (prepared.rawValue === null) {
      next = Object.freeze({ version, value: prepared.value, sources: prepared.sources })
    } else {
      const rawNext: ConfigPublication<ConfigObject> = Object.freeze({
        version,
        value: prepared.rawValue,
        sources: prepared.sources
      })
      next = rawNext
    }
    current = next
    const dispatch = Array.from(observers.values())
    for (const record of dispatch) {
      const selected = selectValue(next.value, record.path)
      if (!selected.found || sameValue(record.current, selected.value)) continue
      record.current = selected.value
      observeObserver(record.observer, record.key, record.value)
    }
    return next
  }

  /** Creates and validates one accepted Kratos-style source watcher. */
  function captureWatcher(sourceName: string, watcher: ConfigSourceWatcher): WatcherRuntime {
    if (watcher === null || typeof watcher !== "object")
      throw newSourceError(sourceName, "watch", new TypeError("invalid watcher"))
    let next: ConfigSourceWatcher["next"]
    let stop: ConfigSourceWatcher["stop"]
    try {
      next = watcher.next
      stop = watcher.stop
    } catch (error) {
      throw newSourceError(sourceName, "watch", error)
    }
    if (typeof next !== "function" || typeof stop !== "function") {
      throw newSourceError(sourceName, "watch", new TypeError("invalid watcher"))
    }
    return {
      sourceName,
      receiver: watcher,
      next,
      stop,
      loop: null,
      stopStarted: false
    }
  }

  /** Best-effort stops an accepted watcher that failed public admission. */
  async function cleanupProvisionalWatcher(
    sourceName: string,
    watcher: ConfigSourceWatcher,
    failures: Error[]
  ): Promise<void> {
    if (watcher === null || typeof watcher !== "object") return
    let stopMethod: ConfigSourceWatcher["stop"] | null = null
    try {
      const supplied = watcher.stop
      if (typeof supplied === "function") stopMethod = supplied
    } catch (error) {
      failures.push(newSourceError(sourceName, "stop", error))
    }

    if (stopMethod !== null) {
      try {
        await Promise.resolve(stopMethod.call(watcher, background()))
      } catch (error) {
        failures.push(newSourceError(sourceName, "stop", error))
      }
    }
  }

  /** Rolls back a provisionally owned watcher. */
  async function rollbackProvisionalWatcher(
    sourceName: string,
    watcher: ConfigSourceWatcher,
    primary: Error
  ): Promise<Error> {
    const failures: Error[] = []
    await cleanupProvisionalWatcher(sourceName, watcher, failures)
    return aggregateFailures(primary, failures)
  }

  /** Opens one source watcher with the candidate revision and preserves its receiver. */
  async function openWatcher(
    ctx: Context,
    source: CapturedSource,
    revision: string | null
  ): Promise<WatcherRuntime | null> {
    if (source.watch === undefined) return null
    throwIfCanceled(ctx)
    let pending: Promise<ConfigSourceWatcher>
    try {
      pending = Promise.resolve(source.watch.call(source.receiver, ctx, revision))
    } catch (error) {
      throw sourceFailure(ctx, source.name, "watch", error)
    }
    let watcher: ConfigSourceWatcher
    try {
      watcher = await pending
    } catch (error) {
      throw sourceFailure(ctx, source.name, "watch", error)
    }
    let runtime: WatcherRuntime
    try {
      runtime = captureWatcher(source.name, watcher)
    } catch (error) {
      throw await rollbackProvisionalWatcher(source.name, watcher, normalizeError(error))
    }
    watchers.push(runtime)
    throwIfCanceled(ctx)
    return runtime
  }

  /** Adds one cleanup failure only once by exact identity. */
  function addCleanupFailure(error: Error): void {
    if (error === abnormalPrimary || cleanupFailures.includes(error)) return
    cleanupFailures.push(error)
  }

  /** Reads whether lifecycle mutation has crossed the synchronous stop cutoff. */
  function lifecycleIsStopping(): boolean {
    return state === "closing"
  }

  /** Invokes the one-shot terminal observer without allowing application code to own drain. */
  function reportTerminalFailure(error: Error): void {
    if (terminalErrorHandler === null) return
    try {
      const result = terminalErrorHandler(error)
      void Promise.resolve(result).catch(ignoreHookFailure)
    } catch {
      return
    }
  }

  /** Records the first terminal runtime fact and starts the shared reverse drain. */
  function recordAbnormal(error: Error): void {
    const first = abnormalPrimary === null
    if (first) abnormalPrimary = error
    else addCleanupFailure(error)
    if (state === "loaded") {
      if (first) reportTerminalFailure(error)
      void beginDrain()
    }
  }

  /** Cancels one pending owner retry without changing the selected dirty work. */
  function cancelReloadRetry(): void {
    if (reloadRetryTimer === null) return
    clearTimeout(reloadRetryTimer)
    reloadRetryTimer = null
  }

  /** Resets retry backoff after a success or a newer source event. */
  function resetReloadRetry(): void {
    cancelReloadRetry()
    reloadRetryDelayMs = reloadRetryInitialMs
  }

  /** Marks one coalesced change and admits at most one background reload at a time. */
  function markDirty(): void {
    dirty = true
    resetReloadRetry()
    if (state === "loaded") pumpDirty()
  }

  /** Invokes the captured reload error hook while observing throws and returned thenables. */
  function reportReloadFailure(error: Error): void {
    if (reloadErrorHandler !== null) {
      try {
        const result = reloadErrorHandler(error, current?.value ?? null)
        void Promise.resolve(result).catch(ignoreHookFailure)
      } catch {
        return
      }
    }
  }

  /** Completes one successful background round and admits one coalesced rerun if needed. */
  function backgroundSucceeded(_publication: ConfigPublication<ConfigValue>): void {
    reloadActive = false
    resetReloadRetry()
    if (state === "loaded") pumpDirty()
  }

  /** Schedules one bounded owner retry without spinning on a persistent invalid document. */
  function scheduleReloadRetry(): void {
    if (
      state !== "loaded" ||
      reloadActive ||
      !dirty ||
      runtimeContext === null ||
      reloadRetryTimer !== null
    )
      return
    const delayMs = reloadRetryDelayMs
    reloadRetryDelayMs = Math.min(reloadRetryMaximumMs, reloadRetryDelayMs * 2)
    /** Releases timer ownership before admitting its dirty round. */
    function retryReload(): void {
      reloadRetryTimer = null
      pumpDirty()
    }
    reloadRetryTimer = setTimeout(retryReload, delayMs)
  }

  /** Completes one failed background round without disturbing last-good state. */
  function backgroundFailed(value: unknown): void {
    const changedWhileReloading = dirty
    reloadActive = false
    if (isIntentionalStopFailure(value, intentionalStop)) return
    reportReloadFailure(normalizeError(value))
    if (state !== "loaded") return
    dirty = true
    if (changedWhileReloading) {
      resetReloadRetry()
      pumpDirty()
      return
    }
    scheduleReloadRetry()
  }

  /** Starts a full background recomputation when the shared dirty bit owns pending work. */
  function pumpDirty(): void {
    if (state !== "loaded" || reloadActive || !dirty || runtimeContext === null) return
    dirty = false
    reloadActive = true
    const ctx = runtimeContext
    /** Performs one kernel-owned background publication under the private runtime Context. */
    async function backgroundRound(): Promise<ConfigPublication<ConfigValue>> {
      return publish(await prepare(ctx))
    }
    void enqueue(backgroundRound).then(backgroundSucceeded, backgroundFailed)
  }

  /** Runs one watcher's repeated next boundary until shutdown or a terminal watcher failure. */
  async function runWatcher(runtime: WatcherRuntime, ctx: Context): Promise<void> {
    while (state === "loading" || state === "loaded") {
      try {
        await Promise.resolve(runtime.next.call(runtime.receiver, ctx))
      } catch (error) {
        if (isIntentionalStopFailure(error, intentionalStop)) return
        const failure = newSourceError(runtime.sourceName, "next", error)
        if (lifecycleIsStopping()) addCleanupFailure(failure)
        else recordAbnormal(failure)
        return
      }
      if (state !== "loading" && state !== "loaded") return
      markDirty()
    }
  }

  /** Launches one watcher loop before the startup publication becomes visible. */
  function launchWatcher(runtime: WatcherRuntime, ctx: Context): void {
    runtime.loop = runWatcher(runtime, ctx)
  }

  /** Stops one accepted watcher. */
  async function drainWatcher(runtime: WatcherRuntime): Promise<void> {
    if (!runtime.stopStarted) {
      runtime.stopStarted = true
      try {
        await Promise.resolve(runtime.stop.call(runtime.receiver, background()))
      } catch (error) {
        addCleanupFailure(newSourceError(runtime.sourceName, "stop", error))
      }
    }
  }

  /** Drains every accepted source watcher in reverse ownership-transfer order. */
  async function drainAcceptedWatchers(): Promise<void> {
    const drains: Promise<void>[] = []
    for (let index = watchers.length - 1; index >= 0; index -= 1) {
      const runtime = watchers[index]
      if (runtime !== undefined) drains.push(drainWatcher(runtime))
    }
    await Promise.all(drains)
  }

  /** Rolls startup watchers back in reverse order before the original startup failure is returned. */
  async function rollbackStartup(primary: Error): Promise<Error> {
    state = "closing"
    if (abnormalPrimary === null) abnormalPrimary = primary
    await drainAcceptedWatchers()
    const failure = aggregateFailures(primary, cleanupFailures)
    state = "failed"
    rejectDone(failure)
    return failure
  }

  /** Loads once, accepts watchers from those revisions, and publishes readiness. */
  async function runLoad(ctx: Context): Promise<void> {
    const [startupContext, cancel] = withCancelCause(ctx)
    cancelStartup = cancel
    try {
      const candidate = await prepare(startupContext)
      for (const target of candidate.watchTargets) {
        await openWatcher(startupContext, target.source, target.revision)
      }
      throwIfCanceled(startupContext)
      cancel(null)
      cancelStartup = null
      const [privateContext, cancelPrivate] = withCancelCause(background())
      runtimeContext = privateContext
      cancelRuntime = cancelPrivate
      for (const runtime of watchers) launchWatcher(runtime, privateContext)
      await Promise.resolve()
      const readinessFailure = abnormalPrimary
      if (readinessFailure !== null) throw readinessFailure
      const publication = publish(candidate)
      void publication
      if (drainStarted) {
        state = "closing"
        cancelPrivate(intentionalStop)
      } else {
        state = "loaded"
        pumpDirty()
      }
    } catch (error) {
      const primary = normalizeError(error)
      cancel(primary)
      cancelStartup = null
      if (cancelRuntime !== null) cancelRuntime(intentionalStop)
      if (drainStarted && isIntentionalStopFailure(primary, intentionalStop)) {
        await drainAcceptedWatchers()
        return
      }
      throw await rollbackStartup(primary)
    }
  }

  /** Drains accepted watchers, queued mutations, watcher loops, and terminal barriers. */
  async function drainRuntime(queueBarrier: Promise<void>): Promise<void> {
    await queueBarrier
    await drainAcceptedWatchers()
    for (const runtime of watchers) {
      if (runtime.loop !== null) await runtime.loop
    }
  }

  /** Finalizes one normal or abnormal owner drain. */
  async function performDrain(queueBarrier: Promise<void>): Promise<void> {
    await drainRuntime(queueBarrier)
    let failure: Error | null = abnormalPrimary
    if (failure === null && cleanupFailures.length > 0) {
      const first = cleanupFailures.shift()
      if (first !== undefined) failure = first
    }
    if (failure === null) {
      state = "closed"
      resolveDone()
      return
    }
    const finalFailure = aggregateFailures(failure, cleanupFailures)
    state = "failed"
    rejectDone(finalFailure)
  }

  /** Establishes the synchronous load cutoff and creates exactly one owner drain. */
  function beginDrain(): Promise<void> {
    if (drainStarted) return donePromise
    drainStarted = true
    state = "closing"
    dirty = false
    cancelReloadRetry()
    const cutoff = queueTail
    if (cancelStartup !== null) cancelStartup(intentionalStop)
    if (cancelRuntime !== null) cancelRuntime(intentionalStop)
    void performDrain(cutoff)
    return donePromise
  }

  /** Validates the complete current configuration without triggering a source load. */
  async function scan<Input extends ConfigValue, Output extends ConfigValue>(
    ctx: Context,
    suppliedSchema: StandardSchemaV1<Input, Output>
  ): Promise<Output> {
    throwIfCanceled(ctx)
    const publication = current
    if (publication === null) throw newNotFoundError("")
    const captured = captureSchema(suppliedSchema)
    return waitForContext(ctx, validateConfig(captured, publication.value))
  }

  /** Returns one cached live Value view for a Kratos-style dotted key. */
  function value(key: string): Value {
    const path = capturePath(key)
    const existing = values.get(key)
    if (existing !== undefined) return existing

    /** Loads this view's current immutable value without triggering source I/O. */
    function loadValue(): ConfigValue | null {
      const publication = current
      if (publication === null) return null
      const selected = selectValue(publication.value, path)
      return selected.found ? selected.value : null
    }

    /** Validates this view's current value without creating a second key abstraction. */
    async function scanValue<Input extends ConfigValue, Output extends ConfigValue>(
      ctx: Context,
      suppliedSchema: StandardSchemaV1<Input, Output>
    ): Promise<Output> {
      throwIfCanceled(ctx)
      const publication = current
      if (publication === null) throw newNotFoundError(key)
      const selected = selectValue(publication.value, path)
      if (!selected.found) throw newNotFoundError(key)
      const captured = captureSchema(suppliedSchema)
      return waitForContext(ctx, validateConfig(captured, selected.value))
    }

    const created: Value = Object.freeze({ load: loadValue, scan: scanValue })
    values.set(key, created)
    return created
  }

  /** Registers or replaces the sole observer for one Kratos-style dotted key. */
  function watch(key: string, observer: Observer): void {
    const path = capturePath(key)
    if (typeof observer !== "function")
      throw new TypeError("configuration observer must be callable")
    const publication = current
    if (publication === null) throw newNotFoundError(key)
    const selected = selectValue(publication.value, path)
    if (!selected.found) throw newNotFoundError(key)
    const watchedValue = value(key)
    const record: ObserverRecord = {
      key,
      path,
      observer,
      value: watchedValue,
      current: selected.value
    }
    observers.set(key, record)
  }

  /** Claims the one-shot initial load and returns after sources and watchers are ready. */
  function load(ctx: Context): Promise<void> {
    if (state !== "idle") return Promise.reject(newAlreadyLoadedError(state))
    state = "loading"
    let preCanceled: Error | null
    try {
      preCanceled = contextFailure(ctx)
    } catch (error) {
      const failure = normalizeError(error)
      state = "failed"
      rejectDone(failure)
      return Promise.reject(failure)
    }
    if (preCanceled !== null) {
      state = "failed"
      rejectDone(preCanceled)
      return Promise.reject(preCanceled)
    }
    /** Holds the mutation scheduler across the complete initial load sequence. */
    function loadOperation(): Promise<void> {
      return runLoad(ctx)
    }
    return enqueue(loadOperation)
  }

  /** Joins or creates the watcher drain while caller cancellation limits only this waiter. */
  function close(ctx: Context): Promise<void> {
    return waitForContext(ctx, beginDrain())
  }

  const config: Config<ConfigOutput<Options>> = Object.freeze({ load, scan, value, watch, close })
  return config
}

/** Re-exports the stable in-memory source factory from the public type module. */
export const objectSource = createObjectSource
