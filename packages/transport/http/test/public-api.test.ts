import { expect, test } from "bun:test"

import * as HTTPPackage from "../src/index"
import * as HTTPNode from "../src/node"
test("root exports exactly the portable HTTP runtime factories", () => {
  expect(Object.keys(HTTPPackage)).toEqual(["executor", "maxMessageBytes", "newHTTPTransport"])
  expect(typeof HTTPPackage.executor).toBe("function")
  expect(typeof HTTPPackage.maxMessageBytes).toBe("function")
  expect(typeof HTTPPackage.newHTTPTransport).toBe("function")
})

test("node exports only runtime-backed Transport construction functions", () => {
  expect(Object.keys(HTTPNode)).toEqual(["allowHTTP1", "clientAuth", "newNodeHTTPTransport"])
  expect(typeof HTTPNode.allowHTTP1).toBe("function")
  expect(typeof HTTPNode.clientAuth).toBe("function")
  expect(typeof HTTPNode.newNodeHTTPTransport).toBe("function")
})
