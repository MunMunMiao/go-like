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

export interface AtomicRollbackFileHandle {
  readonly Write: (value: Uint8Array) => Promise<void>
  readonly Sync: () => Promise<void>
  readonly Close: () => Promise<void>
}

export interface AtomicWriteLock {
  /** Releases only the retained exclusive lock inode; stale or replaced lock paths fail closed. */
  readonly Release: () => Promise<void>
}

/**
 * Rejection must not hide ownership: AcquireLock/Open/OpenRollback implementations either return
 * the owned resource or clean it before rejecting. Rename implementations retain rename semantics;
 * the writer verifies the staged inode on either resolution or rejection.
 */
export interface AtomicWriterOperations {
  readonly Pid: number
  readonly RandomSuffix: () => string
  readonly LeaseDirectory: (identity: AtomicDirectoryIdentity) => Promise<AtomicDirectoryLease>
  readonly AcquireLock: (
    canonicalPath: string,
    identity: AtomicDirectoryIdentity,
    lease: AtomicDirectoryLease
  ) => Promise<AtomicWriteLock>
  readonly MakeDirectory: (path: string, identity: AtomicDirectoryIdentity) => Promise<void>
  readonly Open: (path: string, identity: AtomicDirectoryIdentity) => Promise<AtomicFileHandle>
  readonly Rename: (from: string, to: string, identity: AtomicDirectoryIdentity) => Promise<void>
  readonly Remove: (path: string, identity: AtomicDirectoryIdentity) => Promise<void>
  readonly OpenRollback: (
    path: string,
    identity: AtomicDirectoryIdentity
  ) => Promise<AtomicRollbackFileHandle>
  readonly RenameRollback: (
    from: string,
    to: string,
    identity: AtomicDirectoryIdentity
  ) => Promise<void>
  readonly RemoveRollback: (path: string, identity: AtomicDirectoryIdentity) => Promise<void>
}

export interface AtomicDirectoryIdentity {
  readonly Path: string
  readonly RealPath: string
  readonly Device: number
  readonly Inode: number
}

export interface AtomicFileIdentity {
  readonly Device: number
  readonly Inode: number
}

export interface AtomicLockFileHandle {
  readonly Stat: () => Promise<AtomicFileIdentity>
  readonly Close: () => Promise<void>
}

export interface AtomicLockFileOperations {
  readonly Open: (path: string) => Promise<AtomicLockFileHandle>
}

export interface AtomicWriteIdentity {
  readonly Gate: string
  readonly RunId: string
  readonly Directory: AtomicDirectoryIdentity
}

export interface AtomicWriteReceipt {
  readonly Commit: () => Promise<void>
  readonly Rollback: () => Promise<void>
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
  try {
    if (error instanceof Error) {
      const message: unknown = error.message
      return typeof message === "string" ? message : "unprintable error"
    }
    return String(error)
  } catch {
    return "unprintable error"
  }
}

function PathError(message: string): Error {
  return new Error(`GATE_RESULT_PATH_ERROR ${message}`)
}

