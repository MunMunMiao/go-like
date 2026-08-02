import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runFrameworkDistConsumerMain } from "../../../../e2e/harness/framework-stage"

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "../../../..")

await runFrameworkDistConsumerMain({
  root,
  prefix: "likego-h3-bridge-",
  consumer: resolve(directory, "fixtures/bridge-dist-consumer.mjs"),
  builtPackages: ["@likego/h3"],
  vendorPackages: [
    {
      name: "h3",
      source: resolve(root, "packages/h3/node_modules/h3")
    }
  ]
})
