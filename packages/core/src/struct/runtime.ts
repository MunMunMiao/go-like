import { decodeJson } from "./codec/json"
import { isStructError } from "./errors"
import { DEFINITION } from "./symbols"
import type {
  InternalParseResult,
  Path,
  PrimitiveKind,
  RuntimeStruct,
  AnyStruct,
  Struct,
  StructDefinition,
  StructFlags,
  StructLike
} from "./types"

export interface PrimitiveDefinitionInput<K extends PrimitiveKind, TInput, TOutput = TInput> {
  decode?: (value: TInput, path: Path) => InternalParseResult<TOutput>
  encode?: (value: TOutput) => unknown
  expected: string
  is: (value: unknown) => value is TInput
  kind: K
  alias?: string
  runtimeIs?: (value: unknown) => boolean
}

export function createPrimitiveStruct<TInput, TOutput = TInput>(
  definition: PrimitiveDefinitionInput<PrimitiveKind, TInput, TOutput>
): Struct<TInput, TOutput> {
  return castStruct<Struct<TInput, TOutput>>(
    makeStruct({
      ...definition,
      flags: DEFAULT_FLAGS
    } as StructDefinition)
  )
}

export const DEFAULT_FLAGS: StructFlags = { nullable: false, optional: false }

export function castStruct<TStruct extends StructLike>(struct: StructLike): TStruct {
  // Type boundary: all struct runtime objects are created by makeStruct/createPrimitiveStruct; the branded generic surface
  // exists only for compile-time input/output inference and has no distinct runtime representation.
  return struct as TStruct
}

export function makeStruct(definition: StructDefinition): RuntimeStruct {
  const withFlags = (flags: Partial<StructFlags>): RuntimeStruct =>
    makeStruct({
      ...definition,
      flags: {
        ...definition.flags,
        ...flags
      }
    })

  const struct = {
    [DEFINITION]: definition,
    "~standard": {
      version: 1 as const,
      vendor: "go-like",
      /** Decodes by wire alias. A StructError becomes Standard Schema issues. */
      validate(value: unknown) {
        try {
          return { value: decodeJson(struct as unknown as AnyStruct, value) }
        } catch (error) {
          if (isStructError(error)) return { issues: error.issues.map((item) => ({ ...item })) }
          throw error
        }
      }
    },
    alias(name: string) {
      if (typeof name !== "string") {
        throw new TypeError("alias() requires a string name")
      }

      return makeStruct({
        ...definition,
        alias: name
      })
    },
    null() {
      return withFlags({ nullable: true })
    },
    nullable() {
      return withFlags({ nullable: true })
    },
    nullish() {
      return withFlags({ nullable: true, optional: true })
    },
    optional() {
      return withFlags({ optional: true })
    }
  }
  return struct as unknown as RuntimeStruct
}
