import { expect, test } from "bun:test"
import { Elysia } from "elysia"

import * as ElysiaBridge from "../src/index"

test("binds a native Elysia app while preserving receiver, Response, stream, and Error identity", async () => {
  const factory = Reflect.get(ElysiaBridge, "newElysiaHandler")
  expect(typeof factory).toBe("function")
  if (typeof factory !== "function") return

  const app = new Elysia()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("elysia"))
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

  const failure = new Error("elysia failure")
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

test("delegates to a real Elysia route without exposing router helpers", async () => {
  const factory = Reflect.get(ElysiaBridge, "newElysiaHandler")
  expect(typeof factory).toBe("function")
  if (typeof factory !== "function") return
  const app = new Elysia().get("/users/:id", ({ params }) => ({
    framework: "elysia",
    id: params.id
  }))

  const handler: unknown = Reflect.apply(factory, undefined, [app])
  expect(typeof handler).toBe("function")
  if (typeof handler !== "function") return
  const response: unknown = await Reflect.apply(handler, undefined, [
    new Request("https://localhost/users/42")
  ])

  expect(response).toBeInstanceOf(Response)
  if (!(response instanceof Response)) return
  expect(await response.json()).toEqual({ framework: "elysia", id: "42" })
  expect(ElysiaBridge).not.toHaveProperty("get")
  expect(ElysiaBridge).not.toHaveProperty("use")
})
