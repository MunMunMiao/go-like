/// <reference lib="es2024.promise" />

import {
  mkdir as nativeMkdir,
  open as nativeOpen,
  readFile as nativeReadFile,
  rename as nativeRename,
  unlink as nativeUnlink
} from "node:fs/promises"
import { join } from "node:path"

import { cause, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"

import { newFileStoreLockedError, newFileStoreStateError } from "./store"
import type { FileStoreDirectory, FileStoreHost, FileStoreState } from "./types"

/** Describes the exact native file operations retained by the Node host. */
export interface NodeFileStoreFile {
  writeFile(bytes: Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** Supplies the narrow Node filesystem boundary used by deterministic host tests. */
export interface NodeFileStoreIO {
  mkdir(path: string): Promise<void>
  open(path: string, flags: "w" | "wx", mode: number): Promise<NodeFileStoreFile>
  readFile(path: string): Promise<Uint8Array>
  rename(source: string, target: string): Promise<void>
  unlink(path: string): Promise<void>
}

const LockName = ".likego-store.lock"
const DefaultIO: NodeFileStoreIO = Object.freeze({
  /** Creates one real Node directory tree. */
  async mkdir(path: string): Promise<void> {
    await nativeMkdir(path, { recursive: true })
  },
  /** Opens one real Node file with the exact provider-owned flags and mode. */
  async open(path: string, flags: "w" | "wx", mode: number): Promise<NodeFileStoreFile> {
    return await nativeOpen(path, flags, mode)
  },
  /** Reads one complete real Node file. */
  async readFile(path: string): Promise<Uint8Array> {
    return await nativeReadFile(path)
  },
  /** Atomically renames one real Node file. */
  async rename(source: string, target: string): Promise<void> {
    await nativeRename(source, target)
  },
  /** Removes one real Node file. */
  async unlink(path: string): Promise<void> {
    await nativeUnlink(path)
  }
})

/** Marks one public terminal rejection as observed without replacing its identity. */
function observe(operation: Promise<unknown>): void {
  void operation.catch(
    /** Retains the original failure for the owner-facing Promise. */
    function observed(): void {}
  )
}

/** Reports whether one unknown value is structurally inspectable. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Reports whether one native filesystem failure has the selected stable code. */
function hasCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

/** Converts one untrusted native rejection without exposing it through string coercion. */
function normalizeError(value: unknown, message: string): Error {
  return value instanceof Error ? value : Object.freeze(new Error(message))
}

/** Returns one primary failure or one ordered immutable cleanup aggregate. */
function combinedFailure(
  primary: Error | null,
  cleanup: readonly Error[],
  message: string
): Error | null {
  const failures: Error[] = []
  if (primary !== null) failures.push(primary)
  for (const failure of cleanup) {
    if (!failures.includes(failure)) failures.push(failure)
  }
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  return Object.freeze(new AggregateError(Object.freeze(failures), message))
}

/** Throws one Context's exact admitted cancellation cause. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw cause(ctx) ?? failure
}

/** Validates one direct Node host directory without normalizing it. */
function directoryName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("Node File Store directory is invalid")
  }
  return value
}

/** Admits only provider-owned leaf names, never caller keys or path fragments. */
function providerFileName(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError("Node File Store file name is invalid")
  }
  return value
}

/** Releases one provisional lock while preserving exclusive ownership on close failure. */
async function releaseProvisional(
  io: NodeFileStoreIO,
  lock: NodeFileStoreFile,
  lockPath: string,
  primary: Error
): Promise<never> {
  const cleanup: Error[] = []
  let closed = false
  try {
    await lock.close()
    closed = true
  } catch (value) {
    cleanup.push(normalizeError(value, "Node File Store provisional lock close failed"))
  }
  if (closed) {
    try {
      await io.unlink(lockPath)
    } catch (value) {
      if (!hasCode(value, "ENOENT")) {
        cleanup.push(normalizeError(value, "Node File Store provisional lock removal failed"))
      }
    }
  }
  throw combinedFailure(primary, cleanup, "Node File Store lock rollback failed") ?? primary
}

