import { StructError, struct } from "@go-like/struct"
import * as Codec from "@go-like/struct/codec"
import { decodeJson, decodeJsonTree } from "@go-like/struct/codec"
import { expect, spyOn, test } from "bun:test"

import { decodeJsonBody, encodeJsonBody } from "../src/json"

test("decodeJsonBody decodes parsed JSON through decodeJsonTree", () => {
  const decodeSpy = spyOn(Codec, "decodeJsonTree")
  const schema = struct.object({
    id: struct.string(),
    note: struct.string().nullish()
  })
  const encoder = new TextEncoder()
  const bytes = encoder.encode('{"note":null,"extra":1,"id":"a"}')
  const tree = JSON.parse(new TextDecoder().decode(bytes)) as {
    extra: number
    id: string
    note: null
  }
  const decoded = decodeJsonBody(schema, bytes)
  expect(decodeSpy).toHaveBeenCalledTimes(1)
  expect(decodeSpy.mock.calls[0]?.[0]).toBe(schema)
  decodeSpy.mockRestore()

  expect(Object.getPrototypeOf(decoded)).toBeNull()
  expect(Object.keys(decoded)).toEqual(["id", "note"])
  expect(decoded).toEqual({ id: "a", note: null })
  expect(decoded).toEqual(decodeJsonTree(schema, tree))
  expect(decoded).toEqual(decodeJson(schema, tree))

  let invalid: unknown
  try {
    decodeJsonBody(schema, encoder.encode("{"))
  } catch (error) {
    invalid = error
  }
  expect(invalid).toBeInstanceOf(TypeError)
  expect((invalid as TypeError).message).toBe("json body is invalid")
  expect((invalid as TypeError).cause).toBeInstanceOf(SyntaxError)

  expect(() => decodeJsonBody(schema, new Uint8Array([0xff]))).toThrow("json body is invalid")

  let mismatch: unknown
  try {
    decodeJsonBody(schema, encoder.encode('{"id":1}'))
  } catch (error) {
    mismatch = error
  }
  expect(mismatch).toBeInstanceOf(StructError)
  let interpreted: unknown
  try {
    decodeJson(schema, { id: 1 })
  } catch (error) {
    interpreted = error
  }
  expect((mismatch as StructError).issues).toEqual((interpreted as StructError).issues)
})

test("encodeJsonBody validates through encodeValidatedJson", () => {
  const encodeSpy = spyOn(Codec, "encodeValidatedJson")
  const schema = struct.object({
    id: struct.string(),
    note: struct.string().nullish()
  })
  const input = { extra: 1, id: "a", note: null }
  const bytes = encodeJsonBody(schema, input)
  expect(encodeSpy).toHaveBeenCalledTimes(1)
  expect(encodeSpy.mock.calls[0]?.[0]).toBe(schema)
  encodeSpy.mockRestore()

  expect(new TextDecoder().decode(bytes)).toBe('{"id":"a","note":null}')
  expect(() => encodeJsonBody(schema, { id: 1 } as never)).toThrow(StructError)
  expect(() => encodeJsonBody(struct.any(), () => undefined)).toThrow(
    "json body is not serializable"
  )
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  expect(() => encodeJsonBody(struct.any(), cyclic)).toThrow("struct value contains a cycle")
})
