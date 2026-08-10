import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runFrameworkDistConsumerMain } from "../../../../e2e/harness/framework-stage"

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "../../../..")

await runFrameworkDistConsumerMain({
  root,
  prefix: "go-like-web-bridge-",
  consumer: resolve(directory, "fixtures/bridge-dist-consumer.mjs"),
  builtPackages: ["@go-like/context", "@go-like/core", "@go-like/web"],
  vendorPackages: []
})