/** Creates one exclusively owned real-filesystem directory handle. */
function directoryHandle(
  io: NodeFileStoreIO,
  directory: string,
  lock: NodeFileStoreFile,
  lockPath: string
): FileStoreDirectory {
  let state: FileStoreState = "running"
  let operationTail = Promise.resolve()
  let shutdown: Promise<void> | null = null

  /** Resolves the provider-owned path for one validated internal leaf name. */
  function filePath(name: string): string {
    return join(directory, providerFileName(name))
  }

  /** Queues one filesystem operation behind every previously admitted operation. */
  function operate<T>(ctx: Context, operation: string, run: () => Promise<T>): Promise<T> {
    if (state !== "running") return Promise.reject(newFileStoreStateError(operation, state))
    const task = operationTail.then(async () => {
      checkContext(ctx)
      return await run()
    })
    operationTail = task.then(
      /** Releases the queue after successful filesystem settlement. */
      function operationSucceeded(): void {},
      /** Releases the queue after failed filesystem settlement. */
      function operationFailed(): void {}
    )
    return waitForContext(ctx, task)
  }

  /** Closes the lock descriptor, removes its marker, and settles terminal ownership. */
  function startShutdown(): Promise<void> {
    if (shutdown !== null) return shutdown
    state = "stopping"

    /** Drains operations before releasing the directory lock exactly once. */
    async function drain(): Promise<void> {
      await operationTail
      const cleanup: Error[] = []
      let closed = false
      try {
        await lock.close()
        closed = true
      } catch (value) {
        cleanup.push(normalizeError(value, "Node File Store lock close failed"))
      }
      if (closed) {
        try {
          await io.unlink(lockPath)
        } catch (value) {
          if (!hasCode(value, "ENOENT")) {
            cleanup.push(normalizeError(value, "Node File Store lock removal failed"))
          }
        }
      }
      const failure = combinedFailure(null, cleanup, "Node File Store lifecycle failed")
      if (failure === null) {
        state = "stopped"
        return
      }
      state = "failed"
      throw failure
    }

    shutdown = drain()
    observe(shutdown)
    return shutdown
  }

  const handle: FileStoreDirectory = {
    close(ctx): Promise<void> {
      return waitForContext(ctx, startShutdown())
    },
    read(ctx, name): Promise<Uint8Array | null> {
      const path = filePath(name)
      return operate(ctx, "file-read", async () => {
        try {
          const bytes = await io.readFile(path)
          checkContext(ctx)
          return new Uint8Array(bytes)
        } catch (value) {
          if (hasCode(value, "ENOENT")) return null
          throw value
        }
      })
    },
    write(ctx, name, value): Promise<void> {
      const path = filePath(name)
      if (!(value instanceof Uint8Array)) {
        return Promise.reject(new TypeError("Node File Store bytes must be a Uint8Array"))
      }
      const bytes = new Uint8Array(value)
      return operate(ctx, "file-write", async () => {
        let file: NodeFileStoreFile | null = null
        let primary: Error | null = null
        const cleanup: Error[] = []
        try {
          file = await io.open(path, "w", 0o600)
          await file.writeFile(bytes)
          await file.sync()
          checkContext(ctx)
        } catch (value) {
          primary = normalizeError(value, "Node File Store write failed")
        }
        if (file !== null) {
          try {
            await file.close()
          } catch (value) {
            cleanup.push(normalizeError(value, "Node File Store file close failed"))
          }
        }
        const failure = combinedFailure(primary, cleanup, "Node File Store write lifecycle failed")
        if (failure !== null) throw failure
      })
    },
    rename(ctx, source, target): Promise<void> {
      const sourcePath = filePath(source)
      const targetPath = filePath(target)
      return operate(ctx, "file-rename", async () => {
        checkContext(ctx)
        await io.rename(sourcePath, targetPath)
      })
    },
    remove(ctx, name): Promise<boolean> {
      const path = filePath(name)
      return operate(ctx, "file-remove", async () => {
        checkContext(ctx)
        try {
          await io.unlink(path)
          return true
        } catch (value) {
          if (hasCode(value, "ENOENT")) return false
          throw value
        }
      })
    }
  }
  return Object.freeze(handle)
}

/** Creates a Node.js filesystem capability without touching the filesystem. */
export function newNodeFileStoreHost(): FileStoreHost {
  return newNodeFileStoreHostWithIO(DefaultIO)
}

/** Creates a Node.js filesystem host from one captured narrow I/O boundary. */
export function newNodeFileStoreHostWithIO(io: NodeFileStoreIO): FileStoreHost {
  const host: FileStoreHost = {
    async acquire(ctx, value): Promise<FileStoreDirectory> {
      const directory = directoryName(value)
      checkContext(ctx)
      await io.mkdir(directory)
      checkContext(ctx)
      const lockPath = join(directory, LockName)
      let lock: NodeFileStoreFile
      try {
        lock = await io.open(lockPath, "wx", 0o600)
      } catch (value) {
        if (hasCode(value, "EEXIST")) throw newFileStoreLockedError()
        throw value
      }
      try {
        checkContext(ctx)
        return directoryHandle(io, directory, lock, lockPath)
      } catch (value) {
        return await releaseProvisional(
          io,
          lock,
          lockPath,
          normalizeError(value, "Node File Store acquire failed")
        )
      }
    }
  }
  return Object.freeze(host)
}
