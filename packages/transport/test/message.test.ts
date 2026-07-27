import { expect, test } from "bun:test"

import type { Message } from "../src/types"
import * as MessageModule from "../src/message"

const snapshotMessage: (message: Message) => Message = Reflect.get(MessageModule, "snapshotMessage")

function implemented(): boolean {
  const available = typeof snapshotMessage === "function"
  expect(available).toBe(true)
  return available
}

test("publishes only the Message snapshot boundary", () => {
  expect(Object.keys(MessageModule)).toEqual(["snapshotMessage"])
})

test("copies and freezes headers while returning detached body reads", () => {
  if (!implemented()) return
  const header = { alpha: "one", beta: "two" }
  const body = new Uint8Array([1, 2, 3])
  const snapshot = snapshotMessage({ header, body })

  header.alpha = "changed"
  body[0] = 99
  expect(snapshot.header).toEqual({ alpha: "one", beta: "two" })
  expect(snapshot.body).toEqual(new Uint8Array([1, 2, 3]))
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.header)).toBe(true)

  const first = snapshot.body
  const second = snapshot.body
  expect(first).not.toBe(second)
  first[0] = 77
  expect(snapshot.body).toEqual(new Uint8Array([1, 2, 3]))
})

test("accepts null-prototype headers and rejects malformed runtime inputs", () => {
  if (!implemented()) return
  const header = Object.create(null)
  Object.defineProperty(header, "topic", {
    enumerable: true,
    value: "orders"
  })
  expect(snapshotMessage({ header, body: new Uint8Array() })).toEqual({
    header: { topic: "orders" },
    body: new Uint8Array()
  })

  expect(() => Reflect.apply(snapshotMessage, undefined, [null])).toThrow(TypeError)
  expect(() =>
    Reflect.apply(snapshotMessage, undefined, [{ header: [], body: new Uint8Array() }])
  ).toThrow(TypeError)
  expect(() =>
    Reflect.apply(snapshotMessage, undefined, [{ header: { topic: 1 }, body: new Uint8Array() }])
  ).toThrow(TypeError)
  expect(() => Reflect.apply(snapshotMessage, undefined, [{ header: {}, body: [] }])).toThrow(
    TypeError
  )
  expect(() =>
    Reflect.apply(snapshotMessage, undefined, [
      {
        header: Object.create({ inherited: "value" }),
        body: new Uint8Array()
      }
    ])
  ).toThrow(TypeError)
})
