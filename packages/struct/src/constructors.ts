import { issue } from "./errors"
import { resolveStructFields } from "./fields"
import { castStruct, createPrimitiveStruct, DEFAULT_FLAGS, makeStruct } from "./runtime"
import { assertStruct } from "./shape"
import { DEFINITION } from "./symbols"
import type {
  ArrayStruct,
  DiscriminatedUnionStruct,
  IntersectionInput,
  IntersectionOutput,
  LiteralValue,
  NumberStruct,
  ObjectStruct,
  ObjectShape,
  PresentValue,
  RecordStruct,
  RuntimeStruct,
  Struct,
  StructDefinition,
  StructLike,
  StringStruct,
  TupleStruct,
  UnionStruct,
  UnknownStruct
} from "./types"
import { describeValue, expectedType, failure, isPlainObject, success } from "./utils"

export function createStringStruct(): StringStruct {
  return castStruct<StringStruct>(
    createPrimitiveStruct({
      expected: "string",
      is: (value): value is string => typeof value === "string",
      kind: "string"
    })
  )
}

export function createNumberStruct(): NumberStruct {
  return castStruct<NumberStruct>(
    createPrimitiveStruct({
      expected: "number",
      is: (value): value is number => typeof value === "number" && !Number.isNaN(value),
      kind: "number"
    })
  )
}

export function createBooleanStruct(): Struct<boolean, boolean> {
  return createPrimitiveStruct({
    expected: "boolean",
    is: (value): value is boolean => typeof value === "boolean",
    kind: "boolean"
  })
}

export function createNullStruct(): Struct<null, null> {
  return castStruct<Struct<null, null>>(
    createPrimitiveStruct({
      expected: "null",
      is: (value): value is null => value === null,
      kind: "null"
    })
  )
}

// oxlint-disable-next-line typescript/no-explicit-any
export function createAnyStruct(): Struct<PresentValue, any> {
  // Type boundary: struct.any() intentionally models an unconstrained decoded value; any is the correct
  // representation of "no static type information" at the output boundary.
  // oxlint-disable-next-line typescript/no-explicit-any
  return castStruct<Struct<PresentValue, any>>(
    makeStruct({
      flags: DEFAULT_FLAGS,
      kind: "any"
    })
  )
}

export function createUnknownStruct(): UnknownStruct {
  return castStruct<UnknownStruct>(
    makeStruct({
      flags: DEFAULT_FLAGS,
      kind: "unknown"
    })
  )
}

export function createLiteralStruct<const T extends LiteralValue>(value: T): Struct<T, T> {
  return castStruct<Struct<T, T>>(
    makeStruct({
      expected: describeValue(value),
      flags: DEFAULT_FLAGS,
      kind: "literal",
      value
    })
  )
}

export function createEnumStruct<const T extends readonly [string, ...string[]]>(
  values: T
): Struct<T[number], T[number]> {
  const enumValues = [...values] as unknown as T
  return castStruct<Struct<T[number], T[number]>>(
    makeStruct({
      expected: enumValues.map((item) => JSON.stringify(item)).join(" | "),
      flags: DEFAULT_FLAGS,
      kind: "enum",
      values: enumValues
    })
  )
}

export function createObjectEnumStruct<const T extends { [key: string]: number | string }>(
  value: T
): Struct<T[keyof T], T[keyof T]> {
  const values = Object.values(value).filter(
    (item): item is T[keyof T] => typeof item === "number" || typeof item === "string"
  )

  if (values.length === 0) {
    throw new TypeError("enum struct requires at least one string or number value")
  }

  return castStruct<Struct<T[keyof T], T[keyof T]>>(
    makeStruct({
      expected: values.map((item) => JSON.stringify(item)).join(" | "),
      flags: DEFAULT_FLAGS,
      kind: "enum",
      values: values as [T[keyof T], ...T[keyof T][]]
    })
  )
}

export function createArrayStruct<S extends StructLike<unknown, unknown, boolean>>(
  item: S
): ArrayStruct<S> {
  assertStruct(item, "array item")

  return castStruct<ArrayStruct<S>>(
    makeStruct({
      flags: DEFAULT_FLAGS,
      item,
      kind: "array"
    })
  )
}

