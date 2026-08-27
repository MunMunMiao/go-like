import { expect, test } from "bun:test"

import { canceled, cause, type Context } from "@go-like/context"

import { contextHandler } from "../src/index"

function requestWithThrowingRemoval(): {
  readonly request: Request
  readonly counts: { add: number; remove: number }
} {
  const counts = { add: 0, remove: 0 }
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(
      type: string,
      _listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean
    ) {
      expect(type).toBe("abort")
      expect(options).toEqual({ once: true })
      counts.add += 1
    },
    removeEventListener(type: string, _listener: EventListenerOrEventListenerObject) {
      expect(type).toBe("abort")
      counts.remove += 1
      throw new Error("structural removal failed")
    }
  }
  return { request: { signal } as unknown as Request, counts }
}

test("cleanup removal failure cannot replace a synchronous Response", () => {
  const expectedResponse = new Response("ok")
  const { request, counts } = requestWithThrowingRemoval()
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    return expectedResponse
  })

  const response = fetchHandler(request)

  expect(response).toBe(expectedResponse)
  expect(counts).toEqual({ add: 1, remove: 1 })
  expect((observedContext as Context | null)?.err()).toBe(canceled)
})

test("cleanup removal failure cannot replace a synchronous handler throw", () => {
  const handlerError = new Error("domain throw")
  const { request, counts } = requestWithThrowingRemoval()
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    throw handlerError
  })

  let observed: unknown
  try {
    fetchHandler(request)
  } catch (error) {
    observed = error
  }

  expect(observed).toBe(handlerError)
  expect(counts).toEqual({ add: 1, remove: 1 })
  expect((observedContext as Context | null)?.err()).toBe(canceled)
})

test("cleanup removal failure cannot replace an asynchronous handler rejection", async () => {
  const handlerError = new Error("domain rejection")
  const { request, counts } = requestWithThrowingRemoval()
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    return Promise.reject(handlerError)
  })

  const outcome = Promise.resolve(fetchHandler(request))

  await expect(outcome).rejects.toBe(handlerError)
  expect(counts).toEqual({ add: 1, remove: 1 })
  expect((observedContext as Context | null)?.err()).toBe(canceled)
})

test("registration failure remains authoritative while private resources are released", () => {
  const registrationError = new Error("registration failed")
  let removeCalls = 0
  let handlerCalls = 0
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener() {
      throw registrationError
    },
    removeEventListener() {
      removeCalls += 1
      throw new Error("removal also failed")
    }
  }
  const request = { signal } as unknown as Request
  const fetchHandler = contextHandler(() => {
    handlerCalls += 1
    return new Response("unexpected")
  })

  let observed: unknown
  try {
    fetchHandler(request)
  } catch (error) {
    observed = error
  }

  expect(observed).toBe(registrationError)
  expect(handlerCalls).toBe(0)
  expect(removeCalls).toBe(1)
})

test("a throwing request.signal getter remains authoritative without leaking a timeout", () => {
  const getterError = new Error("signal getter failed")
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let setCalls = 0
  let clearCalls = 0
  let handlerCalls = 0
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) => {
    setCalls += 1
    return originalSetTimeout(callback, delay, ...arguments_)
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    clearCalls += 1
    return originalClearTimeout(timer)
  }) as typeof globalThis.clearTimeout

  let observed: unknown
  try {
    const request = Object.defineProperty({}, "signal", {
      get() {
        throw getterError
      }
    }) as Request
    const fetchHandler = contextHandler(
      () => {
        handlerCalls += 1
        return new Response("unexpected")
      },
      { timeoutMs: 60_000 }
    )

    try {
      fetchHandler(request)
    } catch (error) {
      observed = error
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }

  expect(observed).toBe(getterError)
  expect(handlerCalls).toBe(0)
  expect(setCalls).toBe(clearCalls)
})

test("a stale listener cannot dispatch cancellation after handler settlement", () => {
  const lateReason = new Error("late abort")
  let aborted = false
  let reasonReads = 0
  let listener: EventListenerOrEventListenerObject | null = null
  const signal = {
    get aborted() {
      return aborted
    },
    get reason() {
      reasonReads += 1
      return lateReason
    },
    addEventListener(_type: string, nextListener: EventListenerOrEventListenerObject) {
      listener = nextListener
    },
    removeEventListener() {
      throw new Error("listener remained registered")
    }
  }
  const request = { signal } as unknown as Request
  let observedContext: Context | null = null

  contextHandler((ctx) => {
    observedContext = ctx
    return new Response("ok")
  })(request)
  aborted = true
  const staleListener = listener as EventListenerOrEventListenerObject | null
  if (typeof staleListener === "function") staleListener.call(signal, new Event("abort"))
  else staleListener?.handleEvent(new Event("abort"))

  const retainedContext = observedContext as Context | null
  expect(reasonReads).toBe(0)
  expect(retainedContext?.err()).toBe(canceled)
  expect(cause(retainedContext as Context)).toBe(canceled)
})

test("an invalid null handler result still releases request resources deterministically", () => {
  const { request, counts } = requestWithThrowingRemoval()
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    return null as unknown as Response
  })

  const result = fetchHandler(request)

  expect(result).toBeNull()
  expect(counts).toEqual({ add: 1, remove: 1 })
  expect((observedContext as Context | null)?.err()).toBe(canceled)
})

test("a throwing then getter remains authoritative while request resources are released", () => {
  const getterError = new Error("then getter failed")
  const hostileResult = Object.defineProperty({}, "then", {
    get() {
      throw getterError
    }
  })
  const { request, counts } = requestWithThrowingRemoval()
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    return hostileResult as Response
  })

  let observed: unknown
  try {
    fetchHandler(request)
  } catch (error) {
    observed = error
  }

  expect(observed).toBe(getterError)
  expect(counts).toEqual({ add: 1, remove: 1 })
  expect((observedContext as Context | null)?.err()).toBe(canceled)
})

test("a hostile thenable rejection preserves identity and releases request resources", async () => {
  const thenableError = new Error("thenable failed")
  const hostileResult = {
    then() {
      throw thenableError
    }
  }
  const { request, counts } = requestWithThrowingRemoval()
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    return hostileResult as unknown as Promise<Response>
  })

  await expect(Promise.resolve(fetchHandler(request))).rejects.toBe(thenableError)
  expect(counts).toEqual({ add: 1, remove: 1 })
  expect((observedContext as Context | null)?.err()).toBe(canceled)
})
