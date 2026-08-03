import { encodeValue } from "../encode"
import { StructError } from "../errors"
import { resolveStructFields } from "../fields"
import type { ResolvedStructField } from "../fields"
import { isObjectStruct, parseStructValue } from "../introspection"
import { matchesDefinition } from "../match"
import { parseValue } from "../parse"
import { resolveObjectShape } from "../shape"
import { DEFINITION } from "../symbols"
import type { AnyStructLike, DiscriminatedUnionDefinition, Path, RuntimeStruct } from "../types"
import { hasOwnKey, isObjectIntersectionStruct, isPlainObject } from "../utils"
import { assertPortableValueGraph } from "../value-graph"
import { goFoldCodePoint } from "./go-unicode-fold"

export function encodeObjectByAlias(
  struct: AnyStructLike,
  value: unknown,
  label = "json"
): unknown {
  assertPortableValueGraph(value)
  return encodeObjectByAliasValue(struct, value, label)
}

function encodeObjectByAliasValue(struct: AnyStructLike, value: unknown, label: string): unknown {
  if (!isObjectStruct(struct)) {
    return encodeAliasedField(struct, value, label)
  }

  const definition = (struct as unknown as RuntimeStruct)[DEFINITION]
  if (
    (value === null && definition.flags.nullable) ||
    (value === undefined && definition.flags.optional)
  ) {
    return value
  }

  assertPlainObject(value, `${label} encode expects object value`)

  return mapAliasedObjectFields(
    struct as unknown as RuntimeStruct,
    value,
    (fieldStruct, fieldValue) => encodeAliasedField(fieldStruct, fieldValue, label)
  )
}

export function decodeObjectByAlias(
  struct: AnyStructLike,
  value: unknown,
  label = "json"
): unknown {
  assertPortableValueGraph(value)
  if (!isObjectStruct(struct)) {
    return parseStructValue(struct, decodeAliasedField(struct, value, label, []))
  }
  if (value === null || value === undefined) {
    return parseStructValue(struct, value)
  }
  return parseStructValue(struct, normalizeObjectByAlias(struct, value, label, []))
}

function normalizeObjectByAlias(
  struct: AnyStructLike,
  value: unknown,
  label: string,
  path: Path,
  previous?: { [key: string]: unknown }
): { [key: string]: unknown } {
  assertPlainObject(value, `${label} decode expects object value`)

  const runtime = struct as unknown as RuntimeStruct
  const definition = runtime[DEFINITION]
  if (definition.kind !== "object") {
    throw new TypeError(`${label} decode expects object struct`)
  }

  const normalized: { [key: string]: unknown } = previous ?? Object.create(null)
  const fields = resolveStructFields(runtime, definition)

  for (const wireKey of Object.keys(value)) {
    const field = findWireField(fields, wireKey)
    if (field) {
      const hasPrevious = hasOwnKey(normalized, field.key)
      if (hasPrevious) {
        const result = parseValue(
          field.struct as unknown as RuntimeStruct,
          normalized[field.key],
          [...path, field.key],
          "field"
        )
        if (!result.ok) {
          throw new StructError(result.issues)
        }
      }
      normalized[field.key] = decodeRepeatedAliasedField(
        field.struct,
        hasPrevious ? normalized[field.key] : undefined,
        hasPrevious,
        value[wireKey],
        label,
        [...path, field.key]
      )
    }
  }

  return normalized
}

function decodeRepeatedAliasedField(
  struct: AnyStructLike,
  previous: unknown,
  hasPrevious: boolean,
  value: unknown,
  label: string,
  path: Path
): unknown {
  const runtime = struct as unknown as RuntimeStruct
  const definition = runtime[DEFINITION]

  if (value === null) {
    if (
      hasPrevious &&
      !definition.flags.nullable &&
      (definition.kind === "object" ||
        definition.kind === "tuple" ||
        definition.kind === "enum" ||
        definition.kind === "literal" ||
        definition.kind === "bigint" ||
        definition.kind === "boolean" ||
        definition.kind === "date" ||
        definition.kind === "number" ||
        definition.kind === "string")
    ) {
      return previous
    }
    return null
  }

  if (definition.kind === "array" && Array.isArray(value)) {
    const previousItems = hasPrevious && Array.isArray(previous) ? previous : []
    return value.map((item, index) =>
      decodeRepeatedAliasedField(
        definition.item,
        previousItems[index],
        index < previousItems.length,
        item,
        label,
        [...path, index]
      )
    )
  }

  if (definition.kind === "tuple" && Array.isArray(value)) {
    const previousItems = hasPrevious && Array.isArray(previous) ? previous : []
    return value.map((item, index) => {
      const itemStruct = definition.items[index]
      return itemStruct
        ? decodeRepeatedAliasedField(
            itemStruct,
            previousItems[index],
            index < previousItems.length,
            item,
            label,
            [...path, index]
          )
        : item
    })
  }

  if (definition.kind === "object" && isPlainObject(value)) {
    return normalizeObjectByAlias(
      runtime,
      value,
      label,
      path,
      hasPrevious && isPlainObject(previous) ? previous : undefined
    )
  }

  if (definition.kind === "record" && isPlainObject(value)) {
    const output: { [key: string]: unknown } =
      hasPrevious && isPlainObject(previous) ? previous : Object.create(null)
    for (const [key, entry] of Object.entries(value)) {
      output[key] = decodeRepeatedAliasedField(definition.value, undefined, false, entry, label, [
        ...path,
        key
      ])
    }
    return output
  }

  return decodeAliasedField(runtime, value, label, path)
}