export function createObjectStruct<T extends ObjectShape>(shape: T): ObjectStruct<T> {
  if (!isPlainObject(shape)) {
    throw new TypeError("object struct requires a plain object")
  }

  const declaredDescriptors = Object.getOwnPropertyDescriptors(shape)
  const runtime = makeStruct({
    cache: { declaredDescriptors },
    flags: DEFAULT_FLAGS,
    kind: "object",
    shape
  })
  if (
    Object.values(declaredDescriptors).every((descriptor) => typeof descriptor.get !== "function")
  ) {
    resolveStructFields(
      runtime,
      runtime[DEFINITION] as Extract<StructDefinition, { kind: "object" }>
    )
  }
  return castStruct<ObjectStruct<T>>(runtime)
}

export function createRecordStruct<S extends StructLike<unknown, unknown, boolean>>(
  value: S
): RecordStruct<S> {
  assertStruct(value, "record value")

  return castStruct<RecordStruct<S>>(
    makeStruct({
      flags: DEFAULT_FLAGS,
      kind: "record",
      value
    })
  )
}

export function createTupleStruct<
  const T extends readonly [
    StructLike<unknown, unknown, boolean>,
    ...StructLike<unknown, unknown, boolean>[]
  ]
>(items: T): TupleStruct<T> {
  const tupleItems = [...items] as unknown as T
  for (const item of tupleItems) {
    assertStruct(item, "tuple item")
  }

  return castStruct<TupleStruct<T>>(
    makeStruct({
      flags: DEFAULT_FLAGS,
      items: tupleItems,
      kind: "tuple"
    })
  )
}

export function createUnionStruct<
  const T extends readonly [
    StructLike<unknown, unknown, boolean>,
    ...StructLike<unknown, unknown, boolean>[]
  ]
>(options: T): UnionStruct<T> {
  const unionOptions = [...options] as unknown as T
  for (const option of unionOptions) {
    assertStruct(option, "or option")
  }

  return castStruct<UnionStruct<T>>(
    makeStruct({
      expected: unionOptions
        .map((option) => expectedType((option as unknown as RuntimeStruct)[DEFINITION]))
        .join(" | "),
      flags: DEFAULT_FLAGS,
      kind: "or",
      options: unionOptions,
      uniformIdentityEncode: computeUniformIdentityEncode(unionOptions)
    })
  )
}

function computeUniformIdentityEncode(
  options: readonly [
    StructLike<unknown, unknown, boolean>,
    ...StructLike<unknown, unknown, boolean>[]
  ]
): boolean {
  const first = options[0] as unknown as RuntimeStruct
  const firstDefinition = first[DEFINITION]
  if (firstDefinition.kind === "object") {
    const firstShape = identityEncodeShape(first)
    if (!firstShape) {
      return false
    }
    for (let index = 1; index < options.length; index += 1) {
      const shape = identityEncodeShape(options[index] as unknown as RuntimeStruct)
      if (!shape || shape.size !== firstShape.size) {
        return false
      }
      for (const [key, kind] of firstShape) {
        if (shape.get(key) !== kind) {
          return false
        }
      }
    }
    return true
  }

  return options.every((option) =>
    isIdentityEncodeKind((option as unknown as RuntimeStruct)[DEFINITION].kind)
  )
}

function identityEncodeShape(
  struct: RuntimeStruct
): Map<string, StructDefinition["kind"]> | undefined {
  const definition = struct[DEFINITION]
  if (definition.kind !== "object") {
    return undefined
  }

  const encoded = new Map<string, StructDefinition["kind"]>()
  for (const [key, descriptor] of Object.entries(definition.cache.declaredDescriptors)) {
    if (typeof descriptor.get === "function") {
      return undefined
    }
    const fieldDefinition = (descriptor.value as RuntimeStruct | undefined)?.[DEFINITION]
    if (!fieldDefinition || !isIdentityEncodeKind(fieldDefinition.kind)) {
      return undefined
    }
    encoded.set(key, fieldDefinition.kind)
  }
  return encoded
}

function isIdentityEncodeKind(kind: StructDefinition["kind"]): boolean {
  return (
    kind === "any" ||
    kind === "boolean" ||
    kind === "enum" ||
    kind === "literal" ||
    kind === "null" ||
    kind === "number" ||
    kind === "string" ||
    kind === "unknown"
  )
}

