import assert from "node:assert/strict"

import { background } from "@likego/context"
import { newConfig, objectSource, placeholderResolver, resolver, source } from "@likego/config"

const config = newConfig(
  source(objectSource("one", { host: "service", endpoint: "https://${host}" })),
  resolver(placeholderResolver())
)
await config.load(background())
assert.deepEqual(Object.keys(await import("@likego/config")).sort(), [
  "newConfig",
  "objectSource",
  "onReloadError",
  "onTerminalError",
  "placeholderResolver",
  "resolver",
  "schema",
  "source"
])
assert.equal(config.value("endpoint").load(), "https://service")
await config.close(background())
