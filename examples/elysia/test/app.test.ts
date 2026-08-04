import { expect, test } from "bun:test"
import { newNodeServer } from "@go-like/web/node"

import { newHandler } from "../src/app"

test("serves Elysia through its native Fetch handler", async () => {
  const response = await newHandler()(new Request("https://example.test/users/42"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ framework: "elysia", id: "42" })
})

test("composes Elysia into the managed Node host", () => {
  expect(typeof newNodeServer(newHandler()).start).toBe("function")
})
