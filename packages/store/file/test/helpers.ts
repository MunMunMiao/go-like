import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { background } from "@go-like/context"
import type { FileStore } from "../src/index"

export interface StartedStore {
  readonly store: FileStore
  readonly running: Promise<void>
}

/** Runs one test against a real isolated filesystem directory and always removes it. */
export async function withTempDirectory(
  run: (directory: string) => PromiseLike<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "go-like-store-file-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Starts one Store without joining its resident lifetime. */
export async function startStore(store: FileStore): Promise<StartedStore> {
  const running = store.start(background())
  void running.catch(() => {})
  for (;;) {
    try {
      await store.read(background(), "__go-like_test_readiness__")
      return Object.freeze({ store, running })
    } catch (value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        value.code === "GO_LIKE_FILE_STORE_STATE" &&
        "state" in value
      ) {
        if (value.state === "starting") {
          await Bun.sleep(1)
          continue
        }
        if (value.state === "failed") await running
      }
      throw value
    }
  }
}

/** Stops one Store and joins its resident start operation. */
export async function stopStore(started: StartedStore): Promise<void> {
  await started.store.stop(background())
  await started.running
}

/** Waits at least the requested number of milliseconds. */
export function delay(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
}
