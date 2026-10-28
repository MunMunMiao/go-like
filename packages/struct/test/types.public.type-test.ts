import { describe, expectTypeOf, it } from "bun:test"
import {
  StructError,
  struct,
  type ErrorMap,
  type Infer,
  type ObjectStruct,
  type ParseResult,
  type StructInput,
  type StructIssue,
  type StructLike
} from "../src/index"

// @ts-expect-error setErrorMap was removed; pass errorMap to one struct.parse call.
import type { setErrorMap } from "../src/index"

// @ts-expect-error ObjectShape is internal.
import type { ObjectShape } from "../src/index"

// @ts-expect-error RequestBodyCodec was removed with the HTTP body wrappers.
import type { RequestBodyCodec } from "../src/index"

// @ts-expect-error ContentCodecKind was removed with the HTTP body wrappers.
import type { ContentCodecKind } from "../src/index"

describe("struct public API", () => {
  it("exports struct, Infer, and error types", () => {
    const Id = struct.string()
    const User = struct.object({
      id: Id,
      name: struct.string().optional(),
      note: struct.string().null(),
      bio: struct.string().nullish()
    })

    expectTypeOf<Infer<typeof User>>().toEqualTypeOf<{
      id: string
      name?: string
      note: string | null
      bio?: string | null
    }>()
    expectTypeOf<StructInput<typeof User>>().toEqualTypeOf<{
      id: string
      name?: string
      note: string | null
      bio?: string | null
    }>()
    expectTypeOf<typeof User>().toMatchTypeOf<ObjectStruct<{ id: typeof Id }>>()
    expectTypeOf<typeof User>().toMatchTypeOf<StructLike>()
    expectTypeOf(struct.parse(User, { id: "u_1", note: null })).toEqualTypeOf<
      ParseResult<Infer<typeof User>>
    >()
    expectTypeOf<ParseResult<{ id: string }>>().toEqualTypeOf<
      [error: null, value: { id: string }] | [error: StructError, value: undefined]
    >()
    expectTypeOf(StructError).toBeConstructibleWith([] as StructIssue[])
    expectTypeOf<ErrorMap>().toBeFunction()
  })

  it("narrows a parse tuple so a failure value is undefined", () => {
    const User = struct.object({ id: struct.string() })
    const result = struct.parse(User, {})

    if (result[0]) {
      expectTypeOf(result[0]).toEqualTypeOf<StructError>()
      expectTypeOf(result[1]).toEqualTypeOf<undefined>()
    } else {
      expectTypeOf(result[0]).toEqualTypeOf<null>()
      expectTypeOf(result[1]).toEqualTypeOf<{ id: string }>()
    }
  })
})

export type MissingSetErrorMap = setErrorMap
export type MissingObjectShape = ObjectShape
export type MissingRequestBodyCodec = RequestBodyCodec
export type MissingContentCodecKind = ContentCodecKind