type RequiredDiscriminatorOption<
  TDiscriminator extends string,
  TOption extends ObjectStruct<ObjectShape>
> =
  TOption extends ObjectStruct<infer TShape>
    ? TDiscriminator extends keyof TShape
      ? TShape[TDiscriminator] extends StructLike<infer TInput, unknown, false>
        ? undefined extends TInput
          ? never
          : null extends TInput
            ? [TInput] extends [null]
              ? TOption
              : never
            : TOption
        : never
      : never
    : never

type RequiredDiscriminatorOptions<
  TDiscriminator extends string,
  TOptions extends readonly ObjectStruct<ObjectShape>[]
> = {
  [K in keyof TOptions]: TOptions[K] extends ObjectStruct<ObjectShape>
    ? RequiredDiscriminatorOption<TDiscriminator, TOptions[K]>
    : never
}

export function createDiscriminatedUnionStruct<
  const TDiscriminator extends string,
  const TOptions extends readonly [ObjectStruct<ObjectShape>, ...ObjectStruct<ObjectShape>[]]
>(
  discriminator: TDiscriminator,
  options: TOptions & RequiredDiscriminatorOptions<TDiscriminator, TOptions>
): DiscriminatedUnionStruct<TOptions> {
  const unionOptions = [...options] as unknown as TOptions
  const map = new Map<unknown, StructLike<unknown, unknown, boolean>>()
  const wireKeyByValue = new Map<unknown, string>()
  const discriminatorWireKeys: string[] = []
  const seenWireKeys = new Set<string>()
  const values: unknown[] = []

  for (const option of unionOptions) {
    assertStruct(option, "discriminatedUnion option")
    const optionDef = (option as unknown as RuntimeStruct)[DEFINITION]
    /* istanbul ignore next -- type-safe: createDiscriminatedUnionStruct only accepts ObjectStruct */
    if (optionDef.kind !== "object") {
      throw new TypeError("discriminatedUnion options must be object structs")
    }
    const descriptor = optionDef.cache.declaredDescriptors[discriminator]
    const fieldStruct = (
      descriptor && typeof descriptor.get === "function"
        ? descriptor.get.call(optionDef.shape)
        : descriptor?.value
    ) as RuntimeStruct | undefined
    if (!fieldStruct) {
      throw new TypeError(
        `discriminatedUnion option missing discriminator field "${discriminator}"`
      )
    }
    const fieldDef = fieldStruct[DEFINITION]
    /* istanbul ignore next -- type-safe: discriminator is checked at compile time */
    if (fieldDef.kind !== "literal") {
      throw new TypeError(
        `discriminatedUnion option discriminator "${discriminator}" must be a literal struct`
      )
    }
    if (fieldDef.flags.optional || (fieldDef.flags.nullable && fieldDef.value !== null)) {
      throw new TypeError(
        `discriminatedUnion option discriminator "${discriminator}" must be a required literal struct`
      )
    }
    if (map.has(fieldDef.value)) {
      throw new TypeError(
        `discriminatedUnion duplicate discriminator value: ${JSON.stringify(fieldDef.value)}`
      )
    }
    const wireKey = fieldDef.alias ?? discriminator
    map.set(fieldDef.value, option)
    wireKeyByValue.set(fieldDef.value, wireKey)
    if (!seenWireKeys.has(wireKey)) {
      seenWireKeys.add(wireKey)
      discriminatorWireKeys.push(wireKey)
    }
    values.push(fieldDef.value)
  }

  return castStruct<DiscriminatedUnionStruct<TOptions>>(
    makeStruct({
      discriminator,
      discriminatorWireKeys,
      expected: values.map((item) => JSON.stringify(item)).join(" | "),
      flags: DEFAULT_FLAGS,
      kind: "discriminatedUnion",
      map,
      options: unionOptions,
      wireKeyByValue
    })
  )
}

export function createBlobStruct(): Struct<Blob, Blob> {
  return createPrimitiveStruct({
    expected: "Blob",
    is: (value): value is Blob => value instanceof Blob,
    kind: "blob",
    runtimeIs: (value): value is Blob => typeof Blob !== "undefined" && value instanceof Blob
  })
}

