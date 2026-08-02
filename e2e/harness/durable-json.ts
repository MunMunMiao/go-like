import { randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"

import {
  closeSecureDirectory,
  openSecureDirectory,
  readSecureFile,
  SecureFilesystemError,
  secureDirectoryLeaseConsumed,
  writeSecureFileNoReplace,
  type SecureDirectory
} from "./secure-filesystem"

declare const DurableJsonDirectoryBrand: unique symbol

/** An unforgeable runtime handle for one validated private directory. */
export interface DurableJsonDirectory {
  readonly [DurableJsonDirectoryBrand]: true
}

export interface DurableJsonDirectoryOptions {
  readonly containedRoot?: string | undefined
  readonly maximumBytes?: number | undefined
  readonly publicationStabilizationTimeoutMs?: number | undefined
}

export interface DurableJsonWriteOptions {
  readonly readOnly?: boolean | undefined
}

interface DirectoryState {
  readonly secureDirectory: SecureDirectory
  readonly maximumBytes: number
  readonly publicationStabilizationTimeoutMs: number
  queue: Promise<void>
  closing: boolean
}

const ComponentPattern = /^(?!\.{1,2}$)[@a-zA-Z0-9][@a-zA-Z0-9_.-]{0,127}$/u
const DurableJsonTemporaryPrefix = ".durable-"
const DurableJsonTemporarySuffix = ".tmp"
const CanonicalVersion4UuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const EmptyOptions = Object.freeze({})
const Utf8Encoder = new TextEncoder()
const Utf8Decoder = new TextDecoder("utf-8", { fatal: true })
const MaximumJsonDepth = 100
const DefaultPublicationStabilizationTimeoutMs = 1_000
const MaximumPublicationStabilizationTimeoutMs = 30_000

/** The hard upper bound accepted by this transient E2E JSON primitive. */
export const MaximumDurableJsonBytes = 4 * 1024 * 1024

/** Identifies only temporary components created by this module's publication protocol. */
export function isDurableJsonTemporaryComponent(component: string): boolean {
  if (
    typeof component !== "string" ||
    !component.startsWith(DurableJsonTemporaryPrefix) ||
    !component.endsWith(DurableJsonTemporarySuffix)
  ) {
    return false
  }
  const identifier = component.slice(
    DurableJsonTemporaryPrefix.length,
    -DurableJsonTemporarySuffix.length
  )
  return CanonicalVersion4UuidPattern.test(identifier)
}

function durableJsonTemporaryComponent(): string {
  const component = `${DurableJsonTemporaryPrefix}${randomUUID()}${DurableJsonTemporarySuffix}`
  if (!isDurableJsonTemporaryComponent(component)) {
    throw new Error("durable JSON temporary component generation failed")
  }
  return component
}

const issuedDirectories = new WeakMap<object, DirectoryState>()

class JsonSizeError extends Error {}

function maximumBytes(value: number | undefined): number {
  const selected = value ?? MaximumDurableJsonBytes
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > MaximumDurableJsonBytes) {
    throw new Error("durable JSON maximumBytes is outside the supported bound")
  }
  return selected
}

function publicationStabilizationTimeoutMs(value: number | undefined): number {
  const selected = value ?? DefaultPublicationStabilizationTimeoutMs
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > MaximumPublicationStabilizationTimeoutMs
  ) {
    throw new Error("durable JSON publication stabilization timeout is outside the supported bound")
  }
  return selected
}

function validateComponent(component: string): void {
  if (typeof component !== "string" || !ComponentPattern.test(component)) {
    throw new Error("invalid durable JSON path component")
  }
}

function directoryState(directory: DurableJsonDirectory): DirectoryState {
  const state = issuedDirectories.get(directory)
  if (state === undefined || state.closing) {
    throw new Error("unknown durable JSON directory handle")
  }
  return state
}

