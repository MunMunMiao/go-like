import { expect, test } from "bun:test"

import * as publicApi from "../../src/bun"
import { newBunServerWithRuntime } from "../../src/bun-server"

const maximumTimerDelayMs = 2_147_483_647

test("exports the exact runtime surface", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "bunShutdownTimeout",
    "hostname",
    "newBunServer",
    "port"
  ])
})

test("creates a structural Core server", () => {
  const server = publicApi.newBunServer(() => new Response("ok"))

  expect(server.protocol()).toBe("http")
  expect(typeof server.start).toBe("function")
  expect(typeof server.stop).toBe("function")
  expect(typeof server.endpoint).toBe("function")
  expect(Object.isFrozen(server)).toBe(true)
})

test("validates construction inputs synchronously", () => {
  expect(() => publicApi.newBunServer(undefined as never)).toThrow("handler must be callable")
  expect(() => publicApi.newBunServer(() => new Response(), publicApi.hostname(""))).toThrow(
    TypeError
  )
  expect(() => publicApi.newBunServer(() => new Response(), publicApi.port(-1))).toThrow(TypeError)
  expect(() => publicApi.newBunServer(() => new Response(), publicApi.port(65_536))).toThrow(
    TypeError
  )
  expect(() =>
    publicApi.newBunServer(() => new Response(), publicApi.bunShutdownTimeout(Number.NaN))
  ).toThrow("bunShutdownTimeout must be finite and from 0 to 2147483647")
  expect(() => publicApi.newBunServer(() => new Response(), undefined as never)).toThrow(
    "bun server option must be callable"
  )
  expect(() =>
    newBunServerWithRuntime(undefined as never, { serve: () => undefined as never })
  ).toThrow(TypeError)
})

test("functional options return immutable BunServerOptions snapshots", () => {
  const defaults = Object.freeze({
    hostname: "127.0.0.1",
    port: 0,
    shutdownTimeoutMs: 25_000
  })

  const configured = publicApi.hostname("localhost")(defaults)

  expect(configured).toEqual({ hostname: "localhost", port: 0, shutdownTimeoutMs: 25_000 })
  expect(Object.isFrozen(configured)).toBe(true)
  expect(defaults.hostname).toBe("127.0.0.1")
  expect(publicApi.port(8080)(defaults).port).toBe(8080)
  expect(publicApi.bunShutdownTimeout(maximumTimerDelayMs)(defaults).shutdownTimeoutMs).toBe(
    maximumTimerDelayMs
  )
})

test("functional options reject malformed structural snapshots with Bun-scoped messages", () => {
  expect(() => publicApi.hostname("localhost")(null as never)).toThrow(
    "bun server options must be an object"
  )
  expect(() => publicApi.port(8080)({ hostname: "", port: 0, shutdownTimeoutMs: 1 })).toThrow(
    "bun hostname must be a non-empty string"
  )
  expect(() =>
    publicApi.bunShutdownTimeout(1_000)({
      hostname: "127.0.0.1",
      port: 0,
      shutdownTimeoutMs: Number.NaN
    })
  ).toThrow(RangeError)
})
