import { callStackStructError, isCallStackOverflow } from "../errors"
import { encodeValue } from "../encode"
import { mapAliasedObjectFields } from "../fields"
import { DEFINITION } from "../symbols"
import { assertPortableValueGraph, enterEncode, withEncodeGraph } from "../value-graph"

import { isObjectStruct, parseStructValue } from "../introspection"
import type { AnyStructLike, RuntimeStruct } from "../types"

export { mapAliasedObjectFields } from "../fields"

export const ALIAS_ENCODE_OPTIONS = { encodeObject: mapAliasedObjectFields }

/** Encodes by wire alias; checked skips the graph scan for values parseStructValue() produced. */
export function encodeObjectByAlias(
  struct: AnyStructLike,
  value: unknown,
  label = "json",
  checked = false
): unknown {
  try {
    return encodeAliased(struct, value, label, checked)
  } catch (error) {
    if (isCallStackOverflow(error)) throw callStackStructError(value)
    throw error
  }
}

function encodeAliased(
  struct: AnyStructLike,
  value: unknown,
  label: string,
  checked = false
): unknown {
  if (!checked) assertPortableValueGraph(value)
  if (!isObjectStruct(struct)) {
    return withEncodeGraph(value, () =>
      encodeValue(struct as unknown as RuntimeStruct, value, ALIAS_ENCODE_OPTIONS)
    )
  }

  const definition = (struct as unknown as RuntimeStruct)[DEFINITION]
  if (value === null && definition.flags.nullable) {
    return null
  }
  if (value === undefined && definition.flags.optional) {
    return undefined
  }

  assertPlainObject(value, `${label} encode expects object value`)

  aliasLabels.push(label)
  try {
    return withEncodeGraph(value, () =>
      mapAliasedObjectFields(struct as unknown as RuntimeStruct, value, encodeAliasChild)
    )
  } finally {
    aliasLabels.pop()
  }
}

const aliasLabels: string[] = []

function encodeAliasChild(fieldStruct: RuntimeStruct, fieldValue: unknown): unknown {
  const label = aliasLabels[aliasLabels.length - 1] ?? "json"
  const leave = enterEncode(fieldValue)
  try {
    if (!isObjectStruct(fieldStruct)) {
      return encodeValue(fieldStruct, fieldValue, ALIAS_ENCODE_OPTIONS)
    }
    const definition = fieldStruct[DEFINITION]
    if (fieldValue === null && definition.flags.nullable) return null
    assertPlainObject(fieldValue, `${label} encode expects object value`)
    return mapAliasedObjectFields(fieldStruct, fieldValue, encodeAliasChild)
  } finally {
    leave()
  }
}

export function decodeObjectByAlias(struct: AnyStructLike, value: unknown): unknown {
  // parseStructTuple() performs the same portable graph check before parsing.
  return parseStructValue(struct, value, { useAliases: true })
}

export function assertPlainObject(
  value: unknown,
  message: string
): asserts value is { [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(message)
  }
}
