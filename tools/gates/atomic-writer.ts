import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export interface AtomicFileHandle {
  readonly Write: (value: string) => Promise<void>
  readonly Sync: () => Promise<void>
  readonly Close: () => Promise<void>
}

export interface AtomicWriterOperations {
  readonly Pid: number
  readonly RandomSuffix: () => string
  readonly LeaseDirectory: (identity: AtomicDirectoryIdentity) => Promise<AtomicDirectoryLease>
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

export interface AtomicDirectoryLease {
  readonly Resolve: () => Promise<AtomicDirectoryIdentity>
  readonly Close: () => Promise<void>
}

interface PriorCanonical {
  readonly Exists: boolean
  readonly Bytes: Uint8Array
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

function IsFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function IsPathError(error: unknown): boolean {
  return ErrorMessage(error).startsWith("GATE_RESULT_PATH_ERROR ")
}

function PlatformDirectoryDescriptorRoot(): string | null {
  return new Map<string, string>([
    ["darwin", "/dev/fd"],
    ["linux", "/proc/self/fd"]
  ]).get(process.platform) ?? null
}

async function OpenDirectoryLease(
  expected: AtomicDirectoryIdentity,
  descriptorRoot: string | null
): Promise<AtomicDirectoryLease> {
  if (descriptorRoot === null) {
    let closed = false
    return {
      Resolve: async () => {
        if (closed) throw PathError("atomic result directory lease is closed")
        await VerifyDirectoryIdentity(expected.Path, expected)
        return { ...expected }
      },
      Close: async () => { closed = true }
    }
  }

  let handle: FileHandle | null = null
  try {
    handle = await open(expected.Path, constants.O_RDONLY)
    const leaseHandle = handle
    const information = await leaseHandle.stat()
    if (
      !information.isDirectory()
      || information.dev !== expected.Device
      || information.ino !== expected.Inode
    ) {
      throw new Error("atomic result directory lease identity changed")
    }
    const descriptorPath = join(descriptorRoot, String(leaseHandle.fd))
    let closed = false
    return {
      Resolve: async () => {
        if (closed) throw PathError("atomic result directory lease is closed")
        const currentPath = await realpath(descriptorPath)
        const currentInformation = await stat(currentPath)
        if (
          !currentInformation.isDirectory()
          || currentInformation.dev !== expected.Device
          || currentInformation.ino !== expected.Inode
        ) {
          throw PathError("atomic result directory lease identity changed")
        }
        return {
          Path: currentPath,
          RealPath: currentPath,
          Device: expected.Device,
          Inode: expected.Inode
        }
      },
      Close: async () => {
        if (closed) return
        await leaseHandle.close()
        closed = true
      }
    }
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // The path error below remains the primary lease-admission failure.
      }
    }
    if (IsPathError(error)) throw error
    throw PathError(ErrorMessage(error))
  }
}

async function SnapshotPriorCanonical(
  canonicalPath: string,
  identity: AtomicDirectoryIdentity
): Promise<PriorCanonical> {
  await VerifyDirectoryIdentity(identity.Path, identity)
  try {
    const information = await lstat(canonicalPath)
    if (information.isSymbolicLink() || !information.isFile()) {
      throw PathError("existing canonical result target must be a real regular file")
    }
    return { Exists: true, Bytes: new Uint8Array(await readFile(canonicalPath)) }
  } catch (error) {
    if (IsFileSystemError(error, "ENOENT")) return { Exists: false, Bytes: new Uint8Array() }
    throw error
  }
}

async function RemoveOwnedTemp(
  tempPath: string,
  original: AtomicDirectoryIdentity,
  lease: AtomicDirectoryLease,
  operations: AtomicWriterOperations
): Promise<void> {
  try {
    await operations.Remove(tempPath, original)
  } catch (operationError) {
    const current = await lease.Resolve()
    await VerifyDirectoryIdentity(current.Path, current)
    await rm(join(current.Path, basename(tempPath)), { force: true })
    if (!IsPathError(operationError)) throw operationError
  }
}

