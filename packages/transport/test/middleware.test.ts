import { expect, test } from "bun:test"

import { background } from "@go-like/context"

import { chain, type Handler, type Middleware } from "../src/index"

test("chain preserves declaration order, arguments, result, and Context identity", async () => {
  const events: string[] = []
  const ctx = background()
  const handler: Handler<string, Promise<string>, readonly [number]> = async (
    received,
    input,
    suffix
  ) => {
    expect(received).toBe(ctx)
    events.push(`handler:${input}:${suffix}`)
    return `${input}-${suffix}`
  }
  const outer: Middleware<string, Promise<string>, readonly [number]> = (next) => {
    return async (received, input, suffix) => {
      events.push("outer:before")
      const result = await next(received, input, suffix)
      events.push("outer:after")
      return result
    }
  }
  const inner: Middleware<string, Promise<string>, readonly [number]> = (next) => {
    return async (received, input, suffix) => {
      events.push("inner:before")
      const result = await next(received, input, suffix)
      events.push("inner:after")
      return result
    }
  }

  const composed = chain(handler, outer, inner)
  await expect(composed(ctx, "value", 7)).resolves.toBe("value-7")
  expect(events).toEqual([
    "outer:before",
    "inner:before",
    "handler:value:7",
    "inner:after",
    "outer:after"
  ])
})

test("chain preserves short-circuit results and exact error identity", async () => {
  const failure = new Error("middleware failure")
  const handler: Handler<string, Promise<string>> = async (_ctx, input) => input
  const shortCircuit: Middleware<string, Promise<string>> = (_next) => {
    return async (_ctx, _input) => "short"
  }
  const reject: Middleware<string, Promise<string>> = (_next) => {
    return async (_ctx, _input) => {
      throw failure
    }
  }

  await expect(chain(handler, shortCircuit)(background(), "ignored")).resolves.toBe("short")
  await expect(chain(handler, reject)(background(), "ignored")).rejects.toBe(failure)
})

test("chain rejects invalid handlers, middleware, and wrapper results", () => {
  const handler: Handler<string, string> = (_ctx, input) => input
  const invalidMiddleware = null as unknown as Middleware<string, string>
  const invalidResult: Middleware<string, string> = (_next) => {
    return null as unknown as Handler<string, string>
  }

  expect(() => chain(null as unknown as Handler<string, string>)).toThrow(
    "handler must be a function"
  )
  expect(() => chain(handler, invalidMiddleware)).toThrow("middleware must be a function")
  expect(() => chain(handler, invalidResult)).toThrow("middleware must return a handler function")
})
