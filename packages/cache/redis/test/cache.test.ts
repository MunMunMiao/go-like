/// <reference lib="es2024.promise" />

import { expect, test } from "bun:test"

import { expiresIn, type Cache } from "@likego/cache"
import { background, withCancelCause } from "@likego/context"
import type { Server } from "@likego/core"

import { createRedisCache } from "../src/cache"
import { encodeRedisCacheValue } from "../src/codec"
import { fakeRedisFactory, fakeRedisState } from "./helpers"

interface StartedCache {
  readonly running: Promise<void>
}

/** Starts one Redis Cache without joining its resident lifetime. */
async function start(cache: Cache & Server): Promise<StartedCache> {
  const running = cache.start(background())
  void running.catch(() => {})
  await Bun.sleep(0)
  return { running }
}

test("Redis Cache owns one connection lifecycle and CRUD namespace", async () => {
  const state = fakeRedisState()
  const cache = createRedisCache(
    { url: "redis://127.0.0.1:6379", prefix: "test:" },
    fakeRedisFactory(state)
  )
  expect(state.connects).toBe(0)
  expect(cache.string()).toBe("redis")
  await expect(cache.get(background(), "before")).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_STATE"
  })

  const started = await start(cache)
  expect(state.connects).toBe(1)
  expect(await cache.get(background(), "missing")).toBeNull()

  const input = new Uint8Array([1, 2, 3])
  await cache.put(background(), "key", input, expiresIn(50))
  input[0] = 9
  expect(state.values.get("test:key")).toBe("v1:AQID")
  const first = await cache.get(background(), "key")
  expect(first).toEqual(new Uint8Array([1, 2, 3]))
  if (first === null) throw new Error("cache hit expected")
  first[0] = 7
  expect(await cache.get(background(), "key")).toEqual(new Uint8Array([1, 2, 3]))
  await cache.delete(background(), "key")
  expect(await cache.get(background(), "key")).toBeNull()
  await cache.delete(background(), "key")
  expect(state.signals.every((signal) => signal === null)).toBe(true)

  await cache.stop(background())
  await started.running
  expect(state.closes).toBe(1)
  await cache.stop(background())
  expect(state.closes).toBe(1)
  await expect(cache.get(background(), "after")).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_STATE"
  })
})

test("Redis Cache preserves local validation and canonical protocol errors", async () => {
  const state = fakeRedisState()
  const cache = createRedisCache({ url: "redis://127.0.0.1" }, fakeRedisFactory(state))
  const started = await start(cache)
  await expect(cache.get(background(), "")).rejects.toBeInstanceOf(TypeError)
  await expect(cache.get(background(), "\ud800")).rejects.toBeInstanceOf(TypeError)
  await expect(cache.get(background(), "\udc00")).rejects.toBeInstanceOf(TypeError)
  await expect(cache.get(background(), "x".repeat(1_025))).rejects.toBeInstanceOf(RangeError)
  await expect(cache.get(background(), "key-🐈")).resolves.toBeNull()
  await expect(cache.put(background(), "key", new Uint8Array(1_048_577))).rejects.toBeInstanceOf(
    RangeError
  )
  await expect(
    Reflect.apply(cache.put, cache, [background(), "key", "not-bytes"])
  ).rejects.toBeInstanceOf(TypeError)
  state.values.set("likego:cache:foreign", "foreign")
  await expect(cache.get(background(), "foreign")).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_PROTOCOL"
  })
  state.values.set("likego:cache:oversized", encodeRedisCacheValue(new Uint8Array(4)))
  await expect(cache.get(background(), "oversized")).resolves.toEqual(new Uint8Array(4))
  await cache.stop(background())
  await started.running
})

