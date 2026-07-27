import { expect, test } from "bun:test"
import { Hono } from "hono"

import * as HonoBridge from "../src/index"

test("binds a native Hono app while preserving receiver, Response, stream, and Error identity", async () => {
  const factory = Reflect.get(HonoBridge, "newHonoHandler")
  expect(typeof factory).toBe("function")
  if (typeof factory !== "function") return

  const app = new Hono()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hono"))
      controller.close()
    }
  })
  const response = new Response(stream)
  let receiver: unknown
  Object.defineProperty(app, "fetch", {
    configurable: true,
    value: function nativeFetch(this: unknown): Response {
      receiver = this
      return response
    }
  })

  const handler: unknown = Reflect.apply(factory, undefined, [app])
  expect(typeof handler).toBe("function")
  if (typeof handler !== "function") return
  const returned: unknown = Reflect.apply(handler, undefined, [
    new Request("https://service.test/")
  ])

  expect(returned).toBe(response)
  expect(receiver).toBe(app)
  expect(response.body).toBe(stream)

  const failure = new Error("hono failure")
  Object.defineProperty(app, "fetch", {
    configurable: true,
    value: function failingFetch(): never {
      throw failure
    }
  })
  const failing: unknown = Reflect.apply(factory, undefined, [app])
  expect(typeof failing).toBe("function")
  if (typeof failing !== "function") return
  expect(() => Reflect.apply(failing, undefined, [new Request("https://service.test/")])).toThrow(
    failure
  )
})

test("delegates to a real Hono route without exposing router helpers", async () => {
  const factory = Reflect.get(HonoBridge, "newHonoHandler")
  expect(typeof factory).toBe("function")
  if (typeof factory !== "function") return
  const app = new Hono().get("/users/:id", (context) =>
    context.json({
      framework: "hono",
      id: context.req.param("id")
    })
  )

  const handler: unknown = Reflect.apply(factory, undefined, [app])
  expect(typeof handler).toBe("function")
  if (typeof handler !== "function") return
  const response: unknown = await Reflect.apply(handler, undefined, [
    new Request("https://service.test/users/42")
  ])

  expect(response).toBeInstanceOf(Response)
  if (!(response instanceof Response)) return
  expect(await response.json()).toEqual({ framework: "hono", id: "42" })
  expect(HonoBridge).not.toHaveProperty("get")
  expect(HonoBridge).not.toHaveProperty("use")
})
