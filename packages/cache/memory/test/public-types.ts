import { expiresIn, type Cache } from "@likego/cache"
import { background } from "@likego/context"

import {
  clock,
  newMemoryCache,
  type MemoryCache,
  type MemoryCacheClock,
  type MemoryCacheOption,
  type MemoryCacheOptions
} from "../src/index"

const now: MemoryCacheClock = () => 1
const option: MemoryCacheOption = clock(now)
const options: MemoryCacheOptions = { clock: now }
const memory: MemoryCache = newMemoryCache(option)
const cache: Cache = memory
const value = memory.get(background(), "key")
const put = memory.put(background(), "key", new Uint8Array([1]), expiresIn(1))
const deleted = memory.delete(background(), "key")
const kind: "memory" = memory.string()

void [cache, deleted, kind, options, put, value]

// @ts-expect-error Memory Cache construction accepts functional options only.
newMemoryCache({ clock: now })
// @ts-expect-error Memory Cache values are bytes.
memory.put(background(), "key", "value")