function runDirectoryOperation<T>(
  directory: DurableJsonDirectory,
  operation: (state: DirectoryState) => Promise<T>
): Promise<T> {
  const state = directoryState(directory)
  const result = state.queue.then(async () => await operation(state))
  state.queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

class StableJsonWriter {
  readonly #maximumBytes: number
  readonly #parts: string[] = []
  #byteLength = 0

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes
  }

  append(value: string): void {
    this.#byteLength += Utf8Encoder.encode(value).byteLength
    if (this.#byteLength > this.#maximumBytes) throw new JsonSizeError()
    this.#parts.push(value)
  }

  bytes(): Uint8Array {
    return Utf8Encoder.encode(this.#parts.join(""))
  }
}

function quoted(value: string): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("string encoding failed")
  return encoded
}

function writeStableJsonValue(
  writer: StableJsonWriter,
  value: unknown,
  ancestors: Set<object>,
  depth: number
): void {
  if (depth > MaximumJsonDepth) throw new Error("JSON nesting is too deep")
  if (value === null) {
    writer.append("null")
    return
  }
  switch (typeof value) {
    case "boolean":
      writer.append(value ? "true" : "false")
      return
    case "number":
      if (!Number.isFinite(value)) throw new Error("JSON number is not finite")
      writer.append(String(Object.is(value, -0) ? 0 : value))
      return
    case "string":
      writer.append(quoted(value))
      return
    case "object":
      break
    default:
      throw new Error("value is not JSON data")
  }

  if (ancestors.has(value)) throw new Error("JSON value is cyclic")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      writer.append("[")
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) writer.append(",")
        if (!Object.hasOwn(value, index)) throw new Error("JSON array is sparse")
        writeStableJsonValue(writer, value[index], ancestors, depth + 1)
      }
      writer.append("]")
      return
    }

    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("JSON object prototype is unsupported")
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error("JSON object has symbol properties")
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
      .filter((key) => descriptors[key]?.enumerable === true)
      .sort()
    writer.append("{")
    for (const [index, key] of keys.entries()) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("JSON object has an enumerable accessor")
      }
      if (index > 0) writer.append(",")
      writer.append(quoted(key))
      writer.append(":")
      writeStableJsonValue(writer, descriptor.value, ancestors, depth + 1)
    }
    writer.append("}")
  } finally {
    ancestors.delete(value)
  }
}

function stableJsonBytes(value: unknown, maximum: number): Uint8Array {
  try {
    const writer = new StableJsonWriter(maximum)
    writeStableJsonValue(writer, value, new Set<object>(), 0)
    writer.append("\n")
    return writer.bytes()
  } catch (error) {
    if (error instanceof JsonSizeError) {
      throw new Error("durable JSON document exceeds the configured byte bound")
    }
    throw new Error("durable JSON value is not stable serializable JSON")
  }
}

function durableOpenError(error: unknown): Error {
  if (!(error instanceof SecureFilesystemError)) {
    return error instanceof Error
      ? error
      : new Error("durable JSON directory could not be securely opened", { cause: error })
  }
  if (error.code === "ELOOP" || (error.code === "ENOTDIR" && error.status !== 6)) {
    return new Error("durable JSON requested directory must not be a symbolic link", {
      cause: error
    })
  }
  if (error.status === 7) {
    return new Error("durable JSON requested directory permissions are wider than 0700", {
      cause: error
    })
  }
  if (error.status === 3) {
    return new Error("durable JSON directory identity changed after opening", { cause: error })
  }
  return new Error("durable JSON directory could not be securely opened", { cause: error })
}

function errorWithCode(message: string, code: string, cause: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code })
}

function durableReadError(error: unknown): Error {
  if (!(error instanceof SecureFilesystemError)) {
    return error instanceof Error
      ? error
      : new Error("durable JSON file could not be securely read", { cause: error })
  }
  if (error.code === "ENOENT") {
    return errorWithCode("durable JSON file is not published", "ENOENT", error)
  }
  if (error.status === 5 && error.code === "ETIMEDOUT") {
    return new Error("durable JSON publication did not stabilize before its bounded deadline", {
      cause: error
    })
  }
  if (error.status === 4 && error.code === "EFBIG") {
    return new Error("durable JSON file exceeds the configured byte bound", { cause: error })
  }
  if (error.code === "ELOOP") {
    return new Error("durable JSON file could not be opened without following symbolic links", {
      cause: error
    })
  }
  if (error.status === 6) {
    return new Error("durable JSON file must be a regular file", { cause: error })
  }
  if (error.status === 7) {
    return new Error("durable JSON file permissions are wider than 0600", { cause: error })
  }
  if (error.status === 3) {
    return new Error("durable JSON directory identity changed after opening", { cause: error })
  }
  return new Error("durable JSON file could not be securely read", { cause: error })
}

