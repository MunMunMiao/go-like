import { expect, mock, test } from "bun:test"

import { background } from "@likego/context"

import type { RedisCacheErrorHandler } from "../src/types"
import { captureRedisCacheOptions } from "../src/options"

interface SetCall {
  readonly key: string
  readonly value: string
  readonly options: unknown
}

interface FakeClientState {
  readonly construction: unknown
  readonly commandOptions: Array<Readonly<Record<string, unknown>>>
  readonly gets: string[]
  readonly sets: SetCall[]
  readonly deletes: string[]
  readonly signals: AbortSignal[]
  errorListener: ((value: unknown) => void) | null
  getResult: string | null
  setResult: "OK" | null
  deleteResult: number
  connectCalls: number
  closeCalls: number
  destroyCalls: number
  onCalls: number
  offCalls: number
  closeFailure: Error | null
  destroyFailure: Error | null
  isOpen: boolean
  /** Emits one official client background error event. */
  emitError(value: unknown): void
}

const clients: FakeClientState[] = []

/** Creates one structure-only official client probe. */
function createClientProbe(construction: unknown): Record<string, unknown> {
  const state: FakeClientState = {
    construction,
    commandOptions: [],
    gets: [],
    sets: [],
    deletes: [],
    signals: [],
    errorListener: null,
    getResult: null,
    setResult: "OK",
    deleteResult: 0,
    connectCalls: 0,
    closeCalls: 0,
    destroyCalls: 0,
    onCalls: 0,
    offCalls: 0,
    closeFailure: null,
    destroyFailure: null,
    isOpen: false,
    emitError(value: unknown): void {
      state.errorListener?.(value)
    }
  }

  /** Reads one configured Redis value. */
  async function get(key: string): Promise<string | null> {
    state.gets.push(key)
    return state.getResult
  }

  /** Records one SET carrier and its optional expiry options. */
  async function set(key: string, value: string, options?: unknown): Promise<"OK" | null> {
    state.sets.push({ key, value, options })
    return state.setResult
  }

  /** Records one exact Redis deletion. */
  async function del(key: string): Promise<number> {
    state.deletes.push(key)
    return state.deleteResult
  }

  const command = { get, set, del }
  clients.push(state)
  return {
    get isOpen(): boolean {
      return state.isOpen
    },
    on(event: string, listener: (value: unknown) => void): void {
      if (event === "error") {
        state.onCalls += 1
        state.errorListener = listener
      }
    },
    off(event: string, listener: (value: unknown) => void): void {
      state.offCalls += 1
      if (event === "error" && state.errorListener === listener) state.errorListener = null
    },
    withCommandOptions(options: Readonly<Record<string, unknown>>): typeof command {
      state.commandOptions.push(options)
      const signal = options.abortSignal
      if (signal instanceof AbortSignal) state.signals.push(signal)
      return command
    },
    async connect(): Promise<void> {
      state.connectCalls += 1
    },
    get,
    set,
    del,
    async close(): Promise<void> {
      state.closeCalls += 1
      if (state.closeFailure !== null) throw state.closeFailure
    },
    destroy(): void {
      state.destroyCalls += 1
      if (state.destroyFailure !== null) throw state.destroyFailure
    }
  }
}

mock.module("@redis/client", function officialRedisClientModule() {
  return { createClient: createClientProbe }
})

const { newRedisConnection } = await import("../src/connection")
const { newRedisCache } = await import("../src/cache")

/** Returns the most recently constructed official client probe. */
function latest(): FakeClientState {
  const state = clients.at(-1)
  if (state === undefined) throw new Error("Redis client probe was not constructed")
  return state
}

/** Creates one connection and returns the official client probe it owns. */
function fixture(onError?: RedisCacheErrorHandler) {
  const options =
    onError === undefined
      ? captureRedisCacheOptions({ url: "redis://127.0.0.1" })
      : captureRedisCacheOptions({ url: "redis://127.0.0.1", onError })
  const connection = newRedisConnection(options)
  return Object.freeze({ connection, state: latest() })
}

