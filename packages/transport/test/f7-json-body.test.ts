import { struct } from "@go-like/struct"
import { expect, test } from "bun:test"

import { decodeJsonBody, encodeJsonBody } from "../src/json"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

test("Q5-01 JSON bodies deep-merge nested and root intersection arrays", () => {
  const id = struct.object({ id: struct.string() })
  const name = struct.object({ name: struct.string() })
  const nested = struct.intersection(
    struct.object({ items: struct.array(struct.array(id)) }),
    struct.object({ items: struct.array(struct.array(name)) })
  )
  const nestedInput = { items: [[{ id: "u1", name: "Ada" }]] }
  expect(JSON.parse(decoder.decode(encodeJsonBody(nested, nestedInput)))).toEqual(nestedInput)
  expect(decodeJsonBody(nested, encoder.encode(JSON.stringify(nestedInput)))).toEqual(nestedInput)

  const root = struct.intersection(struct.array(id), struct.array(name))
  const rootInput = [{ id: "u1", name: "Ada" }]
  expect(JSON.parse(decoder.decode(encodeJsonBody(root, rootInput)))).toEqual(rootInput)
  expect(decodeJsonBody(root, encoder.encode(JSON.stringify(rootInput)))).toEqual(rootInput)
})