/** Opens and retains a private directory by walking from the canonical temp root. */
export async function openDurableJsonDirectory(
  path: string,
  options: DurableJsonDirectoryOptions = EmptyOptions
): Promise<DurableJsonDirectory> {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new Error("durable JSON directory path must be absolute and canonical")
  }
  let secureDirectory: SecureDirectory
  try {
    secureDirectory = await openSecureDirectory(path, {
      ...(options.containedRoot === undefined ? {} : { containedRoot: options.containedRoot })
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes("escaped its required contained root")) {
      throw new Error("durable JSON directory escaped its required contained root", {
        cause: error
      })
    }
    throw durableOpenError(error)
  }
  const directory = Object.freeze({}) as DurableJsonDirectory
  issuedDirectories.set(directory, {
    secureDirectory,
    maximumBytes: maximumBytes(options.maximumBytes),
    publicationStabilizationTimeoutMs: publicationStabilizationTimeoutMs(
      options.publicationStabilizationTimeoutMs
    ),
    queue: Promise.resolve(),
    closing: false
  })
  return directory
}

/** Writes canonical JSON through an exclusive, durable, no-replace publication sequence. */
export async function writeDurableJson(
  directory: DurableJsonDirectory,
  component: string,
  value: unknown,
  options: DurableJsonWriteOptions = EmptyOptions
): Promise<void> {
  validateComponent(component)
  return await runDirectoryOperation(directory, async (state) => {
    const bytes = stableJsonBytes(value, state.maximumBytes)
    const temporary = durableJsonTemporaryComponent()
    try {
      await writeSecureFileNoReplace(state.secureDirectory, temporary, component, bytes, {
        ...(options.readOnly === true ? { readOnly: true } : {})
      })
    } catch (error) {
      if (error instanceof SecureFilesystemError && error.code === "EEXIST") {
        throw new Error("durable JSON final component already exists", { cause: error })
      }
      if (error instanceof SecureFilesystemError && error.status === 3) {
        throw new Error("durable JSON directory identity changed after opening", { cause: error })
      }
      throw error
    }
  })
}

/** Reads one bounded, private, no-follow regular JSON file from a retained directory. */
export async function readDurableJson(
  directory: DurableJsonDirectory,
  component: string
): Promise<unknown> {
  validateComponent(component)
  return await runDirectoryOperation(directory, async (state) => {
    let bytes: Uint8Array
    try {
      bytes = await readSecureFile(
        state.secureDirectory,
        component,
        state.maximumBytes,
        state.publicationStabilizationTimeoutMs
      )
    } catch (error) {
      throw durableReadError(error)
    }

    let text: string
    try {
      text = Utf8Decoder.decode(bytes)
    } catch {
      throw new Error("durable JSON file is not valid UTF-8")
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error("durable JSON file is not valid JSON")
    }
  })
}

/** Closes the retained native directory handles and invalidates the opaque handle. */
export async function closeDurableJsonDirectory(directory: DurableJsonDirectory): Promise<void> {
  const state = issuedDirectories.get(directory)
  if (state === undefined || state.closing) {
    throw new Error("unknown durable JSON directory handle")
  }
  state.closing = true
  const closing = state.queue.then(async () => await closeSecureDirectory(state.secureDirectory))
  state.queue = closing.then(
    () => undefined,
    () => undefined
  )
  try {
    await closing
  } catch (error) {
    if (secureDirectoryLeaseConsumed(error)) issuedDirectories.delete(directory)
    else state.closing = false
    throw error
  }
  issuedDirectories.delete(directory)
}
