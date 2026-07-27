import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import { canceled, cause, type Context } from "@likego/context"

import { contextHandler } from "../src/index"

interface StructuralSignalOptions {
  readonly initiallyAborted: boolean
  readonly reason: unknown
  readonly abortDuringRegistration?: boolean
}

function structuralRequest(options: StructuralSignalOptions): {
  readonly request: Request
  readonly counts: {
    add: number
    reason: number
    remove: number
  }
} {
  let aborted = options.initiallyAborted
  let listener: EventListenerOrEventListenerObject | null = null
  const counts = { add: 0, reason: 0, remove: 0 }
  const signal = {
    get aborted() {
      return aborted
    },
    get reason() {
      counts.reason += 1
      return options.reason
    },
    addEventListener(
      type: string,
      nextListener: EventListenerOrEventListenerObject,
      eventOptions?: AddEventListenerOptions | boolean
    ) {
      expect(type).toBe("abort")
      expect(eventOptions).toEqual({ once: true })
      counts.add += 1
      const registeredListener = nextListener
      listener = registeredListener
      if (options.abortDuringRegistration === true) {
        aborted = true
        if (typeof registeredListener === "function") {
          registeredListener.call(signal, new Event("abort"))
        } else {
          registeredListener.handleEvent(new Event("abort"))
        }
      }
    },
    removeEventListener(type: string, removedListener: EventListenerOrEventListenerObject) {
      expect(type).toBe("abort")
      expect(listener).not.toBeNull()
      expect(removedListener).toBe(listener as EventListenerOrEventListenerObject)
      counts.remove += 1
    }
  }

  return {
    request: { signal } as unknown as Request,
    counts
  }
}

test("invokes a handler once with an already-canceled Context for a pre-aborted request", async () => {
  const reason = new Error("client disconnected")
  const controller = new AbortController()
  controller.abort(reason)
  const request = new Request("https://example.test/", { signal: controller.signal })
  const expectedResponse = new Response("ok")
  let calls = 0
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    calls += 1
    observedContext = ctx
    return expectedResponse
  })

  const response = await fetchHandler(request)
  const retainedContext = observedContext as Context | null

  expect(calls).toBe(1)
  expect(response).toBe(expectedResponse)
  expect(retainedContext?.err()).toBe(canceled)
  expect(cause(retainedContext as Context)).toBe(reason)
})

test("normalizes an undefined request-abort reason to canceled", async () => {
  const { request, counts } = structuralRequest({ initiallyAborted: true, reason: undefined })
  let observedContext: Context | null = null

  await contextHandler((ctx) => {
    observedContext = ctx
    return new Response("ok")
  })(request)
  const retainedContext = observedContext as Context | null

  expect(retainedContext?.err()).toBe(canceled)
  expect(cause(retainedContext as Context)).toBe(canceled)
  expect(counts).toEqual({ add: 0, reason: 1, remove: 0 })
})

test("freezes a built-in Error with the raw non-Error abort reason as cause", async () => {
  const rawReason = { code: "disconnect" }
  const { request } = structuralRequest({ initiallyAborted: true, reason: rawReason })
  let observedContext: Context | null = null

  await contextHandler((ctx) => {
    observedContext = ctx
    return new Response("ok")
  })(request)

  const observedCause = cause(observedContext as unknown as Context)
  expect(Object.getPrototypeOf(observedCause)).toBe(Error.prototype)
  expect(observedCause?.message).toBe("request aborted with a non-Error reason")
  expect(observedCause?.cause).toBe(rawReason)
  expect(Object.isFrozen(observedCause)).toBe(true)
})

test("preserves the identity of a cross-realm built-in Error abort reason", async () => {
  const foreignError = runInNewContext('new Error("foreign disconnect")') as Error
  const { request } = structuralRequest({ initiallyAborted: true, reason: foreignError })
  let observedContext: Context | null = null

  await contextHandler((ctx) => {
    observedContext = ctx
    return new Response("ok")
  })(request)

  expect(foreignError instanceof Error).toBe(false)
  expect(cause(observedContext as unknown as Context)).toBe(foreignError)
})

test("falls back to realm-local Error recognition when Error.isError is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  if (descriptor === undefined) throw new Error("the pinned runtime must expose Error.isError")
  const reason = new Error("local disconnect")
  const { request } = structuralRequest({ initiallyAborted: true, reason })
  let observedContext: Context | null = null

  try {
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    await contextHandler((ctx) => {
      observedContext = ctx
      return new Response("ok")
    })(request)
  } finally {
    Object.defineProperty(Error, "isError", descriptor)
  }

  expect(cause(observedContext as unknown as Context)).toBe(reason)
})

test("normalizes an object forged to resemble a built-in Error", async () => {
  const forgedError = {
    name: "Error",
    message: "forged",
    stack: "Error: forged",
    [Symbol.toStringTag]: "Error"
  }
  const { request } = structuralRequest({ initiallyAborted: true, reason: forgedError })
  let observedContext: Context | null = null

  await contextHandler((ctx) => {
    observedContext = ctx
    return new Response("ok")
  })(request)

  const observedCause = cause(observedContext as unknown as Context)
  expect(observedCause).not.toBe(forgedError)
  expect(observedCause?.cause).toBe(forgedError)
})

test("closes an abort during registration without double-reading the reason", async () => {
  const reason = new Error("registration race")
  const { request, counts } = structuralRequest({
    initiallyAborted: false,
    reason,
    abortDuringRegistration: true
  })
  let calls = 0
  let observedContext: Context | null = null

  await contextHandler((ctx) => {
    calls += 1
    observedContext = ctx
    return new Response("ok")
  })(request)
  const retainedContext = observedContext as Context | null

  expect(calls).toBe(1)
  expect(retainedContext?.err()).toBe(canceled)
  expect(cause(retainedContext as Context)).toBe(reason)
  expect(counts).toEqual({ add: 1, reason: 1, remove: 1 })
})

test("makes in-flight request cancellation observational only", async () => {
  const reason = new Error("in flight")
  const handlerError = new Error("domain failure")
  const controller = new AbortController()
  const request = new Request("https://example.test/", { signal: controller.signal })
  let observedContext: Context | null = null
  let rejectHandler: ((error: Error) => void) | null = null
  const handlerPromise = new Promise<Response>((_resolve, reject) => {
    rejectHandler = reject
  })
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    return handlerPromise
  })

  const outcome = Promise.resolve(fetchHandler(request))
  controller.abort(reason)
  const retainedContext = observedContext as Context | null

  expect(retainedContext?.err()).toBe(canceled)
  expect(cause(retainedContext as Context)).toBe(reason)
  ;(rejectHandler as ((error: Error) => void) | null)?.(handlerError)
  await expect(outcome).rejects.toBe(handlerError)
})

test("preserves a synchronous handler throw after pre-abort", () => {
  const { request } = structuralRequest({ initiallyAborted: true, reason: undefined })
  const handlerError = new Error("synchronous domain failure")
  let calls = 0
  const fetchHandler = contextHandler(() => {
    calls += 1
    throw handlerError
  })

  let observed: unknown
  try {
    fetchHandler(request)
  } catch (error) {
    observed = error
  }

  expect(calls).toBe(1)
  expect(observed).toBe(handlerError)
})