function findWireField(
  fields: readonly ResolvedStructField[],
  wireKey: string
): ResolvedStructField | undefined {
  for (const field of fields) {
    if (field.wireKey === wireKey) {
      return field
    }
  }

  const foldedKey = unicodeSimpleFoldKey(wireKey)
  for (const field of fields) {
    if (unicodeSimpleFoldKey(field.wireKey) === foldedKey) {
      return field
    }
  }
  return undefined
}

function unicodeSimpleFoldKey(value: string): string {
  return Array.from(value, unicodeSimpleFoldRune).join("")
}

function unicodeSimpleFoldRune(rune: string): string {
  const codePoint = rune.codePointAt(0)
  if (codePoint === undefined) {
    return rune
  }
  const folded = goFoldCodePoint(codePoint)
  return folded === codePoint ? rune : String.fromCodePoint(folded)
}

export function mapAliasedObjectFields(
  struct: RuntimeStruct,
  value: { [key: string]: unknown },
  encodeChild: (struct: RuntimeStruct, value: unknown) => unknown
): { [key: string]: unknown } {
  const output: { [key: string]: unknown } = Object.create(null)
  const definition = struct[DEFINITION]
  if (definition.kind !== "object") {
    throw new TypeError("json encode expects object struct")
  }

  for (const field of resolveStructFields(struct, definition)) {
    if (!hasOwnKey(value, field.key)) {
      continue
    }

    const fieldValue = value[field.key]
    if (typeof fieldValue === "undefined") {
      continue
    }

    output[field.wireKey] = encodeChild(field.struct, fieldValue)
  }

  return output
}

export function assertPlainObject(
  value: unknown,
  message: string
): asserts value is { [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(message)
  }
}

function encodeAliasedField(struct: AnyStructLike, value: unknown, label: string): unknown {
  if (isObjectStruct(struct)) {
    return encodeObjectByAliasValue(struct, value, label)
  }

  return encodeValue(struct as unknown as RuntimeStruct, value, {
    encodeObject: (objectStruct, objectValue, encodeChild) =>
      mapAliasedObjectFields(objectStruct, objectValue, encodeChild)
  })
}

function decodeAliasedField(
  struct: AnyStructLike,
  value: unknown,
  label: string,
  path: Path
): unknown {
  const runtime = struct as unknown as RuntimeStruct
  const definition = runtime[DEFINITION]

  switch (definition.kind) {
    case "object":
      return value === null || value === undefined
        ? value
        : normalizeObjectByAlias(runtime, value, label, path)

    case "array":
      return Array.isArray(value)
        ? value.map((item, index) =>
            decodeAliasedField(definition.item, item, label, [...path, index])
          )
        : value

    case "tuple":
      return Array.isArray(value)
        ? value.map((item, index) => {
            const itemStruct = definition.items[index]
            return itemStruct ? decodeAliasedField(itemStruct, item, label, [...path, index]) : item
          })
        : value

    case "record": {
      if (!isPlainObject(value)) {
        return value
      }
      const output: { [key: string]: unknown } = Object.create(null)
      for (const [key, entry] of Object.entries(value)) {
        output[key] = decodeRepeatedAliasedField(definition.value, undefined, false, entry, label, [
          ...path,
          key
        ])
      }
      return output
    }

    case "or":
      for (const option of definition.options) {
        const decoded = tryDecodeAliasedField(option, value, label, path)
        if (!decoded.ok) {
          continue
        }
        const optionRuntime = option as unknown as RuntimeStruct
        if (matchesDefinition(optionRuntime[DEFINITION], decoded.value, optionRuntime)) {
          return decoded.value
        }
      }
      return value

    case "discriminatedUnion": {
      const routed = readDiscriminatorWireValue(definition, value)
      if (routed.ok) {
        return decodeAliasedField(routed.option, value, label, path)
      }
      if (routed.ambiguous) {
        throw new TypeError("ambiguous discriminated union discriminator")
      }
      if (routed.suppressed) {
        return omitRawDiscriminator(value, definition.discriminator)
      }
      return value
    }

    case "intersection": {
      const leftDecoded = decodeAliasedField(definition.left, value, label, path)
      const rightDecoded = decodeAliasedField(definition.right, value, label, path)
      return isObjectIntersectionStruct(definition.left) &&
        isObjectIntersectionStruct(definition.right) &&
        isPlainObject(leftDecoded) &&
        isPlainObject(rightDecoded)
        ? { ...leftDecoded, ...rightDecoded }
        : rightDecoded
    }

    default:
      return value
  }
}

