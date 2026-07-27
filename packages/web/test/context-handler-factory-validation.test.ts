import { expect, test } from "bun:test"

import { contextHandler, type ContextHandler, type ContextHandlerOptions } from "../src/index"

test("rejects a non-callable handler at factory creation", () => {
  expect(() => contextHandler(null as unknown as ContextHandler)).toThrow(TypeError)
})

test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "rejects the non-finite timeout %s before a request",
  (timeoutMs) => {
    let calls = 0
    const handler: ContextHandler = () => {
      calls += 1
      return new Response("unexpected")
    }

    expect(() => contextHandler(handler, { timeoutMs })).toThrow(RangeError)
    expect(calls).toBe(0)
  }
)

test.each([undefined, 10, 0, -10])("accepts the timeout snapshot %s", (timeoutMs) => {
  const options = timeoutMs === undefined ? undefined : { timeoutMs }
  expect(() => contextHandler(() => new Response("ok"), options)).not.toThrow()
})

test("reads the timeout getter once at factory creation", () => {
  let reads = 0
  const options = Object.defineProperty({}, "timeoutMs", {
    get() {
      reads += 1
      return 100
    }
  }) as ContextHandlerOptions

  contextHandler(() => new Response("ok"), options)

  expect(reads).toBe(1)
})

test("captures the handler supplied at factory creation", async () => {
  const firstResponse = new Response("first")
  const secondResponse = new Response("second")
  let handler: ContextHandler = () => firstResponse
  const fetchHandler = contextHandler(handler)
  handler = () => secondResponse

  const response = await fetchHandler(new Request("https://example.test/"))

  expect(response).toBe(firstResponse)
})
