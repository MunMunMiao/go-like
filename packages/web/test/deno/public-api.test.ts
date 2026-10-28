import { expect, test } from "bun:test"

import * as publicApi from "../../src/deno"
import { newDenoServerWithRuntime } from "../../src/deno-server"

const maximumTimerDelayMs = 2_147_483_647

test("exports the exact runtime surface", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "denoShutdownTimeout",
    "hostname",
    "newDenoServer",
    "port"
  ])
})

test("reports a missing Deno runtime at construction without touching import", () => {
  expect(Reflect.get(globalThis, "Deno")).toBeUndefined()
  expect(() => publicApi.newDenoServer(() => new Response("ok"))).toThrow(
    "@go-like/web/deno requires the Deno runtime"
  )
})

test("validates construction inputs synchronously", () => {
  const runtime = { serve: () => undefined as never }

  expect(() => newDenoServerWithRuntime(undefined as never, runtime)).toThrow(
    "handler must be callable"
  )
  expect(() =>
    newDenoServerWithRuntime(() => new Response(), runtime, publicApi.hostname(""))
  ).toThrow(TypeError)
  expect(() => newDenoServerWithRuntime(() => new Response(), runtime, publicApi.port(-1))).toThrow(
    TypeError
  )
  expect(() =>
    newDenoServerWithRuntime(
      () => new Response(),
      runtime,
      publicApi.denoShutdownTimeout(Number.NaN)
    )
  ).toThrow("denoShutdownTimeout must be finite and from 0 to 2147483647")
  expect(() => newDenoServerWithRuntime(() => new Response(), runtime, undefined as never)).toThrow(
    "deno server option must be callable"
  )
})

test("creates a frozen structural Core server over an injected runtime", () => {
  const server = newDenoServerWithRuntime(() => new Response("ok"), {
    serve: () => undefined as never
  })

  expect(server.protocol()).toBe("http")
  expect(typeof server.start).toBe("function")
  expect(typeof server.stop).toBe("function")
  expect(typeof server.endpoint).toBe("function")
  expect(Object.isFrozen(server)).toBe(true)
})

test("functional options return immutable DenoServerOptions snapshots", () => {
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
  expect(publicApi.denoShutdownTimeout(maximumTimerDelayMs)(defaults).shutdownTimeoutMs).toBe(
    maximumTimerDelayMs
  )
})

test("functional options reject malformed structural snapshots with Deno-scoped messages", () => {
  expect(() => publicApi.hostname("localhost")(null as never)).toThrow(
    "deno server options must be an object"
  )
  expect(() => publicApi.port(8080)({ hostname: "", port: 0, shutdownTimeoutMs: 1 })).toThrow(
    "deno hostname must be a non-empty string"
  )
  expect(() =>
    publicApi.denoShutdownTimeout(1_000)({
      hostname: "127.0.0.1",
      port: 0,
      shutdownTimeoutMs: Number.NaN
    })
  ).toThrow(RangeError)
})
