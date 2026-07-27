import { expect, test } from "bun:test"

import * as Client from "../src/index"

test("package resolves its public root from source during workspace development", async () => {
  const packageJson = await Bun.file(`${import.meta.dir}/../package.json`).json()

  expect(packageJson).toMatchObject({
    name: "@likego/client",
    module: "src/index.ts",
    typings: "src/index.ts",
    exports: { ".": "./src/index.ts" }
  })
  expect(packageJson.dependencies).toMatchObject({
    "@likego/core": "0.0.1",
    "@likego/resilience": "0.0.1"
  })
})

test("exports exactly the reviewed client runtime surface", () => {
  expect(Object.keys(Client).sort()).toEqual([
    "circuitBreakerMiddleware",
    "closeTimeout",
    "middleware",
    "newClient",
    "poolSize",
    "poolTtl",
    "use",
    "withAddress",
    "withBlock",
    "withDiscovery",
    "withFilter",
    "withRetry",
    "withSelector",
    "withTransport"
  ])
})
