import { describe, expect, test } from "bun:test"
import { StructError, struct } from "../../src/index"
import { decodeJson, encodeJson } from "../../src/codec/json"

describe("codec/json.ts", () => {
  test("maps API JSON field names through alias()", () => {
    const user = struct.object({
      id: struct.number().alias("id"),
      name: struct.string().alias("user_name")
    })

    expect(encodeJson(user, { id: 1, name: "Miao" })).toEqual({
      id: 1,
      user_name: "Miao"
    })
    expect(decodeJson(user, { id: 1, user_name: "Miao" })).toEqual({
      id: 1,
      name: "Miao"
    })
  })

  test("falls back to field names for fields without aliases", () => {
    const user = struct.object({
      page: struct.number(),
      pageSize: struct.number().alias("page_size")
    })

    expect(encodeJson(user, { pageSize: 50, page: 1 })).toEqual({ page_size: 50, page: 1 })
    expect(decodeJson(user, { page_size: 50, page: 1 })).toEqual({ pageSize: 50, page: 1 })
  })

  test('treats alias("") as an untagged natural field name', () => {
    const user = struct.object({ name: struct.string().alias("") })

    expect(encodeJson(user, { name: "Miao" })).toEqual({ name: "Miao" })
    expect(decodeJson(user, { name: "Miao" })).toEqual({ name: "Miao" })
    expect(decodeJson(user, { "": "ignored" })).toEqual({ name: "" })
  })

  test("lets a non-empty alias dominate a natural field with the same wire key", () => {
    const user = struct.object({
      name: struct.string(),
      displayName: struct.string().alias("name")
    })

    expect(encodeJson(user, { name: "natural", displayName: "tagged" })).toEqual({
      name: "tagged"
    })
    expect(decodeJson(user, { name: "wire" })).toEqual({
      name: "",
      displayName: "wire"
    })
  })

  test("excludes two fields with the same non-empty alias", () => {
    const user = struct.object({
      firstName: struct.string().alias("name"),
      displayName: struct.string().alias("name")
    })

    expect(encodeJson(user, { firstName: "first", displayName: "second" })).toEqual({})
    expect(decodeJson(user, { name: "wire" })).toEqual({ firstName: "", displayName: "" })
  })

  test("unknown JSON wire keys are ignored", () => {
    const query = struct.object({
      pageSize: struct.number().alias("page_size")
    })

    expect(decodeJson(query, { page_size: 20, pageSize: 99 })).toEqual({ pageSize: 20 })
  })

  test("does not filter unaliased fields", () => {
    const query = struct.object({
      internal: struct.string(),
      pageSize: struct.number().alias("page_size")
    })

    expect(decodeJson(query, { internal: "kept", page_size: 20 })).toEqual({
      internal: "kept",
      pageSize: 20
    })
    expect(encodeJson(query, { internal: "kept", pageSize: 20 })).toEqual({
      internal: "kept",
      page_size: 20
    })
  })

  test("matches wire keys exact-first then folds case like Go encoding/json", () => {
    const fields = struct.object({
      lower: struct.number().alias("foo"),
      upper: struct.number().alias("FOO")
    })

    expect(decodeJson(fields, { foo: 1 })).toEqual({ lower: 1, upper: 0 })
    expect(decodeJson(fields, { FOO: 2 })).toEqual({ lower: 0, upper: 2 })
    expect(decodeJson(fields, { FoO: 3 })).toEqual({ lower: 3, upper: 0 })
  })

  test("uses the later input key when folded keys target the same field", () => {
    const field = struct.object({ value: struct.number().alias("value") })

    expect(decodeJson(field, { VALUE: 1, VaLuE: 2 })).toEqual({ value: 2 })
    expect(decodeJson(field, { value: 3, VALUE: 4 })).toEqual({ value: 4 })
  })

  test("defers object null and optional values to Struct semantics", () => {
    const Leaf = struct.object({ a: struct.number(), b: struct.number() })

    expect(decodeJson(Leaf, null)).toEqual({ a: 0, b: 0 })
    expect(decodeJson(Leaf.null(), null)).toBeNull()
    expect(decodeJson(Leaf.optional(), undefined)).toBeUndefined()
    expect(decodeJson(Leaf.nullish(), undefined)).toBeNull()
    expect(decodeJson(struct.array(Leaf), [null])).toEqual([{ a: 0, b: 0 }])
    expect(decodeJson(struct.tuple([Leaf]), [null])).toEqual([{ a: 0, b: 0 }])
    expect(decodeJson(struct.record(Leaf), { value: null })).toEqual({
      value: { a: 0, b: 0 }
    })
    expect(decodeJson(struct.record(Leaf.null()), { value: null })).toEqual({ value: null })

    expect(encodeJson(Leaf.null(), null)).toBeNull()
    expect(encodeJson(struct.object({ value: Leaf.null() }), { value: null })).toEqual({
      value: null
    })
    expect(encodeJson(Leaf.optional(), undefined)).toBeUndefined()
    expect(encodeJson(Leaf.nullish(), null)).toBeNull()
    expect(() => encodeJson(Leaf, null)).toThrow("json encode expects object value")
  })

  test("accumulates repeated folded field matches like Go encoding/json v1", () => {
    const Leaf = struct.object({ a: struct.number(), b: struct.number() })
    const Nested = struct.object({ inner: Leaf, c: struct.number() })
    const Payload = struct.object({
      nested: Nested.alias("object"),
      items: struct.array(struct.number()).alias("slice"),
      objectItems: struct.array(Leaf).alias("object_slice"),
      pointerItems: struct.array(Leaf.null()).alias("pointer_slice"),
      tuple: struct.tuple([struct.number(), struct.number(), struct.number()]).alias("tuple"),
      objectTuple: struct.tuple([Leaf, Leaf]).alias("object_array"),
      entries: struct.record(Leaf).alias("record"),
      pointerEntries: struct.record(Leaf.null()).alias("pointer_record"),
      count: struct.number().alias("scalar"),
      nullableCount: struct.number().null().alias("pointer")
    })

    expect(
      decodeJson(Payload, {
        object: { inner: { a: 1 }, c: 3 },
        OBJECT: { INNER: { b: 2 } },
        slice: [1, 2],
        SLICE: [3],
        object_slice: [{ a: 1 }, { a: 3 }],
        OBJECT_SLICE: [{ b: 2 }],
        pointer_slice: [{ a: 1 }, { a: 3 }],
        POINTER_SLICE: [{ b: 2 }],
        tuple: [1, 2, 3],
        TUPLE: [4],
        object_array: [{ a: 1 }, { a: 3 }],
        OBJECT_ARRAY: [{ b: 2 }],
        record: { x: { a: 1 }, keep: { a: 7 } },
        RECORD: { x: { b: 2 }, new: { b: 8 } },
        pointer_record: { x: { a: 1 }, keep: { a: 7 } },
        POINTER_RECORD: { x: { b: 2 }, new: { b: 8 } },
        scalar: 9,
        SCALAR: null,
        pointer: 9,
        POINTER: null
      })
    ).toEqual({
      nested: { inner: { a: 1, b: 2 }, c: 3 },
      items: [3],
      objectItems: [{ a: 1, b: 2 }],
      pointerItems: [{ a: 1, b: 2 }],
      tuple: [4, 0, 0],
      objectTuple: [
        { a: 1, b: 2 },
        { a: 0, b: 0 }
      ],
      entries: {
        keep: { a: 7, b: 0 },
        new: { a: 0, b: 8 },
        x: { a: 0, b: 2 }
      },
      pointerEntries: {
        keep: { a: 7, b: 0 },
        new: { a: 0, b: 8 },
        x: { a: 0, b: 2 }
      },
      count: 9,
      nullableCount: null
    })

    expect(
      decodeJson(Payload, {
        object: { inner: { a: 1 } },
        OBJECT: null,
        slice: [1, 2],
        SLICE: null,
        object_slice: [{ a: 1 }],
        OBJECT_SLICE: null,
        pointer_slice: [{ a: 1 }],
        POINTER_SLICE: null,
        tuple: [1, 2, 3],
        TUPLE: null,
        object_array: [{ a: 1 }, { a: 3 }],
        OBJECT_ARRAY: null,
        record: { x: { a: 1 } },
        RECORD: null,
        pointer_record: { x: { a: 1 } },
        POINTER_RECORD: null,
        scalar: 9,
        SCALAR: null
      })
    ).toEqual({
      nested: { inner: { a: 1, b: 0 }, c: 0 },
      items: [],
      objectItems: [],
      pointerItems: [],
      tuple: [1, 2, 3],
      objectTuple: [
        { a: 1, b: 0 },
        { a: 3, b: 0 }
      ],
      entries: {},
      pointerEntries: {},
      count: 9,
      nullableCount: null
    })

    expect(
      decodeJson(Payload, {
        object: null,
        slice: null,
        object_slice: null,
        pointer_slice: null,
        tuple: null,
        object_array: null,
        record: null,
        pointer_record: null,
        scalar: null,
        pointer: null
      })
    ).toEqual({
      nested: { inner: { a: 0, b: 0 }, c: 0 },
      items: [],
      objectItems: [],
      pointerItems: [],
      tuple: [0, 0, 0],
      objectTuple: [
        { a: 0, b: 0 },
        { a: 0, b: 0 }
      ],
      entries: {},
      pointerEntries: {},
      count: 0,
      nullableCount: null
    })

    expect(() =>
      decodeJson(struct.object({ value: struct.number().alias("n") }), {
        N: "bad",
        n: 2
      })
    ).toThrow(StructError)

    const RecordNulls = struct.object({
      values: struct.record(Leaf).alias("record"),
      pointers: struct.record(Leaf.null()).alias("pointer")
    })
    expect(
      decodeJson(RecordNulls, {
        record: { new: null, existing: { a: 1 } },
        RECORD: { existing: null },
        pointer: { new: null, existing: { a: 1 } },
        POINTER: { existing: null }
      })
    ).toEqual({
      values: {
        existing: { a: 0, b: 0 },
        new: { a: 0, b: 0 }
      },
      pointers: { existing: null, new: null }
    })
  })

  test("matches the Go 1.26.5 Unicode folding oracle", () => {
    const cases = [
      ["s", "ſ", true],
      ["k", "K", true],
      ["Σ", "ς", true],
      ["μ", "µ", true],
      ["ß", "ẞ", true],
      ["𐐀", "𐐨", true],
      ["i", "ı", false],
      ["i", "İ", false],
      ["ß", "SS", false],
      ["Ᲊ", "ᲊ", false],
      ["Ɤ", "ɤ", false],
      ["𐵐", "𐵰", false]
    ] as const

    for (const [alias, wireKey, matches] of cases) {
      const field = struct.object({ value: struct.number().alias(alias) })
      expect(decodeJson(field, { [wireKey]: 5 })).toEqual({ value: matches ? 5 : 0 })
    }
  })

  test("recurses into nested JSON objects and arrays", () => {
    const profile = struct.object({
      name: struct.string().alias("full_name"),
      secret: struct.string().optional()
    })
    const user = struct.object({
      internalOnly: struct.string().optional(),
      profile: profile.alias("profile"),
      team: struct.array(profile).alias("team")
    })

    expect(
      encodeJson(user, {
        internalOnly: "visible",
        profile: { name: "Miao", secret: "local" },
        team: [{ name: "Core", secret: "local-team" }]
      })
    ).toEqual({
      internalOnly: "visible",
      profile: { full_name: "Miao", secret: "local" },
      team: [{ full_name: "Core", secret: "local-team" }]
    })

    expect(
      decodeJson(user, {
        internalOnly: "visible",
        profile: { full_name: "Miao", secret: "local" },
        team: [{ full_name: "Core", secret: "local-team" }]
      })
    ).toEqual({
      internalOnly: "visible",
      profile: { name: "Miao", secret: "local" },
      team: [{ name: "Core", secret: "local-team" }]
    })
  })

  test("recurses into top-level arrays of objects", () => {
    const profile = struct.object({
      name: struct.string().alias("full_name"),
      secret: struct.string().optional()
    })
    const profiles = struct.array(profile)

    expect(encodeJson(profiles, [{ name: "Miao", secret: "local" }])).toEqual([
      { full_name: "Miao", secret: "local" }
    ])
    expect(decodeJson(profiles, [{ full_name: "Miao", secret: "local" }])).toEqual([
      { name: "Miao", secret: "local" }
    ])
  })

  test("decodes aliased union objects symmetrically", () => {
    const event = struct.or(
      struct.object({
        payload: struct.string().alias("body"),
        type: struct.literal("message").alias("kind")
      }),
      struct.object({
        count: struct.number().alias("count"),
        type: struct.literal("count").alias("kind")
      })
    )

    expect(encodeJson(event, { payload: "hello", type: "message" })).toEqual({
      body: "hello",
      kind: "message"
    })
    expect(encodeJson(event, { count: 3, type: "count" })).toEqual({
      count: 3,
      kind: "count"
    })
    expect(decodeJson(event, { body: "hello", kind: "message" })).toEqual({
      payload: "hello",
      type: "message"
    })
    expect(decodeJson(event, { count: 3, kind: "count" })).toEqual({
      count: 3,
      type: "count"
    })
    expect(decodeJson(event, { count: 1, kind: "message" })).toEqual({
      payload: "",
      type: "message"
    })
  })

  test("selects aliased union branches by scalar field type without a discriminator", () => {
    const event = struct.or(
      struct.object({ value: struct.string().alias("text") }),
      struct.object({ value: struct.number().alias("count") })
    )

    expect(encodeJson(event, { value: "hello" })).toEqual({ text: "hello" })
    expect(encodeJson(event, { value: 3 })).toEqual({ count: 3 })
    expect(decodeJson(event, { count: 3 })).toEqual({ value: 3 })
  })

  test("selects object union branch when nullable primitive field is present as null", () => {
    const Payload = struct.or(
      struct.object({ kind: struct.literal("date"), at: struct.date().null().alias("created_at") }),
      struct.object({ kind: struct.literal("text"), value: struct.string() })
    )

    expect(encodeJson(Payload, { kind: "date", at: null })).toEqual({
      kind: "date",
      created_at: null
    })
  })

  test("selects aliased union branch by runtime date value rather than string wire guard", () => {
    const Payload = struct.or(
      struct.object({ value: struct.date().alias("created_at") }),
      struct.object({ value: struct.string().alias("text") })
    )

    expect(encodeJson(Payload, { value: new Date("2026-05-12T10:00:00Z") })).toEqual({
      created_at: "2026-05-12T10:00:00.000Z"
    })
  })

  test("selects aliased union branch by runtime bigint value rather than number branch", () => {
    const Payload = struct.or(
      struct.object({ value: struct.bigint().alias("id") }),
      struct.object({ value: struct.number().alias("count") })
    )

    expect(encodeJson(Payload, { value: 42n })).toEqual({ id: "42" })
  })

  test("selects aliased union branches through collection field types", () => {
    const arrayEvent = struct.or(
      struct.object({ value: struct.array(struct.string()).alias("texts") }),
      struct.object({ value: struct.array(struct.number()).alias("counts") })
    )
    const recordEvent = struct.or(
      struct.object({ value: struct.record(struct.string()).alias("labels") }),
      struct.object({ value: struct.record(struct.number()).alias("totals") })
    )
    const tupleEvent = struct.or(
      struct.object({ value: struct.tuple([struct.string()]).alias("label_tuple") }),
      struct.object({ value: struct.tuple([struct.number()]).alias("count_tuple") })
    )

    expect(encodeJson(arrayEvent, { value: [1, 2] })).toEqual({ counts: [1, 2] })
    expect(decodeJson(arrayEvent, { counts: [1, 2] })).toEqual({ value: [1, 2] })
    expect(encodeJson(recordEvent, { value: { total: 3 } })).toEqual({ totals: { total: 3 } })
    expect(decodeJson(recordEvent, { totals: { total: 3 } })).toEqual({ value: { total: 3 } })
    expect(encodeJson(tupleEvent, { value: [3] })).toEqual({ count_tuple: [3] })
    expect(decodeJson(tupleEvent, { count_tuple: [3] })).toEqual({ value: [3] })
  })

  test("rejects ambiguous aliased union object branches", () => {
    const Payload = struct.or(
      struct.object({ value: struct.string().alias("text") }),
      struct.object({ value: struct.string().alias("label") })
    )

    expect(() => encodeJson(Payload, { value: "x" })).toThrow("ambiguous union encode")
  })

  test("rejects ambiguous aliased union array branches", () => {
    const Payload = struct.or(
      struct.array(struct.string()).alias("texts"),
      struct.array(struct.string()).alias("labels")
    )

    expect(() => encodeJson(Payload, [])).toThrow("ambiguous union encode")
  })

  test("decodes aliased discriminated union objects symmetrically", () => {
    const event = struct.discriminatedUnion("type", [
      struct.object({
        payload: struct.string().alias("body"),
        type: struct.literal("message").alias("kind")
      }),
      struct.object({
        count: struct.number().alias("count"),
        type: struct.literal("count").alias("kind")
      })
    ])

    expect(encodeJson(event, { payload: "hello", type: "message" })).toEqual({
      body: "hello",
      kind: "message"
    })
    expect(encodeJson(event, { count: 3, type: "count" })).toEqual({
      count: 3,
      kind: "count"
    })
    expect(decodeJson(event, { body: "hello", kind: "message" })).toEqual({
      payload: "hello",
      type: "message"
    })
    expect(decodeJson(event, { count: 3, kind: "count" })).toEqual({
      count: 3,
      type: "count"
    })
    expect(decodeJson(event, { count: 1, kind: "message" })).toEqual({
      payload: "",
      type: "message"
    })
  })

  test("routes aliased discriminated union by discriminator wire key before normalizing target branch", () => {
    const Message = struct.discriminatedUnion("type", [
      struct.object({
        type: struct.literal("text").alias("kind"),
        body: struct.string().alias("message_body")
      }),
      struct.object({
        type: struct.literal("count").alias("kind"),
        count: struct.number().alias("total_count")
      })
    ])

    expect(decodeJson(Message, { kind: "count", total_count: 3 })).toEqual({
      type: "count",
      count: 3
    })
  })

  test("rejects conflicting aliased discriminators in discriminated union decode", () => {
    const Message = struct.discriminatedUnion("type", [
      struct.object({ type: struct.literal("text").alias("kind"), body: struct.string() }),
      struct.object({ type: struct.literal("count").alias("event_type"), count: struct.number() })
    ])

    expect(() => decodeJson(Message, { kind: "text", event_type: "count", count: 1 })).toThrow(
      "ambiguous discriminated union discriminator"
    )
  })

  test("does not revive a suppressed discriminator through its raw field name", () => {
    const Message = struct.discriminatedUnion("type", [
      struct.object({
        type: struct.literal("text").alias("kind"),
        shadowType: struct.string().alias("kind")
      })
    ])

    expect(() => decodeJson(Message, { type: "text" })).toThrow(StructError)
  })

  test("skips a union candidate whose discriminator is suppressed by aliases", () => {
    const Message = struct.discriminatedUnion("type", [
      struct.object({
        type: struct.literal("a").alias("same"),
        shadow: struct.string().optional().alias("same")
      }),
      struct.object({ type: struct.literal("b").alias("kind_b") }),
      struct.object({ type: struct.literal("c").alias("kind_c") })
    ])

    expect(decodeJson(Message, { kind_b: "a", kind_c: "c" })).toEqual({ type: "c" })
  })

  test("decodes aliased intersection right-side objects symmetrically", () => {
    const profile = struct.object({
      name: struct.string().alias("full_name")
    })
    const intersectionStruct = struct.intersection(struct.unknown(), profile)

    expect(encodeJson(intersectionStruct, { name: "Miao" })).toEqual({ full_name: "Miao" })
    expect(decodeJson(intersectionStruct, { full_name: "Miao" })).toEqual({ name: "Miao" })
    expect(decodeJson(intersectionStruct, {})).toEqual({ name: "" })
  })

  test("encodes and decodes both aliased intersection object sides", () => {
    const account = struct.object({
      id: struct.string().alias("account_id")
    })
    const profile = struct.object({
      name: struct.string().alias("full_name")
    })
    const intersectionStruct = struct.intersection(account, profile)

    expect(encodeJson(intersectionStruct, { id: "u_1", name: "Miao" })).toEqual({
      account_id: "u_1",
      full_name: "Miao"
    })
    expect(decodeJson(intersectionStruct, { account_id: "u_1", full_name: "Miao" })).toEqual({
      id: "u_1",
      name: "Miao"
    })
  })

  test("encodes and decodes nested aliased intersection object sides", () => {
    const account = struct.object({
      id: struct.string().alias("account_id")
    })
    const profile = struct.object({
      name: struct.string().alias("full_name")
    })
    const audit = struct.object({
      when: struct.date().alias("created_at")
    })
    const intersectionStruct = struct.intersection(struct.intersection(account, profile), audit)

    expect(
      encodeJson(intersectionStruct, {
        id: "u_1",
        name: "Miao",
        when: new Date("2026-05-12T10:00:00Z")
      })
    ).toEqual({
      account_id: "u_1",
      created_at: "2026-05-12T10:00:00.000Z",
      full_name: "Miao"
    })
    expect(
      decodeJson(intersectionStruct, {
        account_id: "u_1",
        created_at: "2026-05-12T10:00:00.000Z",
        full_name: "Miao"
      })
    ).toEqual({
      id: "u_1",
      name: "Miao",
      when: new Date("2026-05-12T10:00:00Z")
    })
  })
})
