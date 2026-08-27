import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { background } from "@go-like/context"
import { newFileStore, type FileStore } from "@go-like/store-file"
import { newNodeFileStoreHost } from "@go-like/store-file/node"

const SnapshotName = ".go-like-store.snapshot"
const TempName = ".go-like-store.tmp"
const LockName = ".go-like-store.lock"

/** Fails the real-filesystem gate unless one condition is true. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Reports whether one exact filesystem path currently exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

interface StartedStore {
  readonly store: FileStore
  readonly running: Promise<void>
}

/** Starts one Store without joining its resident lifetime. */
async function startStore(store: FileStore): Promise<StartedStore> {
  const running = store.start(background())
  void running.catch(() => {})
  for (;;) {
    try {
      await store.read(background(), "__go-like_e2e_readiness__")
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

/** Stops one admitted Store and joins its resident start operation. */
async function stopStore(started: StartedStore): Promise<void> {
  await started.store.stop(background())
  await started.running
}

/** Runs the owner process that is deliberately killed with an uncommitted temp residue. */
async function child(directory: string): Promise<never> {
  const store = newFileStore(newNodeFileStoreHost(), directory)
  await startStore(store)
  await writeFile(join(directory, TempName), "incomplete crash residue")
  console.log("GO_LIKE_STORE_FILE_CHILD_READY")
  return await new Promise<never>(function resident(): void {})
}

/** Waits for one child readiness line without depending on timing sleeps. */
async function waitForChild(process: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!(process.stdout instanceof ReadableStream)) throw new Error("child stdout is unavailable")
  const reader = process.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("GO_LIKE_STORE_FILE_CHILD_READY")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("File Store child exited before readiness")
    text += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
}

/** Reads one error's stable code without invoking accessors or stringifying secret data. */
function errorCode(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, "code")?.value
}

/** Executes process-crash, stale-lock, temp-residue, checksum, and recovery evidence. */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "go-like-store-file-process-"))
  let childProcess: ReturnType<typeof Bun.spawn> | null = null
  try {
    const initial = newFileStore(newNodeFileStoreHost(), directory)
    const initialStarted = await startStore(initial)
    const record = await initial.write(background(), {
      key: "last-success",
      value: new TextEncoder().encode("stable")
    })
    await stopStore(initialStarted)

    childProcess = Bun.spawn([process.execPath, import.meta.path, "--child", directory], {
      stdout: "pipe",
      stderr: "pipe"
    })
    await waitForChild(childProcess)
    childProcess.kill(9)
    const childExitCode = await childProcess.exited
    childProcess = null
    ensure(childExitCode !== 0, "the crash fixture child was not force-terminated")
    ensure(await exists(join(directory, LockName)), "the killed owner did not leave its lock")
    ensure(await exists(join(directory, TempName)), "the killed owner did not leave its temp")

    const locked = newFileStore(newNodeFileStoreHost(), directory)
    const lockedFailure = await locked.start(background()).catch(function rejected(value: unknown) {
      return value
    })
    ensure(
      errorCode(lockedFailure) === "GO_LIKE_FILE_STORE_LOCKED",
      "a stale crash lock was not rejected fail closed"
    )

    await unlink(join(directory, LockName))
    const recovered = newFileStore(newNodeFileStoreHost(), directory)
    const recoveredStarted = await startStore(recovered)
    const recoveredRecord = await recovered.read(background(), "last-success")
    ensure(
      recoveredRecord?.revision === record.revision,
      "the last complete snapshot was not restored"
    )
    ensure(
      new TextDecoder().decode(recoveredRecord.value) === "stable",
      "the crash temp replaced the last complete snapshot"
    )
    await stopStore(recoveredStarted)
    ensure(
      !(await exists(join(directory, TempName))),
      "graceful recovery did not remove stale temp"
    )

    const snapshotPath = join(directory, SnapshotName)
    const validSnapshot = await readFile(snapshotPath)
    await writeFile(snapshotPath, '{"schemaVersion":1,"revision":1,"records":[],"checksum":"bad"}')
    const corrupted = newFileStore(newNodeFileStoreHost(), directory)
    const corruption = await corrupted.start(background()).catch(function rejected(value: unknown) {
      return value
    })
    ensure(
      errorCode(corruption) === "GO_LIKE_FILE_STORE_CORRUPTION",
      "checksum corruption did not fail closed"
    )

    await writeFile(snapshotPath, validSnapshot)
    const restored = newFileStore(newNodeFileStoreHost(), directory)
    const restoredStarted = await startStore(restored)
    ensure(
      (await restored.read(background(), "last-success"))?.revision === record.revision,
      "restoring the valid snapshot did not recover the record"
    )
    await stopStore(restoredStarted)

    await rm(directory, { recursive: true, force: true })
    ensure(!(await exists(directory)), "file store directory remained after cleanup")
  } finally {
    if (childProcess !== null) {
      childProcess.kill(9)
      await childProcess.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[2] === "--child") {
  const directory = process.argv[3]
  if (directory === undefined) throw new Error("File Store child directory is missing")
  await child(directory)
} else {
  await main()
}