function readDiscriminatorWireValue(
  definition: DiscriminatedUnionDefinition,
  value: unknown
): { ok: true; option: RuntimeStruct } | { ok: false; ambiguous: boolean; suppressed: boolean } {
  if (!isPlainObject(value)) {
    return { ambiguous: false, ok: false, suppressed: false }
  }

  let matched: RuntimeStruct | undefined
  let suppressed = false
  for (const option of definition.options) {
    const runtime = option as unknown as RuntimeStruct
    const optionDefinition = runtime[DEFINITION]
    if (optionDefinition.kind !== "object") {
      continue
    }
    const fields = resolveStructFields(runtime, optionDefinition)
    const discriminator = fields.find((field) => field.key === definition.discriminator)
    let selected: { found: boolean; value: unknown }
    if (discriminator) {
      selected = readWireFieldValue(value, fields, discriminator)
    } else {
      const shape = resolveObjectShape(runtime, optionDefinition)
      if (Object.hasOwn(shape, definition.discriminator)) {
        suppressed = true
        continue
      }
      selected = readWireKeyValue(value, definition.discriminator)
    }
    if (!selected.found) {
      continue
    }

    const candidate = definition.map.get(selected.value) as RuntimeStruct | undefined
    if (!candidate) {
      continue
    }
    if (hasSuppressedDiscriminator(candidate, definition.discriminator)) {
      suppressed = true
      continue
    }
    if (matched && matched !== candidate) {
      return { ambiguous: true, ok: false, suppressed }
    }
    matched = candidate
  }

  return matched ? { ok: true, option: matched } : { ambiguous: false, ok: false, suppressed }
}

function hasSuppressedDiscriminator(runtime: RuntimeStruct, discriminator: string): boolean {
  const definition = runtime[DEFINITION]
  if (definition.kind !== "object") {
    return false
  }
  const shape = resolveObjectShape(runtime, definition)
  return (
    Object.hasOwn(shape, discriminator) &&
    !resolveStructFields(runtime, definition).some((field) => field.key === discriminator)
  )
}

function omitRawDiscriminator(value: unknown, discriminator: string): unknown {
  if (!isPlainObject(value)) {
    return value
  }
  const output: { [key: string]: unknown } = Object.create(null)
  for (const [key, entry] of Object.entries(value)) {
    if (key !== discriminator) {
      output[key] = entry
    }
  }
  return output
}

function readWireFieldValue(
  value: { [key: string]: unknown },
  fields: readonly ResolvedStructField[],
  target: ResolvedStructField
): { found: boolean; value: unknown } {
  let found = false
  let selected: unknown
  for (const wireKey of Object.keys(value)) {
    if (findWireField(fields, wireKey) === target) {
      found = true
      selected = value[wireKey]
    }
  }
  return { found, value: selected }
}

function readWireKeyValue(
  value: { [key: string]: unknown },
  target: string
): { found: boolean; value: unknown } {
  const foldedTarget = unicodeSimpleFoldKey(target)
  let found = false
  let selected: unknown
  for (const wireKey of Object.keys(value)) {
    if (wireKey === target || unicodeSimpleFoldKey(wireKey) === foldedTarget) {
      found = true
      selected = value[wireKey]
    }
  }
  return { found, value: selected }
}

function tryDecodeAliasedField(
  struct: AnyStructLike,
  value: unknown,
  label: string,
  path: Path
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: decodeAliasedField(struct, value, label, path) }
  } catch {
    return { ok: false }
  }
}
