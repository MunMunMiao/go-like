import { background } from "@likego/context"

import { expiresIn, type Cache, type PutOption, type PutOptions } from "../src/index"
import { putOptions } from "../src/provider"
const option: PutOption = expiresIn(1)
const options: PutOptions = putOptions([option])
const cache: Cache = {
  async get(_ctx, _key) {
    return null
  },
  async put(_ctx, _key, _value, ..._options) {},
  async delete(_ctx, _key) {
    return Promise.resolve()
  },
  string() {
    return "typed"
  }
}
void [background(), options]

// @ts-expect-error Cache operations require a Context first.
cache.get("key")
// @ts-expect-error Cache values are bytes.
cache.put(background(), "key", "value")
// @ts-expect-error TTL accepts numbers, not strings.
expiresIn("1")
