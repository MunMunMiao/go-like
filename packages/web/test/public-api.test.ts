import { expect, test } from "bun:test"

import * as WebPackage from "../src/index"

test("exports exactly contextHandler at runtime", () => {
  expect(Object.keys(WebPackage)).toEqual(["contextHandler"])
  expect(typeof Reflect.get(WebPackage, "contextHandler")).toBe("function")
  expect(WebPackage).not.toHaveProperty("Handler")
  expect(WebPackage).not.toHaveProperty("ContextHandler")
  expect(WebPackage).not.toHaveProperty("ContextHandlerOptions")
  expect(WebPackage).not.toHaveProperty("FetchHandler")
  expect(WebPackage).not.toHaveProperty("toFetchHandler")
})

test("creates a one-parameter Handler", () => {
  const factory = Reflect.get(WebPackage, "contextHandler")
  expect(typeof factory).toBe("function")
  if (typeof factory !== "function") return
  const handler: unknown = Reflect.apply(factory, undefined, [() => new Response("ok")])

  expect(typeof handler).toBe("function")
  if (typeof handler !== "function") return
  expect(handler.length).toBe(1)
})
