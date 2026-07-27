import { expect, test } from "bun:test"

import { newRedisCacheOperationError, newRedisCacheProtocolError } from "../src/errors"
import { captureRedisCacheOptions } from "../src/options"

test("Redis options are credential-safe immutable construction snapshots", () => {
  const onError = () => undefined
  const options = captureRedisCacheOptions({
    url: "rediss://user:secret@example.test:6380/2",
    prefix: "tenant:",
    connectTimeoutMs: 10,
    commandTimeoutMs: 20,
    onError
  })
  expect(options).toEqual({
    url: "rediss://user:secret@example.test:6380/2",
    client: null,
    prefix: "tenant:",
    connectTimeoutMs: 10,
    commandTimeoutMs: 20,
    onError
  })
  expect(Object.isFrozen(options)).toBe(true)
  expect(captureRedisCacheOptions({ url: "redis://127.0.0.1" })).toMatchObject({
    prefix: "likego:cache:",
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 5_000,
    onError: null
  })
  expect(captureRedisCacheOptions({ url: "redis://127.0.0.1", prefix: "🐈:" }).prefix).toBe("🐈:")

  const client = () => ({}) as never
  const native = captureRedisCacheOptions({ client, prefix: "native:" })
  expect(native).toEqual({
    url: null,
    client,
    prefix: "native:",
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 5_000,
    onError: null
  })
  expect(Object.isFrozen(native)).toBe(true)
})

test("Redis options reject malformed URLs prefixes timeouts and callbacks", () => {
  for (const options of [
    null,
    { url: "" },
    { url: "not a url" },
    { url: "https://example.test" },
    { url: "redis://127.0.0.1", prefix: "\ud800" },
    { url: "redis://127.0.0.1", prefix: "\udc00" },
    { url: "redis://127.0.0.1", connectTimeoutMs: 0 },
    { url: "redis://127.0.0.1", commandTimeoutMs: 2_147_483_648 },
    { url: "redis://127.0.0.1", onError: 1 },
    {},
    { client: null },
    { client: {} },
    { client: () => ({}), connectTimeoutMs: 1 },
    { url: "redis://127.0.0.1", client: () => ({}) }
  ]) {
    expect(() => Reflect.apply(captureRedisCacheOptions, undefined, [options])).toThrow()
  }
  expect(() =>
    captureRedisCacheOptions({ url: "redis://127.0.0.1", prefix: "x".repeat(1_025) })
  ).toThrow(RangeError)
})

test("Redis errors are stable frozen and preserve exact Error causes", () => {
  const cause = new Error("socket")
  const operation = newRedisCacheOperationError("get", cause)
  expect(operation).toMatchObject({
    name: "RedisCacheOperationError",
    code: "LIKEGO_CACHE_REDIS_OPERATION",
    operation: "get",
    cause
  })
  expect(Object.isFrozen(operation)).toBe(true)
  const protocol = newRedisCacheProtocolError()
  expect(protocol).toMatchObject({
    name: "RedisCacheProtocolError",
    code: "LIKEGO_CACHE_REDIS_PROTOCOL",
    operation: "get"
  })
  expect(Object.isFrozen(protocol)).toBe(true)
  expect(() => Reflect.apply(newRedisCacheOperationError, undefined, ["bad", cause])).toThrow()
  expect(() => Reflect.apply(newRedisCacheOperationError, undefined, ["get", "bad"])).toThrow()
})