test("Redis Cache maps command failures and Context cancellation truthfully", async () => {
  const state = fakeRedisState()
  const getFailure = new Error("read failed")
  state.getFailure = getFailure
  const cache = createRedisCache({ url: "redis://127.0.0.1" }, fakeRedisFactory(state))
  const started = await start(cache)
  await expect(cache.get(background(), "key")).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_OPERATION",
    operation: "get",
    cause: getFailure
  })

  state.getFailure = null
  const putFailure = new Error("write failed")
  state.putFailure = putFailure
  await expect(cache.put(background(), "key", new Uint8Array([1]))).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_OPERATION",
    operation: "put",
    cause: putFailure
  })

  state.putFailure = null
  const deleteFailure = new Error("delete failed")
  state.removeFailure = deleteFailure
  await expect(cache.delete(background(), "key")).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_OPERATION",
    operation: "delete",
    cause: deleteFailure
  })

  const admittedCommands = state.signals.length
  const canceled = new Error("caller canceled")
  const pair = withCancelCause(background())
  pair[1](canceled)
  await expect(cache.get(pair[0], "key")).rejects.toBe(canceled)
  expect(state.signals).toHaveLength(admittedCommands)
  await cache.stop(background())
  await started.running
})

test("Redis Cache claims canceled startup and lets canceled stop start owner cleanup", async () => {
  const startupState = fakeRedisState()
  const startupCache = createRedisCache(
    { url: "redis://127.0.0.1" },
    fakeRedisFactory(startupState)
  )
  const startupCause = new Error("startup canceled")
  const startup = withCancelCause(background())
  startup[1](startupCause)
  await expect(startupCache.start(startup[0])).rejects.toBe(startupCause)
  expect(startupState.connects).toBe(0)
  expect(startupState.destroys).toBe(1)
  await expect(startupCache.start(background())).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_STATE",
    state: "failed"
  })

  const stopState = fakeRedisState()
  const stopCache = createRedisCache({ url: "redis://127.0.0.1" }, fakeRedisFactory(stopState))
  const started = await start(stopCache)
  const stopCause = new Error("stop waiter canceled")
  const stopContext = withCancelCause(background())
  stopContext[1](stopCause)
  await expect(stopCache.stop(stopContext[0])).rejects.toBe(stopCause)
  await started.running
  expect(stopState.closes).toBe(1)
})

test("Redis Cache drains admitted operations before close", async () => {
  const state = fakeRedisState()
  const gate = Promise.withResolvers<string | null>()
  state.pendingGet = gate.promise
  const cache = createRedisCache({ url: "redis://127.0.0.1" }, fakeRedisFactory(state))
  const started = await start(cache)
  const read = cache.get(background(), "key")
  await Promise.resolve()
  const stopped = cache.stop(background())
  await Promise.resolve()
  expect(state.closes).toBe(0)
  gate.resolve(null)
  await expect(read).resolves.toBeNull()
  await stopped
  await started.running
  expect(state.closes).toBe(1)
})

test("Redis Cache exposes close failure through the stable terminal", async () => {
  const state = fakeRedisState()
  const closeFailure = new Error("close failed")
  state.closeFailure = closeFailure
  const cache = createRedisCache({ url: "redis://127.0.0.1" }, fakeRedisFactory(state))
  const started = await start(cache)
  await expect(cache.stop(background())).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_OPERATION",
    operation: "close",
    cause: closeFailure
  })
  await expect(started.running).rejects.toMatchObject({ operation: "close" })
  expect(state.destroys).toBe(1)
})

test("Redis Cache preserves connect failure while best-effort destroy also fails", async () => {
  const state = fakeRedisState()
  const connectFailure = new Error("connect failed")
  state.connectFailure = connectFailure
  state.destroyFailure = new Error("destroy failed")
  const cache = createRedisCache({ url: "redis://127.0.0.1" }, fakeRedisFactory(state))
  await expect(cache.start(background())).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_OPERATION",
    operation: "connect",
    cause: connectFailure
  })
  expect(state.connects).toBe(1)
  expect(state.destroys).toBe(1)
})

test("Redis Cache preserves a synchronous close failure when destroy also fails", async () => {
  const state = fakeRedisState()
  const closeFailure = new Error("synchronous close failed")
  state.closeSynchronousFailure = closeFailure
  state.destroyFailure = new Error("destroy failed")
  const cache = createRedisCache({ url: "redis://127.0.0.1" }, fakeRedisFactory(state))
  const started = await start(cache)
  await expect(cache.stop(background())).rejects.toMatchObject({
    code: "LIKEGO_CACHE_REDIS_OPERATION",
    operation: "close",
    cause: closeFailure
  })
  expect(state.closes).toBe(1)
  expect(state.destroys).toBe(1)
  await expect(started.running).rejects.toMatchObject({ operation: "close" })
})