test("official wrapper maps construction commands AbortSignal and PX expiry", async () => {
  const current = fixture()
  expect(current.state.construction).toEqual({
    url: "redis://127.0.0.1",
    socket: { connectTimeout: 5_000 },
    commandOptions: { timeout: 5_000 }
  })
  await current.connection.connect()
  expect(current.state.connectCalls).toBe(1)

  current.state.getResult = "value"
  expect(await current.connection.get(null, "plain")).toBe("value")
  const controller = new AbortController()
  expect(await current.connection.get(controller.signal, "signaled")).toBe("value")
  expect(current.state.gets).toEqual(["plain", "signaled"])
  expect(current.state.signals).toEqual([controller.signal])
  expect(current.state.commandOptions).toEqual([
    { timeout: 5_000 },
    { abortSignal: controller.signal, timeout: 5_000 }
  ])

  await current.connection.put(null, "forever", "one", null)
  await current.connection.put(controller.signal, "ttl", "two", 25)
  expect(current.state.sets).toEqual([
    { key: "forever", value: "one", options: undefined },
    { key: "ttl", value: "two", options: { expiration: { type: "PX", value: 25 } } }
  ])
  current.state.deleteResult = 2
  expect(await current.connection.remove(null, "gone")).toBe(2)
  expect(current.state.deletes).toEqual(["gone"])
  expect(current.state.commandOptions).toHaveLength(5)

  await current.connection.close()
  expect(current.state.closeCalls).toBe(1)
  expect(current.state.onCalls).toBe(1)
  expect(current.state.offCalls).toBe(1)
  expect(current.state.errorListener).toBeNull()
})

test("public constructor owns the default official connection factory", async () => {
  const cache = newRedisCache({ url: "redis://127.0.0.1" })
  const state = latest()
  expect(cache.string()).toBe("redis")
  const running = cache.start(background())
  expect(state.connectCalls).toBe(1)
  await cache.stop(background())
  await running
  expect(state.closeCalls).toBe(1)
})

test("public constructor invokes one dormant native client factory exactly once", async () => {
  const native = createClientProbe({ mode: "native" })
  const state = latest()
  let factoryCalls = 0
  const cache = Reflect.apply(newRedisCache, undefined, [
    {
      client() {
        factoryCalls += 1
        return native
      }
    }
  ])
  expect(factoryCalls).toBe(1)
  expect(state.connectCalls).toBe(0)

  const running = cache.start(background())
  expect(state.connectCalls).toBe(1)
  await cache.stop(background())
  await running
  expect(state.closeCalls).toBe(1)
})

test("public constructor rejects an already-open native client", () => {
  const native = createClientProbe({ mode: "open" })
  const state = latest()
  state.isOpen = true
  expect(() => Reflect.apply(newRedisCache, undefined, [{ client: () => native }])).toThrow(
    "must not already be open"
  )
})

test("public constructor rejects a malformed native client", () => {
  expect(() =>
    Reflect.apply(newRedisCache, undefined, [{ client: () => Object.freeze({}) }])
  ).toThrow("must return an official node-redis client")
})

test("official wrapper rejects an unexpected SET reply", async () => {
  const current = fixture()
  current.state.setResult = null
  await expect(current.connection.put(null, "key", "value", null)).rejects.toThrow(
    "unexpected reply"
  )
})

test("background errors are normalized and callback failures stay detached", async () => {
  const withoutHandler = fixture()
  expect(() => withoutHandler.state.emitError(new Error("ignored"))).not.toThrow()

  const observed: Error[] = []
  const asynchronous = fixture(async function onError(error): Promise<void> {
    observed.push(error)
    throw new Error("callback rejected")
  })
  asynchronous.state.emitError("foreign")
  await Promise.resolve()
  await Promise.resolve()
  expect(observed).toHaveLength(1)
  expect(observed[0]).toBeInstanceOf(Error)

  const synchronous = fixture(function onError(): void {
    throw new Error("callback threw")
  })
  expect(() => synchronous.state.emitError(new Error("socket"))).not.toThrow()
})

test("close and destroy always remove the exact error listener", async () => {
  const closing = fixture()
  const closeFailure = new Error("close failed")
  closing.state.closeFailure = closeFailure
  await expect(closing.connection.close()).rejects.toBe(closeFailure)
  expect(closing.state.onCalls).toBe(1)
  expect(closing.state.offCalls).toBe(1)
  expect(closing.state.errorListener).toBeNull()

  const destroying = fixture()
  const destroyFailure = new Error("destroy failed")
  destroying.state.destroyFailure = destroyFailure
  expect(() => destroying.connection.destroy()).toThrow(destroyFailure)
  expect(destroying.state.destroyCalls).toBe(1)
  expect(destroying.state.onCalls).toBe(1)
  expect(destroying.state.offCalls).toBe(1)
  expect(destroying.state.errorListener).toBeNull()
})