export function createBigIntStruct(): Struct<bigint | string, bigint> {
  return createPrimitiveStruct({
    decode: (input, path) => {
      if (typeof input === "bigint") {
        return success(input)
      }
      try {
        return success(BigInt(input as string))
      } catch {
        return failure(issue(path, "invalid_type", "bigint", input))
      }
    },
    encode: (value) => value.toString(),
    expected: "bigint",
    is: (value): value is bigint | string => typeof value === "bigint" || typeof value === "string",
    kind: "bigint",
    runtimeIs: (value): value is bigint => typeof value === "bigint"
  }) as Struct<bigint | string, bigint>
}

export function createDateStruct(): Struct<Date | number | string, Date> {
  return createPrimitiveStruct({
    decode: (input, path) => {
      const date = input instanceof Date ? input : new Date(input as never)
      if (Number.isNaN(date.getTime())) {
        return failure(issue(path, "invalid_type", "Date", input))
      }
      return success(date)
    },
    encode: (value) => value.toISOString(),
    expected: "Date",
    is: (value): value is Date | number | string =>
      value instanceof Date || typeof value === "string" || typeof value === "number",
    kind: "date",
    runtimeIs: (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime())
  }) as Struct<Date | number | string, Date>
}

export function createIntersectionStruct<
  const T extends readonly [
    StructLike<unknown, unknown, boolean>,
    ...StructLike<unknown, unknown, boolean>[]
  ]
>(...structs: T): Struct<IntersectionInput<T>, IntersectionOutput<T>> {
  if (structs.length === 0) {
    throw new TypeError("intersection requires at least one struct")
  }

  for (const struct of structs) {
    assertStruct(struct, "intersection item")
  }

  if (structs.length === 1) {
    return castStruct<Struct<IntersectionInput<T>, IntersectionOutput<T>>>(
      structs[0] as unknown as RuntimeStruct
    )
  }

  const flattenable = structs.every(isObjectIntersectionSide)
  const options = flattenable ? flattenObjectIntersectionSides(structs) : structs
  // Only real object structs can share the object frame. A kept intersection is parsed whole.
  const objectSides = options.every(
    (side) => (side as unknown as RuntimeStruct)[DEFINITION].kind === "object"
  )

  return castStruct<Struct<IntersectionInput<T>, IntersectionOutput<T>>>(
    makeStruct({
      expected: structs
        .map((item) => expectedType((item as unknown as RuntimeStruct)[DEFINITION]))
        .join(" & "),
      flags: DEFAULT_FLAGS,
      kind: "intersection",
      objectSides,
      options: options as [
        StructLike<unknown, unknown, boolean>,
        ...StructLike<unknown, unknown, boolean>[]
      ]
    })
  )
}

function isObjectIntersectionSide(struct: StructLike<unknown, unknown, boolean>): boolean {
  const definition = (struct as unknown as RuntimeStruct)[DEFINITION]
  return (
    definition.kind === "object" || (definition.kind === "intersection" && definition.objectSides)
  )
}

function flattenObjectIntersectionSides(
  structs: readonly StructLike<unknown, unknown, boolean>[]
): StructLike<unknown, unknown, boolean>[] {
  const options: StructLike<unknown, unknown, boolean>[] = []
  for (const struct of structs) {
    const definition = (struct as unknown as RuntimeStruct)[DEFINITION]
    // Presence flags live on the intersection itself. Spreading its options would drop them.
    if (
      definition.kind === "intersection" &&
      definition.objectSides &&
      !definition.flags.nullable &&
      !definition.flags.optional
    ) {
      options.push(...definition.options)
    } else {
      options.push(struct)
    }
  }
  return options
}

export function createFileStruct(): Struct<File, File> {
  return createPrimitiveStruct({
    expected: "File",
    is: (value): value is File => value instanceof File,
    kind: "file",
    runtimeIs: (value): value is File => typeof File !== "undefined" && value instanceof File
  })
}

export function createArrayBufferStruct(): Struct<ArrayBuffer, ArrayBuffer> {
  return createPrimitiveStruct({
    expected: "ArrayBuffer",
    is: (value): value is ArrayBuffer => value instanceof ArrayBuffer,
    kind: "arrayBuffer",
    runtimeIs: (value): value is ArrayBuffer =>
      typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer
  })
}
