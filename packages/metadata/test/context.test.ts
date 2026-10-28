import { expect, test } from "bun:test"

import { background, canceled, withCancel, withValue } from "@go-like/context"

import {
  appendToClientContext,
  fromClientContext,
  fromServerContext,
  mergeToClientContext,
  newClientContext,
  newMetadata,
  newServerContext,
  propagateToClientContext,
  type Metadata
} from "../src/index"

/** Returns metadata read from a Context or fails the test when it is absent. */
function carried(metadata: Metadata | null): Metadata {
  if (metadata === null) throw new Error("expected Context metadata")
  return metadata
}

test("keeps client and server metadata in isolated Context domains", () => {
  const client = newMetadata({ trace: "client" })
  const server = newMetadata({ trace: "server" })
  const ctx = newServerContext(newClientContext(background(), client), server)

  expect(fromClientContext(ctx)).toEqual({ trace: ["client"] })
  expect(fromServerContext(ctx)).toEqual({ trace: ["server"] })
  expect(fromClientContext(background())).toBeNull()
  expect(fromServerContext(background())).toBeNull()
})

test("Kratos-style client Context helpers preserve values and cancellation ancestry", () => {
  const retainedKey = {}
  const [parent, cancel] = withCancel(withValue(background(), retainedKey, "retained"))
  const client = mergeToClientContext(
    appendToClientContext(parent, "trace", "one", "tenant", "a"),
    newMetadata({ trace: "replacement" })
  )
  const server = newServerContext(client, newMetadata({ trace: "server", zone: "cn" }))

  expect(client.value(retainedKey)).toBe("retained")
  expect(fromClientContext(client)).toEqual({ tenant: ["a"], trace: ["replacement"] })
  expect(fromServerContext(server)).toEqual({ trace: ["server"], zone: ["cn"] })
  expect(client.done()).toBe(parent.done())

  cancel()
  expect(client.err()).toBe(canceled)
  expect(server.err()).toBe(canceled)
  expect(() => appendToClientContext(background(), "missing-value")).toThrow(
    "requires key/value pairs"
  )
})

test("snapshots attached metadata and rejects unbranded hostile Context values", () => {
  const source = { trace: ["one"] }
  const metadata = newMetadata(source)
  const ctx = newClientContext(background(), metadata)
  source.trace[0] = "changed"

  expect(fromClientContext(ctx)).toEqual({ trace: ["one"] })
  expect(fromClientContext(ctx)).not.toBe(metadata)

  const hostile = {
    deadline: background().deadline,
    done: background().done,
    err: background().err,
    value: () => ({ trace: ["forged"] })
  }
  expect(fromClientContext(hostile)).toBeNull()
  expect(fromServerContext(hostile)).toBeNull()
})

test("attaches a distinct frozen record per Context and leaves the original snapshot untouched", () => {
  const original = newMetadata({ trace: ["one", "two"], zone: "cn" })
  const client = carried(fromClientContext(newClientContext(background(), original)))
  const server = carried(fromServerContext(newServerContext(background(), original)))

  expect(client).not.toBe(original)
  expect(server).not.toBe(original)
  expect(server).not.toBe(client)
  expect(client).toEqual(original)
  expect(server).toEqual(original)
  for (const attached of [client, server]) {
    const record = attached as Record<string, unknown>
    expect(Object.isFrozen(attached)).toBe(true)
    expect(Object.isFrozen(attached.trace)).toBe(true)
    expect(() => {
      record.trace = []
    }).toThrow(TypeError)
    expect(() => (attached.trace as string[]).push("three")).toThrow(TypeError)
  }
  expect(original).toEqual({ trace: ["one", "two"], zone: ["cn"] })
  expect(Object.isFrozen(original)).toBe(true)

  const structural: Metadata = { Trace: ["one"] }
  expect(carried(fromClientContext(newClientContext(background(), structural)))).toEqual({
    trace: ["one"]
  })
  expect(carried(fromServerContext(newServerContext(background(), structural)))).toEqual({
    trace: ["one"]
  })
  expect(() => newClientContext(background(), { trace: 1 } as never)).toThrow(TypeError)
  expect(() => newServerContext(background(), { trace: 1 } as never)).toThrow(TypeError)
})

test("propagates only explicit server keys while preserving client conflicts and multi-values", () => {
  const ctx = newClientContext(
    newServerContext(
      background(),
      newMetadata({
        Existing: ["server-one", "server-two"],
        "Trace-ID": ["trace-one", "trace-two"],
        "X-Baggage": ["one", "two"],
        "X-Empty": [],
        authorization: "secret"
      })
    ),
    newMetadata({ existing: "client", local: "kept" })
  )
  const propagated = propagateToClientContext(ctx, {
    exact: ["TRACE-ID", "EXISTING"],
    prefix: ["X-"]
  })

  expect(propagated).not.toBe(ctx)
  expect(fromClientContext(propagated)).toEqual({
    existing: ["client"],
    local: ["kept"],
    "trace-id": ["trace-one", "trace-two"],
    "x-baggage": ["one", "two"],
    "x-empty": []
  })
  expect(fromServerContext(propagated)).toEqual({
    authorization: ["secret"],
    existing: ["server-one", "server-two"],
    "trace-id": ["trace-one", "trace-two"],
    "x-baggage": ["one", "two"],
    "x-empty": []
  })
})

test("returns the original Context when propagation has no effective match", () => {
  const plain = background()
  const clientOnly = newClientContext(plain, newMetadata({ trace: "client" }))
  const server = newServerContext(plain, newMetadata({ trace: "server" }))
  const conflict = newClientContext(server, newMetadata({ trace: "client" }))

  expect(propagateToClientContext(plain)).toBe(plain)
  expect(propagateToClientContext(plain, {})).toBe(plain)
  expect(propagateToClientContext(clientOnly, { exact: ["trace"] })).toBe(clientOnly)
  expect(propagateToClientContext(server, { exact: ["missing"] })).toBe(server)
  expect(propagateToClientContext(conflict, { exact: ["TRACE"] })).toBe(conflict)
})

test("rejects malformed propagation rules before reading Context metadata", () => {
  for (const options of [
    null,
    [],
    new Date(),
    { unknown: ["trace"] },
    { exact: "trace" },
    { exact: [""] },
    { exact: [1] },
    { prefix: "" },
    { prefix: [""] },
    { prefix: ["\ud800"] }
  ]) {
    expect(() => propagateToClientContext(background(), options as never)).toThrow(TypeError)
  }

  const sparse = Array(2)
  sparse[1] = "trace"
  expect(() => propagateToClientContext(background(), { prefix: sparse })).toThrow("dense")

  const getter = Object.defineProperty({}, "exact", {
    enumerable: true,
    get: () => ["trace"]
  })
  expect(() => propagateToClientContext(background(), getter)).toThrow("data properties")

  const symbolOptions = { exact: ["trace"], [Symbol("hidden")]: ["secret"] }
  expect(() => propagateToClientContext(background(), symbolOptions)).toThrow("only string keys")

  const getterRules = ["trace"]
  Object.defineProperty(getterRules, "0", {
    enumerable: true,
    get: () => "trace"
  })
  expect(() => propagateToClientContext(background(), { exact: getterRules })).toThrow(
    "data values"
  )
})
