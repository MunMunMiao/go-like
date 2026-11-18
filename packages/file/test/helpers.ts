import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { background } from "@go-like/core/context"
import type { FileStore } from "../src/store/index"

export interface StartedStore {
  readonly store: FileStore
  readonly running: Promise<void>
}

/** Runs one test against a real isolated filesystem directory and always removes it. */
export async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "go-like-store-file-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Starts one Store. `start` resolves when the directory lock and snapshot are admitted. */
export async function startStore(store: FileStore): Promise<StartedStore> {
  const running = store.start(background())
  await running
  return Object.freeze({ store, running })
}

/** Stops one admitted Store. */
export async function stopStore(started: StartedStore): Promise<void> {
  await started.store.stop(background())
  await started.running
}

/** Waits at least the requested number of milliseconds. */
export function delay(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
}
