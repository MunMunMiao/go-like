import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runFrameworkDistConsumerMain } from "../../../../e2e/harness/framework-stage"

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "../../../..")

await runFrameworkDistConsumerMain({
  root,
  prefix: "likego-hono-bridge-",
  consumer: resolve(directory, "fixtures/bridge-dist-consumer.mjs"),
  builtPackages: ["@likego/hono"],
  vendorPackages: [
    {
      name: "hono",
      source: resolve(root, "packages/hono/node_modules/hono")
    }
  ]
})
