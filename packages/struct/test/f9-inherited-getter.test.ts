import { describe, expect, test } from "bun:test"

import { encodeJson } from "../src/codec/json"
import { struct } from "../src/index"
import { encodeValue } from "../src/encode"
import { mapAliasedObjectFields } from "../src/fields"
import { matchesRuntimeValue } from "../src/match"
import type { RuntimeStruct } from "../src/types"

const key = "f9AbsentInheritedField"

/** Installs a throwing inherited getter and removes it afterwards. */
function withInheritedGetter(run: (reads: { count: number }) => void): void {
  const reads = { count: 0 }
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get(): unknown {
      reads.count += 1
      throw new Error("must not read absent inherited field")
    }
  })
  try {
    run(reads)
  } finally {
    delete (Object.prototype as { [name: string]: unknown })[key]
  }
}

describe("Q7-03 encode reads own properties before inherited getters", () => {
  test("alias frame encoding ignores an absent inherited field", () => {
    const shape = struct.object({ [key]: struct.string().optional() })
    const samples = [
      ["object", shape, {}],
      ["union", struct.or(shape, struct.number()), {}],
      ["array", struct.array(shape), [{}]],
      ["intersection", struct.intersection(shape, struct.object({})), {}]
    ] as const

    withInheritedGetter((reads) => {
      for (const [kind, schema, input] of samples) {
        const reference = encodeValue(schema as unknown as RuntimeStruct, input, {
          encodeObject: (objectSchema, value, child) =>
            mapAliasedObjectFields(objectSchema, value, child)
        })
        expect(reads.count, kind).toBe(0)
        expect(encodeJson(schema, input), kind).toEqual(reference)
        expect(reads.count, kind).toBe(0)
      }
    })
  })

  test("alias frame encoding skips an own property whose value is undefined", () => {
    const shape = struct.object({ name: struct.string().optional().alias("full_name") })
    const input = [{ name: undefined }]
    expect(encodeJson(struct.array(shape), input)).toEqual([{}])
    expect(encodeJson(struct.or(shape, struct.number()), { name: undefined })).toEqual({})
    expect(encodeJson(struct.intersection(shape, struct.object({})), { name: undefined })).toEqual(
      {}
    )
  })

  test("discriminated encode does not read an inherited discriminator", () => {
    const tag = "f9AbsentInheritedTag"
    const schema = struct.discriminatedUnion(tag, [
      struct.object({ [tag]: struct.literal("a"), n: struct.number() })
    ])

    withInheritedGetter((reads) => {
      Object.defineProperty(Object.prototype, tag, {
        configurable: true,
        get(): unknown {
          reads.count += 1
          throw new Error("must not read absent inherited discriminator")
        }
      })
      try {
        expect(struct.parse(schema, {})[0]).toBeTruthy()
        expect(matchesRuntimeValue(schema as unknown as RuntimeStruct, {})).toBe(false)
        expect(reads.count).toBe(0)
        expect(encodeJson(schema, {})).toEqual({})
        expect(reads.count).toBe(0)
      } finally {
        delete (Object.prototype as { [name: string]: unknown })[tag]
      }
    })
  })
})
