import { expect, test } from "bun:test"

import * as publicApi from "../../src/node"
import { newNodeServerWithFactory } from "../../src/node-server"

const maximumTimerDelayMs = 2_147_483_647

test("exports the exact runtime surface", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "hostname",
    "newNodeServer",
    "nodeShutdownTimeout",
    "port"
  ])
})

test("creates a structural Core server", () => {
  const server = publicApi.newNodeServer(() => new Response("ok"))

  expect(typeof server.start).toBe("function")
  expect(typeof server.stop).toBe("function")
})

test("validates construction inputs synchronously", () => {
  expect(() => publicApi.newNodeServer(undefined as never)).toThrow(TypeError)
  expect(() => publicApi.newNodeServer(() => new Response(), publicApi.hostname(""))).toThrow(
    TypeError
  )
  expect(() => publicApi.newNodeServer(() => new Response(), publicApi.port(-1))).toThrow(TypeError)
  expect(() => publicApi.newNodeServer(() => new Response(), publicApi.port(65_536))).toThrow(
    TypeError
  )
  expect(() =>
    publicApi.newNodeServer(() => new Response(), publicApi.nodeShutdownTimeout(Number.NaN))
  ).toThrow(RangeError)
  expect(() => publicApi.newNodeServer(() => new Response(), undefined as never)).toThrow(TypeError)
  expect(() => newNodeServerWithFactory(undefined as never, () => undefined as never)).toThrow(
    TypeError
  )
  expect(() => newNodeServerWithFactory(() => new Response(), undefined as never)).toThrow(
    TypeError
  )
})

test("functional options return immutable NodeServerOptions snapshots", () => {
  const defaults = Object.freeze({
    hostname: "127.0.0.1",
    port: 0,
    shutdownTimeoutMs: 25_000
  })

  const configured = publicApi.hostname("localhost")(defaults)

  expect(configured).toEqual({
    hostname: "localhost",
    port: 0,
    shutdownTimeoutMs: 25_000
  })
  expect(Object.isFrozen(configured)).toBe(true)
  expect(defaults.hostname).toBe("127.0.0.1")
})

const acceptedTimerDelays = [0, 0.5, 1.5, maximumTimerDelayMs - 0.5, maximumTimerDelayMs] as const

const rejectedTimerDelays = [
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  maximumTimerDelayMs + 0.5,
  maximumTimerDelayMs + 1
] as const

for (const timeoutMs of acceptedTimerDelays) {
  test(`Node shutdown options accept the supported timer value ${timeoutMs}`, () => {
    const defaults = Object.freeze({
      hostname: "127.0.0.1",
      port: 0,
      shutdownTimeoutMs: 25_000
    })

    expect(publicApi.nodeShutdownTimeout(timeoutMs)(defaults).shutdownTimeoutMs).toBe(timeoutMs)
  })

  test(`structural options accept the supported timer value ${timeoutMs}`, () => {
    const configured = publicApi.hostname("localhost")({
      hostname: "127.0.0.1",
      port: 0,
      shutdownTimeoutMs: timeoutMs
    })

    expect(configured.shutdownTimeoutMs).toBe(timeoutMs)
  })
}

for (const timeoutMs of rejectedTimerDelays) {
  test(`Node shutdown options reject the unsupported timer value ${timeoutMs}`, () => {
    expect(() => publicApi.nodeShutdownTimeout(timeoutMs)).toThrow(RangeError)
  })

  test(`structural options reject the unsupported timer value ${timeoutMs}`, () => {
    expect(() =>
      publicApi.hostname("localhost")({
        hostname: "127.0.0.1",
        port: 0,
        shutdownTimeoutMs: timeoutMs
      })
    ).toThrow(RangeError)
  })
}

test("functional options reject malformed structural snapshots", () => {
  expect(() => publicApi.hostname("localhost")(null as never)).toThrow(TypeError)
  expect(() =>
    publicApi.hostname("localhost")({
      hostname: "",
      port: 0,
      shutdownTimeoutMs: 25_000
    })
  ).toThrow(TypeError)
  expect(() =>
    publicApi.port(8080)({
      hostname: "127.0.0.1",
      port: -1,
      shutdownTimeoutMs: 25_000
    })
  ).toThrow(TypeError)
  expect(() =>
    publicApi.nodeShutdownTimeout(1_000)({
      hostname: "127.0.0.1",
      port: 0,
      shutdownTimeoutMs: Number.NaN
    })
  ).toThrow(RangeError)
})
