import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runFrameworkDistConsumerMain } from "../../../../e2e/harness/framework-stage"

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "../../../..")

await runFrameworkDistConsumerMain({
  root,
  prefix: "likego-web-bridge-",
  consumer: resolve(directory, "fixtures/bridge-dist-consumer.mjs"),
  builtPackages: ["@likego/context", "@likego/core", "@likego/web"],
  vendorPackages: [
    {
      name: "@hono/node-server",
      source: resolve(root, "packages/web/node_modules/@hono/node-server")
    }
  ],
  requiredRuntimePeers: {
    "@hono/node-server": ["hono"]
  }
})
