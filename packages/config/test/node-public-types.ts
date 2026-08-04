import { background, type Context } from "@go-like/context"

import type { FileCapability, FileReadResult } from "../src/file"
import * as NodeConfig from "../src/node"
import { newNodeFileCapability } from "../src/node"

const capability: FileCapability = newNodeFileCapability()
const loaded: Promise<FileReadResult> = capability.read(background(), "config.json")
void loaded

/** Proves the public read operation retains Context as its independent first argument. */
function read(ctx: Context, path: string): Promise<FileReadResult> {
  return capability.read(ctx, path)
}
void read

// @ts-expect-error Node file reads require Context as their first argument.
capability.read("config.json")
// @ts-expect-error The package has no Go-style PascalCase constructor alias.
NodeConfig.NewNodeFileCapability