async function RollbackCanonical(
  canonicalPath: string,
  prior: PriorCanonical,
  current: AtomicDirectoryIdentity,
  rollbackSuffix: string
): Promise<void> {
  await VerifyDirectoryIdentity(current.Path, current)
  const currentCanonical = join(current.Path, basename(canonicalPath))
  if (!prior.Exists) {
    await rm(currentCanonical, { force: true })
    return
  }

  const rollbackPath = join(current.Path, `${basename(canonicalPath)}.${rollbackSuffix}.rollback.tmp`)
  let rollbackHandle: FileHandle | null = null
  let rollbackOwned = false
  try {
    rollbackHandle = await open(rollbackPath, "wx", 0o600)
    rollbackOwned = true
    await rollbackHandle.writeFile(prior.Bytes)
    await rollbackHandle.sync()
    await rollbackHandle.close()
    rollbackHandle = null
    await VerifyDirectoryIdentity(current.Path, current)
    await rename(rollbackPath, currentCanonical)
  } finally {
    try { await rollbackHandle?.close() } catch {}
    if (rollbackOwned) await rm(rollbackPath, { force: true })
  }
}

export function NodeAtomicWriterOperations(
  directoryDescriptorRoot: string | null = PlatformDirectoryDescriptorRoot()
): AtomicWriterOperations {
  return {
    Pid: process.pid,
    RandomSuffix: () => randomBytes(12).toString("hex"),
    LeaseDirectory: (identity) => OpenDirectoryLease(identity, directoryDescriptorRoot),
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
  const lease = await operations.LeaseDirectory(identity.Directory)
  const tempPath = join(
    directory,
    `${basename(canonicalPath)}.${identity.Gate}.${identity.RunId}.${operations.Pid}.${operations.RandomSuffix()}.tmp`
  )
  const rollbackSuffix = `${identity.Gate}.${identity.RunId}.${operations.Pid}.${operations.RandomSuffix()}`
  let handle: AtomicFileHandle | null = null
  let ownedTemp = false
  let closed = false
  let tempConsumed = false
  let committed = false
  let primaryError: unknown = null
  let prior: PriorCanonical = { Exists: false, Bytes: new Uint8Array() }

  try {
    prior = await SnapshotPriorCanonical(canonicalPath, identity.Directory)
    handle = await operations.Open(tempPath, identity.Directory)
    ownedTemp = true
    await handle.Write(contents)
    await handle.Sync()
    await handle.Close()
    closed = true
    await operations.Rename(tempPath, canonicalPath, identity.Directory)
    tempConsumed = true
    committed = true
    try {
      await VerifyDirectoryIdentity(directory, identity.Directory)
    } catch (error) {
      try {
        await RollbackCanonical(canonicalPath, prior, await lease.Resolve(), rollbackSuffix)
        committed = false
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], ErrorMessage(error))
      }
      throw error
    }
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
    if (ownedTemp && !tempConsumed) {
      try {
        await RemoveOwnedTemp(tempPath, identity.Directory, lease, operations)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    let closeRollbackIdentity = identity.Directory
    const postCommitLeaseErrors: unknown[] = []
    if (primaryError === null && committed) {
      try {
        closeRollbackIdentity = await lease.Resolve()
      } catch (error) {
        postCommitLeaseErrors.push(error)
      }
    }
    try {
      await lease.Close()
    } catch (error) {
      if (primaryError === null && committed) {
        postCommitLeaseErrors.push(error)
      } else {
        cleanupErrors.push(error)
      }
    }
    if (primaryError === null && committed && postCommitLeaseErrors.length > 0) {
      cleanupErrors.push(...postCommitLeaseErrors)
      try {
        await RollbackCanonical(canonicalPath, prior, closeRollbackIdentity, rollbackSuffix)
        committed = false
      } catch (rollbackError) {
        cleanupErrors.push(rollbackError)
      }
    }

    if (primaryError !== null) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError([primaryError, ...cleanupErrors], ErrorMessage(primaryError))
      }
      throw primaryError
    }
    if (cleanupErrors.length > 0) {
      throw cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, ErrorMessage(cleanupErrors[0]))
    }
  }
}
