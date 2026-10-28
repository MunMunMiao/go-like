import { encodeValue } from "./encode"
import {
  callStackStructError,
  isCallStackOverflow,
  issue,
  runWithErrorMap,
  StructError,
  type ErrorMap
} from "./errors"
import { resolveStructFields } from "./fields"
import { isStruct } from "./guards"
import { parseRootValue } from "./parse"
import { assertStruct } from "./shape"
import { DEFINITION } from "./symbols"
import type { ObjectStruct, ObjectShape, ParseResult, RuntimeStruct, StructLike } from "./types"
import { assertPortableValueGraph, portableValueGraphError, withEncodeGraph } from "./value-graph"

export interface StructField {
  readonly alias: string | undefined
  readonly key: string
  readonly struct: StructLike<unknown, unknown, boolean>
}

export function isObjectStruct(value: unknown): value is ObjectStruct<ObjectShape> {
  return isStruct(value) && (value as RuntimeStruct)[DEFINITION].kind === "object"
}

export { isStruct } from "./guards"
export { PORTABLE_VALUE_GRAPH_DEPTH_LIMIT } from "./value-graph"

export function getStructFields(
  struct: StructLike<unknown, unknown, boolean>
): readonly StructField[] {
  assertStruct(struct, "struct")
  const runtime = struct as unknown as RuntimeStruct
  const definition = runtime[DEFINITION]
  if (definition.kind !== "object") {
    throw new TypeError("object struct is required")
  }

  return Object.freeze(
    resolveStructFields(runtime, definition).map((field) =>
      Object.freeze({
        alias: field.alias,
        key: field.key,
        struct: field.struct as unknown as StructLike<unknown, unknown, boolean>
      })
    )
  )
}

export function encodeStructValue(
  struct: StructLike<unknown, unknown, boolean>,
  value: unknown
): unknown {
  assertStruct(struct, "struct")
  assertPortableValueGraph(value)
  try {
    return withEncodeGraph(value, () => encodeValue(struct as unknown as RuntimeStruct, value))
  } catch (error) {
    if (isCallStackOverflow(error)) throw callStackStructError(value)
    throw error
  }
}

/** Parses one value, stopping at the first issue, and returns `[error, value]`. */
export function parseStructTuple<S extends StructLike<unknown, unknown, boolean>>(
  struct: S,
  value: unknown,
  options?: { aliases?: boolean; errorMap?: ErrorMap }
): ParseResult<S["_struct"]["output"]> {
  assertStruct(struct, "struct")
  const runtime = struct as unknown as RuntimeStruct
  return runWithErrorMap(options?.errorMap, () => {
    const graphError = portableValueGraphError(value)
    if (graphError) {
      return [
        new StructError([issue([], "custom", "safe struct value graph", value, graphError)]),
        undefined
      ]
    }
    try {
      const result = parseRootValue(runtime, value, "value", options?.aliases === true)
      if (result.ok) {
        return [null, result.value as unknown as S["_struct"]["output"]]
      }
      return [new StructError([result.issue]), undefined]
    } catch (error) {
      if (error instanceof StructError) return [error, undefined]
      if (isCallStackOverflow(error)) return [callStackStructError(value), undefined]
      throw error
    }
  })
}

export function parseStructValue(
  struct: StructLike<unknown, unknown, boolean>,
  value: unknown,
  options?: { useAliases?: boolean }
): unknown {
  assertStruct(struct, "struct")
  const [error, output] = parseStructTuple(
    struct,
    value,
    options?.useAliases === true ? { aliases: true } : undefined
  )
  if (error) {
    throw error
  }
  return output
}
