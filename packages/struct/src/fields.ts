import { resolveObjectShape } from "./shape"
import { DEFINITION } from "./symbols"
import type { ObjectDefinition, RuntimeStruct } from "./types"

export interface ResolvedStructField {
  readonly alias: string | undefined
  readonly key: string
  readonly struct: RuntimeStruct
  readonly wireKey: string
}

export function getWireKey(fieldKey: string, alias: string | undefined): string {
  return alias || fieldKey
}

export function resolveStructFields(
  struct: RuntimeStruct,
  definition: ObjectDefinition
): readonly ResolvedStructField[] {
  const cached = definition.cache.fields
  if (cached) {
    return cached
  }

  const shape = definition.cache.resolvedShape ?? resolveObjectShape(struct, definition)
  const candidates = Object.freeze(
    Object.entries(shape).map(([key, field]) => {
      const runtime = field as unknown as RuntimeStruct
      const alias = runtime[DEFINITION].alias || undefined
      return Object.freeze({
        alias,
        key,
        struct: runtime,
        wireKey: getWireKey(key, alias)
      })
    })
  )
  const fields = Object.freeze(selectDominantFields(candidates))

  definition.cache.fields = fields
  return fields
}

function selectDominantFields(
  fields: readonly ResolvedStructField[]
): readonly ResolvedStructField[] {
  const groups = new Map<string, ResolvedStructField[]>()
  for (const field of fields) {
    const group = groups.get(field.wireKey)
    if (group) {
      group.push(field)
    } else {
      groups.set(field.wireKey, [field])
    }
  }

  return fields.filter((field) => {
    const group = groups.get(field.wireKey) as ResolvedStructField[]
    if (group.length === 1) {
      return true
    }
    const tagged = group.filter((candidate) => candidate.alias !== undefined)
    return tagged.length === 1 && tagged[0] === field
  })
}
