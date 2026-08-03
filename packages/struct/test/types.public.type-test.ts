import { describe, expectTypeOf, it } from "bun:test"
import { StructError, struct, type ErrorMap, type Infer, type StructIssue } from "../src/index"

// @ts-expect-error ObjectShape is internal.
import type { ObjectShape } from "../src/index"

// @ts-expect-error RequestBodyCodec was removed with the HTTP body wrappers.
import type { RequestBodyCodec } from "../src/index"

// @ts-expect-error ContentCodecKind was removed with the HTTP body wrappers.
import type { ContentCodecKind } from "../src/index"

describe("struct public API", () => {
  it("exports struct, Infer, and error types", () => {
    const User = struct.object({ id: struct.string() })

    expectTypeOf<Infer<typeof User>>().toEqualTypeOf<{ id: string }>()
    expectTypeOf(StructError).toBeConstructibleWith([] as StructIssue[])
    expectTypeOf<ErrorMap>().toBeFunction()
  })
})

export type MissingObjectShape = ObjectShape
export type MissingRequestBodyCodec = RequestBodyCodec
export type MissingContentCodecKind = ContentCodecKind
