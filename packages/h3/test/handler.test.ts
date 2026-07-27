import { expect, test } from "bun:test"
import { createApp, createRouter, defineEventHandler, getRouterParam } from "h3"

import * as H3Bridge from "../src/index"

test("converts a native H3 app into a standard Web handler", async () => {
  const factory = Reflect.get(H3Bridge, "newH3Handler")
  expect(typeof factory).toBe("function")
  if (typeof factory !== "function") return

  const app = createApp()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("h3"))
      controller.close()
    }
  })
  app.use(defineEventHandler(() => new Response(stream, { status: 201 })))

  const handler: unknown = Reflect.apply(factory, undefined, [app])
  expect(typeof handler).toBe("function")
  if (typeof handler !== "function") return
  const returned: unknown = await Reflect.apply(handler, undefined, [
    new Request("https://service.test/")
  ])

  expect(returned).toBeInstanceOf(Response)
  if (!(returned instanceof Response)) return
  expect(returned.status).toBe(201)
  expect(await returned.text()).toBe("h3")
})

test("delegates to a real H3 route without exposing router helpers", async () => {
  const factory = Reflect.get(H3Bridge, "newH3Handler")
  expect(typeof factory).toBe("function")
  if (typeof factory !== "function") return
  const router = createRouter().get(
    "/users/:id",
    defineEventHandler((event) => ({ framework: "h3", id: getRouterParam(event, "id") }))
  )
  const app = createApp().use(router.handler)

  const handler: unknown = Reflect.apply(factory, undefined, [app])
  expect(typeof handler).toBe("function")
  if (typeof handler !== "function") return
  const response: unknown = await Reflect.apply(handler, undefined, [
    new Request("https://service.test/users/42")
  ])

  expect(response).toBeInstanceOf(Response)
  if (!(response instanceof Response)) return
  expect(await response.json()).toEqual({ framework: "h3", id: "42" })
  expect(H3Bridge).not.toHaveProperty("get")
  expect(H3Bridge).not.toHaveProperty("use")
})
