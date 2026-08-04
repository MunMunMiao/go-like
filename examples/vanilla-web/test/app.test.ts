import { expect, test } from "bun:test"
import { newNodeServer } from "@go-like/web/node"

import { newHandler } from "../src/app"

test("passes a standard handler through the framework-neutral Fetch ABI", async () => {
  const response = await newHandler()(
    new Request("https://example.test/orders", { method: "POST" })
  )

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ method: "POST", path: "/orders" })
})

test("composes the same handler into a structural server", () => {
  expect(typeof newNodeServer(newHandler()).start).toBe("function")
})
