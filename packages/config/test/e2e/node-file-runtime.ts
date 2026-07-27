import assert from "node:assert/strict"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { background, withTimeout } from "@likego/context"
import { fileSource } from "@likego/config/file"
import { newNodeFileCapability } from "@likego/config/node"

async function nextWithin(watcher) {
  const [ctx, cancel] = withTimeout(background(), 2_000)
  try {
    await watcher.next(ctx)
  } finally {
    cancel()
  }
}

async function stop(watcher) {
  if (watcher === null) return
  await watcher.stop(background())
}

async function notifyWith(watcher, write) {
  const changed = nextWithin(watcher)
  let value = 0
  for (; value < 20; value += 1) {
    await write(value)
    if (
      await Promise.race([
        changed.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 10))
      ])
    )
      break
  }
  await changed
  return value
}

const directory = await mkdtemp(join(tmpdir(), "likego-config-node-runtime-"))
const path = join(directory, "config.json")
const replacement = join(directory, ".config.next")
let watcher = null
try {
  await writeFile(path, '{"generation":1}')
  const source = fileSource(newNodeFileCapability(), path)
  const initial = await source.load(background())
  watcher = await source.watch?.(background(), initial.revision)
  if (watcher === undefined) throw new Error("Node config runtime watcher is missing")

  const ordinaryGeneration =
    2 +
    (await notifyWith(watcher, async (attempt) => {
      await writeFile(path, `{"generation":${2 + attempt}}`)
    }))
  const ordinary = await source.load(background())
  assert.deepEqual(ordinary.value, { generation: ordinaryGeneration })
  assert.notEqual(ordinary.revision, initial.revision)
  await stop(watcher)
  watcher = null

  watcher = await source.watch?.(background(), ordinary.revision)
  if (watcher === undefined) throw new Error("Node config replacement watcher is missing")

  const changedGeneration =
    ordinaryGeneration +
    1 +
    (await notifyWith(watcher, async (attempt) => {
      await writeFile(replacement, `{"generation":${ordinaryGeneration + 1 + attempt}}`)
      await rename(replacement, path)
    }))
  const changed = await source.load(background())
  assert.deepEqual(changed.value, { generation: changedGeneration })
  assert.notEqual(changed.revision, ordinary.revision)
  await stop(watcher)
  watcher = null
} finally {
  await stop(watcher)
  await rm(directory, { recursive: true, force: true })
}
