import { randomBytes } from "node:crypto"
import { lstat, open, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export interface AtomicFileHandle {
  readonly Write: (value: string) => Promise<void>
  readonly Sync: () => Promise<void>
  readonly Close: () => Promise<void>
}

export interface AtomicWriterOperations {
  readonly Pid: number
  readonly RandomSuffix: () => string
  readonly MakeDirectory: (path: string) => Promise<void>
  readonly Open: (path: string) => Promise<AtomicFileHandle>
  readonly Rename: (from: string, to: string) => Promise<void>
  readonly Remove: (path: string) => Promise<void>
}

export interface AtomicWriteIdentity {
  readonly Gate: string
  readonly RunId: string
}

function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function NodeAtomicWriterOperations(): AtomicWriterOperations {
  return {
    Pid: process.pid,
    RandomSuffix: () => randomBytes(12).toString("hex"),
    MakeDirectory: async (path) => {
      const information = await lstat(path)
      if (information.isSymbolicLink() || !information.isDirectory()) {
        throw new Error("GATE_RESULT_PATH_ERROR atomic result directory must be a real directory")
      }
    },
    Open: async (path) => {
      const handle = await open(path, "wx", 0o600)
      return {
        Write: async (value) => {
          await handle.writeFile(value, { encoding: "utf8" })
        },
        Sync: async () => {
          await handle.sync()
        },
        Close: async () => {
          await handle.close()
        }
      }
    },
    Rename: async (from, to) => {
      await rename(from, to)
    },
    Remove: async (path) => {
      await rm(path, { force: true })
    }
  }
}

export async function WriteCanonicalFile(
  canonicalPath: string,
  contents: string,
  identity: AtomicWriteIdentity,
  operations: AtomicWriterOperations
): Promise<void> {
  const directory = dirname(canonicalPath)
  await operations.MakeDirectory(directory)
  const tempPath = join(
    directory,
    `${basename(canonicalPath)}.${identity.Gate}.${identity.RunId}.${operations.Pid}.${operations.RandomSuffix()}.tmp`
  )
  let handle: AtomicFileHandle | null = null
  let closed = false
  let renamed = false
  let primaryError: unknown = null

  try {
    handle = await operations.Open(tempPath)
    await handle.Write(contents)
    await handle.Sync()
    await handle.Close()
    closed = true
    await operations.Rename(tempPath, canonicalPath)
    renamed = true
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors: unknown[] = []
    if (handle !== null && !closed) {
      try {
        await handle.Close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (!renamed) {
      try {
        await operations.Remove(tempPath)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    if (primaryError !== null) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError([primaryError, ...cleanupErrors], ErrorMessage(primaryError))
      }
      throw primaryError
    }
  }
}
