import assert from "node:assert/strict"
import test from "node:test"

import { background } from "@likego/context"
import { newConfig, source, objectSource } from "@likego/config"

test("built package exports config factories", async () => {
  const config = newConfig(source(objectSource("one", { value: 1 })))
  await config.load(background())
  assert.equal(config.value("value").load(), 1)
  await config.close(background())
})
