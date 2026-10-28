import { expect, test } from "bun:test"

import * as publicApi from "../src/index"

test("exports native Winston lifecycle and request logging adapters", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "logBroker",
    "logClient",
    "logUnaryMiddleware",
    "logWebHandler",
    "newWinstonServer"
  ])
})

test("rejects an invalid native logger synchronously", () => {
  expect(() => publicApi.newWinstonServer(undefined as never)).toThrow(TypeError)
  expect(() => publicApi.newWinstonServer({ end(): void {} } as never)).toThrow(TypeError)
})
