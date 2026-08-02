import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runFrameworkDistConsumerMain } from "../../../../e2e/harness/framework-stage"

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "../../../..")

await runFrameworkDistConsumerMain({
  root,
  prefix: "likego-elysia-bridge-",
  consumer: resolve(directory, "fixtures/bridge-dist-consumer.mjs"),
  builtPackages: ["@likego/elysia"],
  vendorPackages: [
    {
      name: "elysia",
      source: resolve(root, "packages/elysia/node_modules/elysia")
    }
  ],
  requiredRuntimePeers: {
    elysia: ["@sinclair/typebox"]
  }
})
