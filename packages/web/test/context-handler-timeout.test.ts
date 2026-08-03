import { expect, test } from "bun:test"

import { canceled, deadlineExceeded, type Context } from "@likego/context"

import { contextHandler } from "../src/index"

test("omitted timeout exposes no deadline and cancels the retained Context on return", async () => {
  let observedContext: Context | null = null
  let deadlinePresent: boolean | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    deadlinePresent = ctx.deadline()[1]
    return new Response("ok")
  })

  await fetchHandler(new Request("https://example.test/"))
  const retainedContext = observedContext as Context | null

  expect(deadlinePresent as boolean | null).toBe(false)
  expect(retainedContext?.err()).toBe(canceled)
  expect(retainedContext?.done()?.aborted).toBe(true)
})

test("configured timeout exposes its snapshotted numeric deadline", async () => {
  const wallNow = 1_800_000_000_000
  const originalDateNow = Date.now
  let observedDeadline: readonly [Date, boolean] | null = null
  Date.now = () => wallNow
  try {
    const fetchHandler = contextHandler(
      (ctx) => {
        observedDeadline = ctx.deadline()
        return new Response("ok")
      },
      { timeoutMs: 12_345.9 }
    )

    await fetchHandler(new Request("https://example.test/"))
  } finally {
    Date.now = originalDateNow
  }

  const deadline = observedDeadline as readonly [Date, boolean] | null
  expect(deadline?.[1]).toBe(true)
  expect(deadline?.[0].getTime()).toBe(wallNow + 12_345)
})

test.each([0, -1])(
  "timeout %d is already deadlineExceeded when the handler begins",
  async (timeoutMs) => {
    let observedContext: Context | null = null
    await contextHandler(
      (ctx) => {
        observedContext = ctx
        return new Response("ok")
      },
      { timeoutMs }
    )(new Request("https://example.test/"))

    expect((observedContext as Context | null)?.err()).toBe(deadlineExceeded)
  }
)

test("an in-flight timeout cancels Context without settling the handler promise", async () => {
  const expectedResponse = new Response("late")
  let observedContext: Context | null = null
  let resolveHandler: ((response: Response) => void) | null = null
  const handlerPromise = new Promise<Response>((resolve) => {
    resolveHandler = resolve
  })
  const fetchHandler = contextHandler(
    (ctx) => {
      observedContext = ctx
      return handlerPromise
    },
    { timeoutMs: 5 }
  )

  const outcome = Promise.resolve(fetchHandler(new Request("https://example.test/")))
  await Bun.sleep(20)

  expect((observedContext as Context | null)?.err()).toBe(deadlineExceeded)
  ;(resolveHandler as ((response: Response) => void) | null)?.(expectedResponse)
  await expect(outcome).resolves.toBe(expectedResponse)
})

test("handler settlement clears a configured timeout timer", async () => {
  const originalClearTimeout = globalThis.clearTimeout
  let clearCalls = 0
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    clearCalls += 1
    return originalClearTimeout(timer)
  }) as typeof globalThis.clearTimeout
  let observedContext: Context | null = null
  try {
    await contextHandler(
      (ctx) => {
        observedContext = ctx
        return new Response("ok")
      },
      { timeoutMs: 60_000 }
    )(new Request("https://example.test/"))
  } finally {
    globalThis.clearTimeout = originalClearTimeout
  }

  expect(clearCalls).toBe(1)
  expect((observedContext as Context | null)?.err()).toBe(canceled)
})

test("releases the request Context when timeout construction fails", () => {
  const originalDateNow = Date.now
  Date.now = () => Number.NaN
  try {
    const fetchHandler = contextHandler(() => new Response("unexpected"), { timeoutMs: 1 })

    expect(() => fetchHandler(new Request("https://example.test/"))).toThrow(RangeError)
  } finally {
    Date.now = originalDateNow
  }
})
