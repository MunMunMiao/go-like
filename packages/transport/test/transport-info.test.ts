import { runInNewContext } from "node:vm"

import { expect, test } from "bun:test"

import { background, canceled, withCancel, withValue } from "@go-like/context"
import { newMetadata } from "@go-like/metadata"

import {
  fromClientContext,
  fromServerContext,
  newClientContext,
  newServerContext,
  type TransportInfo
} from "../src/index"

interface MutableInfoState {
  kind: string
  endpoint: string
  operation: string
  request: ReturnType<typeof newMetadata>
  reply: ReturnType<typeof newMetadata>
}

/** Creates one mutable provider state with valid empty metadata. */
function state(kind = "http", endpoint = "endpoint", operation = "operation"): MutableInfoState {
  return { kind, endpoint, operation, request: newMetadata(), reply: newMetadata() }
}

/** Creates one structural TransportInfo backed by mutable provider state. */
function info(value: MutableInfoState): TransportInfo {
  return {
    kind(): string {
      return value.kind
    },
    endpoint(): string {
      return value.endpoint
    },
    operation(): string {
      return value.operation
    },
    requestHeaders() {
      return value.request
    },
    replyHeaders() {
      return value.reply
    }
  }
}

test("carries isolated structural client and server TransportInfo facades", () => {
  const clientState = state("http", "discovery:///orders", "/orders.v1.Order/Get")
  clientState.request = newMetadata({ trace: "client" })
  const serverState = state("http", "http://127.0.0.1:8080", "/orders.v1.Order/Get")
  serverState.request = newMetadata({ trace: "server" })
  serverState.reply = newMetadata({ result: "initial" })
  const ctx = newServerContext(newClientContext(background(), info(clientState)), info(serverState))
  const client = fromClientContext(ctx)
  const server = fromServerContext(ctx)
  if (client === null || server === null) throw new Error("TransportInfo must be present")

  clientState.endpoint = "changed"
  serverState.reply = newMetadata({ result: ["one", "two"] })

  expect(client.kind()).toBe("http")
  expect(client.endpoint()).toBe("changed")
  expect(client.operation()).toBe("/orders.v1.Order/Get")
  expect(client.requestHeaders()).toEqual({ trace: ["client"] })
  expect(client.replyHeaders()).toEqual({})
  expect(server.replyHeaders()).toEqual({ result: ["one", "two"] })
  expect(server.replyHeaders()).not.toBe(serverState.reply)
  expect(Object.isFrozen(client)).toBe(true)
  expect(fromClientContext(background())).toBeNull()
  expect(fromServerContext(background())).toBeNull()
})

test("preserves Context values and cancellation ancestry", () => {
  const key = {}
  const [parent, cancel] = withCancel(withValue(background(), key, "retained"))
  const ctx = newClientContext(parent, info(state("custom+http", "🐈", "")))

  expect(ctx.value(key)).toBe("retained")
  expect(ctx.done()).toBe(parent.done())
  cancel()
  expect(ctx.err()).toBe(canceled)
})

test("rejects malformed structural info and bounded identity fields", () => {
  expect(() => newClientContext(background(), null as never)).toThrow("structural")
  expect(() => newClientContext(background(), {} as never)).toThrow("structural")

  let getterCalls = 0
  const getterInfo = Object.defineProperty({}, "kind", {
    get() {
      getterCalls += 1
      return () => "http"
    }
  })
  expect(() => newClientContext(background(), getterInfo as never)).toThrow("structural")
  expect(getterCalls).toBe(0)

  for (const kind of ["", "HTTP", "bad kind", "x".repeat(65)]) {
    expect(() => newClientContext(background(), info(state(kind)))).toThrow()
  }
  for (const endpoint of ["line\nbreak", "\ud800", "x".repeat(4_097)]) {
    expect(() => newClientContext(background(), info(state("http", endpoint)))).toThrow()
  }
  for (const operation of ["line\nbreak", "\ud800", "x".repeat(1_025)]) {
    expect(() =>
      newClientContext(background(), info(state("http", "endpoint", operation)))
    ).toThrow()
  }
})

test("validates dynamic header results and ignores unbranded Context values", () => {
  const malformed: TransportInfo = {
    kind: () => "http",
    endpoint: () => "endpoint",
    operation: () => "operation",
    requestHeaders: () => null as never,
    replyHeaders: () => ({ Bad: [] })
  }
  const carried = fromClientContext(newClientContext(background(), malformed))
  if (carried === null) throw new Error("TransportInfo must be present")

  expect(() => carried.requestHeaders()).toThrow(TypeError)
  expect(carried.replyHeaders()).toEqual({ bad: [] })

  const forged = {
    deadline: background().deadline,
    done: background().done,
    err: background().err,
    value: () => malformed
  }
  expect(fromClientContext(forged)).toBeNull()
  expect(fromServerContext(forged)).toBeNull()
})

test("validates dynamic endpoints and normalizes non-Error reader failures", () => {
  const mutable = state("http", "initial", "operation")
  const carried = fromClientContext(newClientContext(background(), info(mutable)))
  if (carried === null) throw new Error("TransportInfo must be present")

  mutable.endpoint = "next"
  expect(carried.endpoint()).toBe("next")
  mutable.endpoint = "line\nbreak"
  expect(() => carried.endpoint()).toThrow(TypeError)

  const raw = Object.freeze({ boundary: "kind" })
  const throwing = info(state())
  throwing.kind = (() => {
    throw raw
  }) as never
  expect(() => newClientContext(background(), throwing)).toThrow(
    "reader rejected with a non-Error value"
  )
})

test("preserves cross-realm Error identity from structural readers", () => {
  const foreign = runInNewContext('new Error("foreign reader failure")') as Error
  const throwing = info(state())
  throwing.kind = (() => {
    throw foreign
  }) as never

  let observed: unknown = null
  try {
    newClientContext(background(), throwing)
  } catch (error) {
    observed = error
  }
  expect(observed).toBe(foreign)
})
