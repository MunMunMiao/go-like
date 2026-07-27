import { expect, test } from "bun:test"
import { newNodeServer } from "@likego/web/node"

import { newHandler } from "../src/app"

test("binds H3 through the published LikeGo framework bridge", async () => {
  const response = await newHandler()(new Request("https://example.test/status"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ framework: "h3", ok: true })
})

test("composes H3 into the managed Node host", () => {
  expect(typeof newNodeServer(newHandler()).start).toBe("function")
})
