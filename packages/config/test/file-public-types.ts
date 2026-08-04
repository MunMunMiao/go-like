import { background, type Context } from "@go-like/context"
import type { ConfigSource } from "@go-like/config"

import * as FileConfig from "../src/file"
import {
  fileSource,
  type FileCapability,
  type FileSourceOptions,
  type FileWatcher
} from "../src/file"

const capability: FileCapability = {
  /** Proves that capability I/O receives Context first. */
  read(ctx: Context, path: string) {
    const inputs: readonly [Context, string] = [ctx, path]
    void inputs
    return Promise.resolve({ text: "{}", revision: null })
  }
}
const options: FileSourceOptions = { name: "typed" }
const source: ConfigSource = fileSource(capability, "config.json", options)
const loaded = source.load(background())
void loaded

const watcher: FileWatcher = {
  stop(_ctx: Context): Promise<void> {
    return Promise.resolve()
  },
  done(): Promise<void> {
    return Promise.resolve()
  }
}
void watcher

// @ts-expect-error A filesystem capability is required explicitly.
fileSource("config.json")
// @ts-expect-error File read requires Context as its independent first argument.
capability.read("config.json")
// @ts-expect-error The package has no PascalCase factory alias.
FileConfig.FileSource
