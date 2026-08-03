import {
  createAnyStruct,
  createArrayBufferStruct,
  createArrayStruct,
  createBigIntStruct,
  createBlobStruct,
  createBooleanStruct,
  createDateStruct,
  createDiscriminatedUnionStruct,
  createEnumStruct,
  createFileStruct,
  createIntersectionStruct,
  createLiteralStruct,
  createNullStruct,
  createNumberStruct,
  createObjectEnumStruct,
  createObjectStruct,
  createRecordStruct,
  createStringStruct,
  createTupleStruct,
  createUnionStruct,
  createUnknownStruct
} from "./constructors"
import type { Struct, StructLike, UnionStruct } from "./types"

type EnumValue<T> = T extends readonly (infer U extends string)[]
  ? U
  : T extends { [key: string]: infer U extends number | string }
    ? U
    : never

function structEnum<const T extends readonly [string, ...string[]]>(
  value: T
): Struct<EnumValue<T> | undefined, EnumValue<T>>
function structEnum<const T extends { [key: string]: number | string }>(
  value: T
): Struct<EnumValue<T> | undefined, EnumValue<T>>
function structEnum(value: { [key: string]: number | string } | readonly [string, ...string[]]) {
  if (Array.isArray(value)) {
    return createEnumStruct(value as readonly [string, ...string[]])
  }

  return createObjectEnumStruct(value as { [key: string]: number | string })
}

function structOr<const T extends readonly [StructLike, ...StructLike[]]>(
  ...options: T
): UnionStruct<T> {
  return createUnionStruct(options)
}

export const struct = {
  any: createAnyStruct,
  array: createArrayStruct,
  arrayBuffer: createArrayBufferStruct,
  bigint: createBigIntStruct,
  blob: createBlobStruct,
  boolean: createBooleanStruct,
  date: createDateStruct,
  discriminatedUnion: createDiscriminatedUnionStruct,
  enum: structEnum,
  file: createFileStruct,
  intersection: createIntersectionStruct,
  literal: createLiteralStruct,
  null: createNullStruct,
  number: createNumberStruct,
  object: createObjectStruct,
  or: structOr,
  record: createRecordStruct,
  string: createStringStruct,
  tuple: createTupleStruct,
  unknown: createUnknownStruct
} as const
