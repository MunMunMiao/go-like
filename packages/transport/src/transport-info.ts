import { withValue, type Context } from "@likego/context"
import { clone as cloneMetadata } from "@likego/metadata"

import type { TransportInfo } from "./types"

const MaximumKindBytes = 64
const MaximumEndpointBytes = 4_096
const MaximumOperationBytes = 1_024
const KindPattern = /^[a-z0-9][a-z0-9+._-]*$/
const ControlPattern = /[\u0000-\u001f\u007f]/
const Encoder = new TextEncoder()
const TransportInfoBrand = new WeakSet<object>()
const clientContextKey = Object.freeze({})
const serverContextKey = Object.freeze({})

/** Reports whether value is a non-array object suitable for structural inspection. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Recognizes standard Error objects across realms with a local fallback. */
function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return typeof candidate === "function" ? candidate(value) === true : value instanceof Error
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

/** Validates one control-free transport identity field and its UTF-8 limit. */
function transportText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || !isWellFormed(value) || ControlPattern.test(value)) {
    throw new TypeError(`TransportInfo ${field} must be a well-formed control-free string`)
  }
  if (Encoder.encode(value).byteLength > maximumBytes) {
    throw new RangeError(`TransportInfo ${field} exceeds ${maximumBytes} UTF-8 bytes`)
  }
  return value
}

/** Normalizes a structural reader boundary without replacing existing Error identity. */
function readerError(value: unknown, field: string): Error {
  return isError(value)
    ? value
    : new Error(`TransportInfo ${field} reader rejected with a non-Error value`, { cause: value })
}

/** Calls and validates one structural text reader. */
function readText(
  info: TransportInfo,
  reader: () => string,
  field: string,
  maximumBytes: number
): string {
  try {
    return transportText(reader.call(info), field, maximumBytes)
  } catch (value) {
    throw readerError(value, field)
  }
}

/** Calls and defensively clones one structural Metadata reader. */
function readMetadata(info: TransportInfo, reader: TransportInfo["requestHeaders"], field: string) {
  try {
    return cloneMetadata(reader.call(info))
  } catch (value) {
    throw readerError(value, field)
  }
}

/** Reads one structural method without invoking an accessor. */
function dataMethod(value: object, key: string): unknown {
  let owner: object | null = value
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : null
    owner = Object.getPrototypeOf(owner)
  }
  return null
}

/** Returns whether value implements the five structural TransportInfo methods. */
function isTransportInfo(value: unknown): value is TransportInfo {
  return (
    isRecord(value) &&
    typeof dataMethod(value, "kind") === "function" &&
    typeof dataMethod(value, "endpoint") === "function" &&
    typeof dataMethod(value, "operation") === "function" &&
    typeof dataMethod(value, "requestHeaders") === "function" &&
    typeof dataMethod(value, "replyHeaders") === "function"
  )
}

/** Captures stable kind/operation while preserving dynamic endpoint and defensive header reads. */
function snapshotTransportInfo(info: TransportInfo): TransportInfo {
  const candidate: unknown = info
  if (!isTransportInfo(candidate)) {
    throw new TypeError("TransportInfo must implement the structural method shape")
  }
  const kindReader = info.kind
  const endpointReader = info.endpoint
  const operationReader = info.operation
  const requestHeadersReader = info.requestHeaders
  const replyHeadersReader = info.replyHeaders
  const kind = readText(info, kindReader, "kind", MaximumKindBytes)
  if (!KindPattern.test(kind)) {
    throw new TypeError("TransportInfo kind must be a lower-case transport token")
  }
  readText(info, endpointReader, "endpoint", MaximumEndpointBytes)
  const operation = readText(info, operationReader, "operation", MaximumOperationBytes)
  const snapshot: TransportInfo = Object.freeze({
    /** Returns the construction-time transport kind. */
    kind(): string {
      return kind
    },
    /** Returns the provider's current validated endpoint. */
    endpoint(): string {
      return readText(info, endpointReader, "endpoint", MaximumEndpointBytes)
    },
    /** Returns the construction-time operation. */
    operation(): string {
      return operation
    },
    /** Reads and defensively snapshots the provider's current request headers. */
    requestHeaders() {
      return readMetadata(info, requestHeadersReader, "requestHeaders")
    },
    /** Reads and defensively snapshots the provider's current reply headers. */
    replyHeaders() {
      return readMetadata(info, replyHeadersReader, "replyHeaders")
    }
  })
  TransportInfoBrand.add(snapshot)
  return snapshot
}

/** Reads one package-owned TransportInfo domain from Context. */
function contextTransportInfo(ctx: Context, key: object): TransportInfo | null {
  const value = ctx.value(key)
  return isTransportInfo(value) && TransportInfoBrand.has(value) ? value : null
}

/** Returns a child Context carrying one isolated client TransportInfo facade. */
export function newClientContext(ctx: Context, info: TransportInfo): Context {
  return withValue(ctx, clientContextKey, snapshotTransportInfo(info))
}

/** Returns client TransportInfo carried by ctx, or null when absent. */
export function fromClientContext(ctx: Context): TransportInfo | null {
  return contextTransportInfo(ctx, clientContextKey)
}

/** Returns a child Context carrying one isolated server TransportInfo facade. */
export function newServerContext(ctx: Context, info: TransportInfo): Context {
  return withValue(ctx, serverContextKey, snapshotTransportInfo(info))
}

/** Returns server TransportInfo carried by ctx, or null when absent. */
export function fromServerContext(ctx: Context): TransportInfo | null {
  return contextTransportInfo(ctx, serverContextKey)
}