function ThrowFailures(
  primaryThrown: boolean,
  primary: unknown,
  cleanup: readonly unknown[]
): void {
  if (primaryThrown) {
    if (cleanup.length > 0) {
      throw new AggregateError([primary, ...cleanup], ErrorMessage(primary))
    }
    throw primary
  }
  if (cleanup.length === 1) throw cleanup[0]
  if (cleanup.length > 1) throw new AggregateError(cleanup, ErrorMessage(cleanup[0]))
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
      !information.isDirectory() ||
      currentRealPath !== expected.RealPath ||
      information.dev !== expected.Device ||
      information.ino !== expected.Inode
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
  return (
    new Map<string, string>([
      ["darwin", "/dev/fd"],
      ["linux", "/proc/self/fd"]
    ]).get(process.platform) ?? null
  )
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
      Close: async () => {
        closed = true
      }
    }
  }

  let handle: FileHandle | null = null
  try {
    handle = await open(expected.Path, constants.O_RDONLY)
    const leaseHandle = handle
    const information = await leaseHandle.stat()
    if (
      !information.isDirectory() ||
      information.dev !== expected.Device ||
      information.ino !== expected.Inode
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
          !currentInformation.isDirectory() ||
          currentInformation.dev !== expected.Device ||
          currentInformation.ino !== expected.Inode
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

async function Wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function AcquireCanonicalLock(
  canonicalPath: string,
  identity: AtomicDirectoryIdentity,
  lease: AtomicDirectoryLease,
  timeoutMilliseconds: number,
  retryMilliseconds: number,
  lockFiles: AtomicLockFileOperations
): Promise<AtomicWriteLock> {
  const lockName = `${basename(canonicalPath)}.write.lock`
  const deadline = Date.now() + timeoutMilliseconds
  let lockHandle: AtomicLockFileHandle | null = null

  while (lockHandle === null) {
    const current = await lease.Resolve()
    await VerifyDirectoryIdentity(current.Path, current)
    const lockPath = join(current.Path, lockName)
    try {
      lockHandle = await lockFiles.Open(lockPath)
    } catch (error) {
      if (IsFileSystemError(error, "EEXIST")) {
        if (Date.now() >= deadline)
          throw PathError("atomic result writer lock acquisition timed out")
        await Wait(retryMilliseconds)
        continue
      }
      throw error
    }
  }

  const ownedHandle = lockHandle
  let released = false
  return {
    Release: async () => {
      if (released) throw new Error("atomic result writer lock is already released")
      released = true
      let primaryThrown = false
      let primary: unknown
      try {
        const ownedInformation = await ownedHandle.Stat()
        const current = await lease.Resolve()
        await VerifyDirectoryIdentity(current.Path, current)
        const lockPath = join(current.Path, lockName)
        const information = await lstat(lockPath)
        if (
          information.isSymbolicLink() ||
          !information.isFile() ||
          information.dev !== ownedInformation.Device ||
          information.ino !== ownedInformation.Inode
        ) {
          throw new Error("atomic result writer lock identity changed")
        }
        await rm(lockPath)
      } catch (error) {
        primaryThrown = true
        primary = IsPathError(error) ? error : PathError(ErrorMessage(error))
      }
      const cleanup: unknown[] = []
      try {
        await ownedHandle.Close()
      } catch (error) {
        cleanup.push(error)
      }
      ThrowFailures(primaryThrown, primary, cleanup)
    }
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
  rollbackSuffix: string,
  operations: AtomicWriterOperations
): Promise<void> {
  await VerifyDirectoryIdentity(current.Path, current)
  const currentCanonical = join(current.Path, basename(canonicalPath))
  if (!prior.Exists) {
    await operations.RemoveRollback(currentCanonical, current)
    return
  }

  const rollbackPath = join(
    current.Path,
    `${basename(canonicalPath)}.${rollbackSuffix}.rollback.tmp`
  )
  let rollbackHandle: AtomicRollbackFileHandle | null = null
  let rollbackOwned = false
  let rollbackConsumed = false
  let handleClosed = false
  let primaryThrown = false
  let primary: unknown
  try {
    rollbackHandle = await operations.OpenRollback(rollbackPath, current)
    rollbackOwned = true
    await rollbackHandle.Write(prior.Bytes)
    await rollbackHandle.Sync()
    await rollbackHandle.Close()
    handleClosed = true
    await VerifyDirectoryIdentity(current.Path, current)
    await operations.RenameRollback(rollbackPath, currentCanonical, current)
    rollbackConsumed = true
  } catch (error) {
    primaryThrown = true
    primary = error
  }

  const cleanup: unknown[] = []
  if (rollbackHandle !== null && !handleClosed) {
    try {
      await rollbackHandle.Close()
    } catch (error) {
      cleanup.push(error)
    }
  }
  if (rollbackOwned && !rollbackConsumed) {
    try {
      await operations.RemoveRollback(rollbackPath, current)
    } catch (error) {
      cleanup.push(error)
    }
  }
  ThrowFailures(primaryThrown, primary, cleanup)
}

async function CaptureCommittedCanonical(
  canonicalPath: string,
  expectedContents: Uint8Array,
  identity: AtomicDirectoryIdentity
): Promise<AtomicFileIdentity> {
  try {
    await VerifyDirectoryIdentity(identity.Path, identity)
    const information = await lstat(canonicalPath)
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error("canonical result changed before commit confirmation")
    }
    const actual = new Uint8Array(await readFile(canonicalPath))
    if (
      actual.length !== expectedContents.length ||
      actual.some((value, index) => value !== expectedContents[index])
    )
      throw new Error("canonical result changed before commit confirmation")
    return { Device: information.dev, Inode: information.ino }
  } catch (error) {
    if (IsPathError(error)) throw error
    throw PathError(ErrorMessage(error))
  }
}

async function RequireCommittedCanonical(
  canonicalPath: string,
  expectedContents: Uint8Array,
  expectedFile: AtomicFileIdentity,
  identity: AtomicDirectoryIdentity
): Promise<void> {
  try {
    await VerifyDirectoryIdentity(identity.Path, identity)
    const information = await lstat(canonicalPath)
    if (
      information.isSymbolicLink() ||
      !information.isFile() ||
      information.dev !== expectedFile.Device ||
      information.ino !== expectedFile.Inode
    ) {
      throw new Error("canonical result changed before output rollback")
    }
    const actual = new Uint8Array(await readFile(canonicalPath))
    if (
      actual.length !== expectedContents.length ||
      actual.some((value, index) => value !== expectedContents[index])
    )
      throw new Error("canonical result changed before output rollback")
  } catch (error) {
    if (IsPathError(error)) throw error
    throw PathError(ErrorMessage(error))
  }
}

async function RollbackCommittedCanonicalIfOwned(
  canonicalPath: string,
  committedContents: Uint8Array,
  committedFile: AtomicFileIdentity,
  prior: PriorCanonical,
  rollbackSuffix: string,
  lease: AtomicDirectoryLease,
  operations: AtomicWriterOperations
): Promise<boolean> {
  const current = await lease.Resolve()
  const currentCanonical = join(current.Path, basename(canonicalPath))
  try {
    await RequireCommittedCanonical(currentCanonical, committedContents, committedFile, current)
  } catch {
    return false
  }
  await RollbackCanonical(canonicalPath, prior, current, rollbackSuffix, operations)
  return true
}

async function CloseReceiptResources(
  lock: AtomicWriteLock,
  lease: AtomicDirectoryLease,
  primaryThrown: boolean,
  primary: unknown
): Promise<void> {
  const cleanup: unknown[] = []
  try {
    await lock.Release()
  } catch (error) {
    cleanup.push(error)
  }
  try {
    await lease.Close()
  } catch (error) {
    cleanup.push(error)
  }
  ThrowFailures(primaryThrown, primary, cleanup)
}

function CreateReceipt(
  canonicalPath: string,
  committedContents: Uint8Array,
  committedFile: AtomicFileIdentity,
  prior: PriorCanonical,
  identity: AtomicWriteIdentity,
  rollbackSuffix: string,
  lock: AtomicWriteLock,
  lease: AtomicDirectoryLease,
  operations: AtomicWriterOperations
): AtomicWriteReceipt {
  let consumed = false

  async function Finalize(rollback: boolean): Promise<void> {
    if (consumed) throw new Error("canonical write receipt is already consumed")
    consumed = true
    let primaryThrown = false
    let primary: unknown
    try {
      const current = await lease.Resolve()
      if (
        !rollback &&
        (current.Path !== identity.Directory.Path ||
          current.RealPath !== identity.Directory.RealPath)
      ) {
        throw PathError("atomic result directory moved before commit confirmation")
      }
      const currentCanonical = join(current.Path, basename(canonicalPath))
      await RequireCommittedCanonical(currentCanonical, committedContents, committedFile, current)
      if (rollback) {
        await RollbackCanonical(canonicalPath, prior, current, rollbackSuffix, operations)
      }
    } catch (error) {
      primaryThrown = true
      primary = error
    }
    await CloseReceiptResources(lock, lease, primaryThrown, primary)
  }

  return {
    Commit: async () => Finalize(false),
    Rollback: async () => Finalize(true)
  }
}

export function nodeAtomicWriterOperations(
  directoryDescriptorRoot: string | null = PlatformDirectoryDescriptorRoot(),
  lockTimeoutMilliseconds = 5_000,
  lockRetryMilliseconds = 5,
  lockFiles: AtomicLockFileOperations = {
    Open: async (path) => {
      const handle = await open(path, "wx", 0o600)
      return {
        Stat: async () => {
          const information = await handle.stat()
          return { Device: information.dev, Inode: information.ino }
        },
        Close: async () => {
          await handle.close()
        }
      }
    }
  }
): AtomicWriterOperations {
  return {
    Pid: process.pid,
    RandomSuffix: () => randomBytes(12).toString("hex"),
    LeaseDirectory: (identity) => OpenDirectoryLease(identity, directoryDescriptorRoot),
    AcquireLock: (canonicalPath, identity, lease) =>
      AcquireCanonicalLock(
        canonicalPath,
        identity,
        lease,
        lockTimeoutMilliseconds,
        lockRetryMilliseconds,
        lockFiles
      ),
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
    },
    OpenRollback: async (path, identity) => {
      AssertChildPath(path, identity)
      await VerifyDirectoryIdentity(identity.Path, identity)
      const handle = await open(path, "wx", 0o600)
      return {
        Write: async (value) => {
          await handle.writeFile(value)
        },
        Sync: async () => {
          await handle.sync()
        },
        Close: async () => {
          await handle.close()
        }
      }
    },
    RenameRollback: async (from, to, identity) => {
      AssertChildPath(from, identity)
      AssertChildPath(to, identity)
      await VerifyDirectoryIdentity(identity.Path, identity)
      await rename(from, to)
    },
    RemoveRollback: async (path, identity) => {
      AssertChildPath(path, identity)
      await VerifyDirectoryIdentity(identity.Path, identity)
      await rm(path, { force: true })
    }
  }
}

export async function writeCanonicalFile(
  canonicalPath: string,
  contents: string,
  identity: AtomicWriteIdentity,
  operations: AtomicWriterOperations
): Promise<AtomicWriteReceipt> {
  const directory = dirname(canonicalPath)
  const pid = operations.Pid
  const tempSuffix = operations.RandomSuffix()
  const rollbackSuffix = `${identity.Gate}.${identity.RunId}.${pid}.${operations.RandomSuffix()}`
  const tempPath = join(
    directory,
    `${basename(canonicalPath)}.${identity.Gate}.${identity.RunId}.${pid}.${tempSuffix}.tmp`
  )
  const committedContents = new TextEncoder().encode(contents)
  await operations.MakeDirectory(directory, identity.Directory)
  const lease = await operations.LeaseDirectory(identity.Directory)
  let lock: AtomicWriteLock
  try {
    lock = await operations.AcquireLock(canonicalPath, identity.Directory, lease)
  } catch (error) {
    const cleanup: unknown[] = []
    try {
      await lease.Close()
    } catch (closeError) {
      cleanup.push(closeError)
    }
    ThrowFailures(true, error, cleanup)
    throw new Error("unreachable atomic lock admission")
  }

  let handle: AtomicFileHandle | null = null
  let ownedTemp = false
  let closed = false
  let tempConsumed = false
  let primaryThrown = false
  let primary: unknown
  let prior: PriorCanonical = { Exists: false, Bytes: new Uint8Array() }
  let stagedFile: AtomicFileIdentity | null = null
  let committedFile: AtomicFileIdentity | null = null

  try {
    prior = await SnapshotPriorCanonical(canonicalPath, identity.Directory)
    handle = await operations.Open(tempPath, identity.Directory)
    ownedTemp = true
    await handle.Write(contents)
    await handle.Sync()
    await handle.Close()
    closed = true
    stagedFile = await CaptureCommittedCanonical(tempPath, committedContents, identity.Directory)
    try {
      await operations.Rename(tempPath, canonicalPath, identity.Directory)
    } catch (error) {
      try {
        tempConsumed = await RollbackCommittedCanonicalIfOwned(
          canonicalPath,
          committedContents,
          stagedFile,
          prior,
          rollbackSuffix,
          lease,
          operations
        )
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], ErrorMessage(error))
      }
      throw error
    }
    tempConsumed = true
    try {
      const current = await lease.Resolve()
      if (
        current.Path !== identity.Directory.Path ||
        current.RealPath !== identity.Directory.RealPath
      ) {
        throw PathError("atomic result directory moved before commit confirmation")
      }
      committedFile = await CaptureCommittedCanonical(
        canonicalPath,
        committedContents,
        identity.Directory
      )
      if (committedFile.Device !== stagedFile.Device || committedFile.Inode !== stagedFile.Inode) {
        throw PathError("canonical result changed before commit confirmation")
      }
    } catch (error) {
      try {
        await RollbackCommittedCanonicalIfOwned(
          canonicalPath,
          committedContents,
          stagedFile,
          prior,
          rollbackSuffix,
          lease,
          operations
        )
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], ErrorMessage(error))
      }
      throw error
    }
  } catch (error) {
    primaryThrown = true
    primary = error
  }

  const cleanup: unknown[] = []
  if (handle !== null && !closed) {
    try {
      await handle.Close()
    } catch (error) {
      cleanup.push(error)
    }
  }
  if (ownedTemp && !tempConsumed) {
    try {
      await RemoveOwnedTemp(tempPath, identity.Directory, lease, operations)
    } catch (error) {
      cleanup.push(error)
    }
  }

  if (primaryThrown || cleanup.length > 0) {
    try {
      await lock.Release()
    } catch (error) {
      cleanup.push(error)
    }
    try {
      await lease.Close()
    } catch (error) {
      cleanup.push(error)
    }
    ThrowFailures(primaryThrown, primary, cleanup)
    throw new Error("unreachable atomic write failure")
  }

  return CreateReceipt(
    canonicalPath,
    committedContents,
    committedFile as AtomicFileIdentity,
    prior,
    identity,
    rollbackSuffix,
    lock,
    lease,
    operations
  )
}
