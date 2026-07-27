import { expect, test } from "bun:test"
import { newNodeServer } from "@likego/web/node"

import { newHandler } from "../src/app"

test("binds Hono through the published LikeGo framework bridge", async () => {
  const response = await newHandler()(new Request("https://example.test/users/42"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ framework: "hono", id: "42" })
})

test("composes Hono into the managed Node host", () => {
  expect(typeof newNodeServer(newHandler()).start).toBe("function")
})
