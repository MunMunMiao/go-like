import { expect, test } from "bun:test"

import * as RedisCachePackage from "../src/index"

test("Redis Cache exports only the reviewed lower-camel runtime surface", () => {
  expect(Object.keys(RedisCachePackage).sort()).toEqual([
    "newRedisCache",
    "newRedisCacheOperationError",
    "newRedisCacheProtocolError"
  ])
})
