import { expect, test } from "bun:test"

import * as Server from "../src/index"

test("exports exactly the go-style internal server runtime surface", () => {
  expect(Object.keys(Server)).toEqual([
    "address",
    "advertise",
    "handler",
    "httpRoute",
    "listenOption",
    "middleware",
    "newServer",
    "rateLimitMiddleware",
    "transport",
    "use"
  ])
  expect(typeof Reflect.get(Server, "httpRoute")).toBe("function")
  expect(Server).not.toHaveProperty("registeredUnaryService")
  expect(Server).not.toHaveProperty("registeredFetchService")
  expect(Server).not.toHaveProperty("composeUnary")
})
