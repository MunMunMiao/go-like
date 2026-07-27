import { expect, test } from "bun:test"

import * as Server from "../src/index"

test("exports exactly the go-style internal server runtime surface", () => {
  expect(Object.keys(Server)).toEqual([
    "address",
    "advertise",
    "handler",
    "listenOption",
    "middleware",
    "newServer",
    "rateLimitMiddleware",
    "transport",
    "use"
  ])
  expect(Server).not.toHaveProperty("registeredUnaryService")
  expect(Server).not.toHaveProperty("registeredFetchService")
  expect(Server).not.toHaveProperty("composeUnary")
})
