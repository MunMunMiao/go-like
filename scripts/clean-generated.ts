import { rm } from "node:fs/promises"
import { join } from "node:path"

import { discoverWorkspaces } from "../tools/workspaces/discovery"

/**
 * Removes transient publish output and compiler state without touching source files or test evidence.
 */
export async function cleanGenerated(root: string): Promise<void> {
  await rm(join(root, "test-build"), { recursive: true, force: true })
  for (const workspace of await discoverWorkspaces(root)) {
    const workspaceRoot = join(root, workspace.root)
    await rm(join(workspaceRoot, "dist"), { recursive: true, force: true })
    await rm(join(workspaceRoot, ".artifacts", "tsconfig.tsbuildinfo"), { force: true })
  }
}
