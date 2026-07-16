import { randomBytes } from "node:crypto"
import { lstat, open, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export interface AtomicFileHandle {
  readonly Write: (value: string) => Promise<void>
  readonly Sync: () => Promise<void>
  readonly Close: () => Promise<void>
}

export interface AtomicWriterOperations {
  readonly Pid: number
  readonly RandomSuffix: () => string
  readonly MakeDirectory: (path: string, identity: AtomicDirectoryIdentity) => Promise<void>
  readonly Open: (path: string, identity: AtomicDirectoryIdentity) => Promise<AtomicFileHandle>
  readonly Rename: (from: string, to: string, identity: AtomicDirectoryIdentity) => Promise<void>
  readonly Remove: (path: string, identity: AtomicDirectoryIdentity) => Promise<void>
}

export interface AtomicDirectoryIdentity {
  readonly Path: string
  readonly RealPath: string
  readonly Device: number
  readonly Inode: number
}

export interface AtomicWriteIdentity {
  readonly Gate: string
  readonly RunId: string
  readonly Directory: AtomicDirectoryIdentity
}

function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function PathError(message: string): Error {
  return new Error(`GATE_RESULT_PATH_ERROR ${message}`)
}

async function VerifyDirectoryIdentity(
  path: string,
  expected: AtomicDirectoryIdentity
): Promise<void> {
  try {
    if (path !== expected.Path) {
      throw new Error("atomic result directory path changed")
    }
    const lexicalInformation = await lstat(path)
    if (lexicalInformation.isSymbolicLink() || !lexicalInformation.isDirectory()) {
      throw new Error("atomic result directory must be a real directory")
    }
    const currentRealPath = await realpath(path)
    const information = await stat(path)
    if (
      !information.isDirectory()
      || currentRealPath !== expected.RealPath
      || information.dev !== expected.Device
      || information.ino !== expected.Inode
    ) {
      throw new Error("atomic result directory identity changed")
    }
  } catch (error) {
    throw PathError(ErrorMessage(error))
  }
}

function AssertChildPath(path: string, expected: AtomicDirectoryIdentity): void {
  if (dirname(path) !== expected.Path) {
    throw PathError("atomic result path escaped the prepared directory")
  }
}

export function NodeAtomicWriterOperations(): AtomicWriterOperations {
  return {
    Pid: process.pid,
    RandomSuffix: () => randomBytes(12).toString("hex"),
    MakeDirectory: async (path, identity) => {
      await VerifyDirectoryIdentity(path, identity)
    },
    Open: async (path, identity) => {
      AssertChildPath(path, identity)
      await VerifyDirectoryIdentity(identity.Path, identity)
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
    Rename: async (from, to, identity) => {
      AssertChildPath(from, identity)
      AssertChildPath(to, identity)
      await VerifyDirectoryIdentity(identity.Path, identity)
      await rename(from, to)
    },
    Remove: async (path, identity) => {
      AssertChildPath(path, identity)
      await VerifyDirectoryIdentity(identity.Path, identity)
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
  await operations.MakeDirectory(directory, identity.Directory)
  const tempPath = join(
    directory,
    `${basename(canonicalPath)}.${identity.Gate}.${identity.RunId}.${operations.Pid}.${operations.RandomSuffix()}.tmp`
  )
  let handle: AtomicFileHandle | null = null
  let ownedTemp = false
  let closed = false
  let renamed = false
  let primaryError: unknown = null

  try {
    handle = await operations.Open(tempPath, identity.Directory)
    ownedTemp = true
    await handle.Write(contents)
    await handle.Sync()
    await handle.Close()
    closed = true
    await operations.Rename(tempPath, canonicalPath, identity.Directory)
    renamed = true
    await VerifyDirectoryIdentity(directory, identity.Directory)
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
    if (ownedTemp && !renamed) {
      try {
        await operations.Remove(tempPath, identity.Directory)
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
