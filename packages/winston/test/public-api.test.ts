import { expect, test } from "bun:test"

import * as publicApi from "@go-like/winston/log"

test("exports the Winston log handler", () => {
  expect(Object.keys(publicApi).sort()).toEqual(["newWinstonHandler"])
})

test("rejects an invalid native logger synchronously", () => {
  expect(() => publicApi.newWinstonHandler(undefined as never)).toThrow(TypeError)
  expect(() => publicApi.newWinstonHandler({ end(): void {} } as never)).toThrow(TypeError)
})
