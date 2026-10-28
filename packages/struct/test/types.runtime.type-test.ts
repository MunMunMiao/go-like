import { expectTypeOf } from "bun:test"
import { decodeJson as decodeStructJson } from "../src/codec"
import type { Infer } from "../src/index"

// @ts-expect-error TypeOf is intentionally not part of the public struct API.
import type { TypeOf } from "../src/index"

// @ts-expect-error InputOf is intentionally not part of the public struct API.
import type { InputOf } from "../src/index"

// @ts-expect-error JSON codec helpers are internal runtime behavior, not public struct API.
import type { encodeJson } from "../src/index"

// @ts-expect-error JSON codec helpers are internal runtime behavior, not public struct API.
import type { decodeJson } from "../src/index"

// @ts-expect-error FieldTag was removed with the public tag API.
import type { FieldTag } from "../src/index"

// @ts-expect-error JsonTag was removed with the public tag API.
import type { JsonTag } from "../src/index"

// @ts-expect-error TagNamespace was removed with the public tag API.
import type { TagNamespace } from "../src/index"

// @ts-expect-error tag namespace is no longer part of the public struct API.
import { tag } from "../src/index"

// @ts-expect-error createTagNamespace is no longer part of the public struct API.
import { createTagNamespace } from "../src/index"

// @ts-expect-error getFieldTag is no longer part of the public struct API.
import { getFieldTag } from "../src/index"

// @ts-expect-error getFieldTags is no longer part of the public struct API.
import { getFieldTags } from "../src/index"

import { struct } from "../src/index"

type IsAny<T> = 0 extends 1 & T ? true : false
type StrictEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? IsAny<A> extends IsAny<B>
      ? true
      : false
    : false
type Expect<T extends true> = T

const User = struct.object({
  id: struct.string(),
  name: struct.string().optional()
})

type UserOutput = Infer<typeof User>
expectTypeOf<UserOutput>().toEqualTypeOf<{ id: string; name?: string }>()

const profile = struct.object({
  id: struct.string(),
  nickname: struct.string().optional(),
  score: struct.number()
})

type ProfileCase = Expect<
  StrictEqual<
    Infer<typeof profile>,
    {
      id: string
      nickname?: string
      score: number
    }
  >
>
expectTypeOf(decodeStructJson(profile, {})).toEqualTypeOf<Infer<typeof profile>>()

const dated = struct.date()
type DateCase = Expect<StrictEqual<Infer<typeof dated>, Date>>

const matrix = struct.array(struct.array(struct.object({ name: struct.string() })))

type MatrixCase = Expect<StrictEqual<Infer<typeof matrix>, { name: string }[][]>>

const result = struct.or(struct.string(), struct.number())

type UnionCase = Expect<StrictEqual<Infer<typeof result>, string | number>>
type AnyGuard = Expect<StrictEqual<IsAny<Infer<typeof profile>>, false>>

const aliasedProfile = struct.object({
  displayName: struct.string().alias("display_name")
})
type AliasOutputCase = Expect<StrictEqual<Infer<typeof aliasedProfile>, { displayName: string }>>

const merged = struct.intersection(
  struct.object({ id: struct.string() }),
  struct.object({ name: struct.string() }),
  struct.object({ active: struct.boolean() })
)
const singleIntersection = struct.intersection(struct.object({ id: struct.string() }))

type IntersectionCase = Expect<
  StrictEqual<Infer<typeof merged>, { id: string } & { name: string } & { active: boolean }>
>
type SingleIntersectionCase = Expect<StrictEqual<Infer<typeof singleIntersection>, { id: string }>>

// @ts-expect-error intersection requires at least one struct.
struct.intersection()

export type MissingTypeOf = TypeOf<never>
export type MissingInputOf = InputOf<never>
export type MissingEncodeJson = typeof encodeJson
export type MissingDecodeJson = typeof decodeJson
export type MissingFieldTag = FieldTag
export type MissingJsonTag = JsonTag
export type MissingTagNamespace = TagNamespace

void tag
void createTagNamespace
void getFieldTag
void getFieldTags

// @ts-expect-error primitive constraints were removed from the Go-style API.
struct.string().min(1)

// @ts-expect-error primitive constraints were removed from the Go-style API.
struct.number().int()

// @ts-expect-error primitive constraints were removed from the Go-style API.
struct.array(struct.string()).nonempty()

// @ts-expect-error transform was removed from the Go-style API.
struct.string().transform(
  (value: string) => Number(value),
  (value: number) => String(value)
)

// @ts-expect-error refine was removed from the Go-style API.
struct.string().refine((value: string) => value.length > 0)

// @ts-expect-error parse is internal runtime behavior, not public struct API.
struct.string().parse("x")

// @ts-expect-error key was removed; wire names must use alias().
const missingKeyMethod = struct.string().key
void missingKeyMethod

// @ts-expect-error async parsing is not part of the public struct API.
struct.string().parseAsync("x")

// @ts-expect-error HTTP body codecs are not Struct constructors.
export type MissingJsonBody = typeof struct.json

// @ts-expect-error HTTP body codecs are not Struct constructors.
export type MissingFormDataBody = typeof struct.formData

// @ts-expect-error HTTP body codecs are not Struct constructors.
export type MissingUrlencodedBody = typeof struct.urlencoded

// @ts-expect-error HTTP body codecs are not Struct constructors.
export type MissingTextBody = typeof struct.text

// @ts-expect-error default was removed from the Go-style API.
struct.string().default("default-value")

// @ts-expect-error passthrough was removed from the Go-style API.
struct.object({ id: struct.string() }).passthrough()

// @ts-expect-error strip was removed from the Go-style API.
struct.object({ id: struct.string() }).strip()

// @ts-expect-error object shape utilities were removed from the Go-style API.
struct.object({ id: struct.string() }).pick({ id: true })

// @ts-expect-error struct.recursive was removed from the public API.
struct.recursive(() => struct.object({ id: struct.string() }))

export type Cases =
  | AliasOutputCase
  | AnyGuard
  | DateCase
  | IntersectionCase
  | MatrixCase
  | ProfileCase
  | SingleIntersectionCase
  | UnionCase
