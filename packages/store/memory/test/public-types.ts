import { background } from "@likego/context"
import { expiresIn, type Store } from "../../src/index"

import {
  clock,
  newMemoryStore,
  type MemoryStore,
  type MemoryStoreClock,
  type MemoryStoreOption,
  type MemoryStoreOptions
} from "../src/index"

const now: MemoryStoreClock = () => 1
const option: MemoryStoreOption = clock(now)
const options: MemoryStoreOptions = { clock: now }
const memory: MemoryStore = newMemoryStore(option)
const store: Store = memory
const written = memory.write(background(), { key: "key", value: new Uint8Array([1]) }, expiresIn(1))
const kind: "memory" = memory.string()

void [kind, options, store, written]

// @ts-expect-error Memory Store construction accepts functional options only.
newMemoryStore({ clock: now })
// @ts-expect-error Memory Store values are bytes.
memory.write(background(), { key: "key", value: "value" })
