import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  Readable,
  Writable,
  type Readable as NodeReadable,
  type Writable as NodeWritable
} from "node:stream"
import { fileURLToPath } from "node:url"

import { errorValue } from "./result"

const RepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const NativeSource = resolve(RepositoryRoot, "e2e/harness/native/likego_e2e_posix_filesystem.c")
const NativeProtocol = resolve(
  RepositoryRoot,
  "e2e/harness/native/likego_e2e_posix_filesystem_protocol.h"
)
const NativeArtifactDirectory = resolve(RepositoryRoot, ".artifacts/e2e-native")
const NativeBinary = resolve(NativeArtifactDirectory, "likego-e2e-posix-filesystem")

const ProtocolMagic = 0x5346474c
const ProtocolVersion = 1
const HeaderSize = 32
const MaximumPayloadBytes = 4 * 1024 * 1024 + 4096
const MaximumComponentBytes = 128
const MaximumStabilizationMs = 30_000
const RequestBudgetMs = 35_000

const ResponseBit = 0x8000
const OpenRoot = 1
const EnsurePrivateChild = 2
const CreatePrivateChild = 3
const OpenPrivateChild = 4
const VerifyDirectory = 5
const WriteFile = 6
const ReadFile = 7
const RemoveTree = 8
const CloseHandle = 9
const Shutdown = 10
const ReadProcessIdentity = 11

const StatusOk = 0
const StatusSystem = 1
const StatusInvalid = 2
const StatusIdentity = 3
const StatusLimit = 4
const StatusIncomplete = 5
const StatusPermissions = 7

const WriteReadOnly = 1

const TempPrefixPattern = /^[a-z0-9][a-z0-9_.-]{0,63}-$/u
const ComponentPattern = /^(?!\.{1,2}$)[.@a-zA-Z0-9][@a-zA-Z0-9_.-]{0,127}$/u
const Utf8Encoder = new TextEncoder()
const Utf8Decoder = new TextDecoder("utf-8", { fatal: true })

const PortableErrorCodes = Object.freeze([
  "UNKNOWN",
  "ENOENT",
  "EEXIST",
  "ELOOP",
  "ENOTDIR",
  "EISDIR",
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EMFILE",
  "ENFILE",
  "EIO",
  "EOVERFLOW",
  "EBADF",
  "ENOTEMPTY",
  "EXDEV",
  "EINTR",
  "ETIMEDOUT",
  "ESTALE",
  "EBUSY",
  "EFBIG",
  "EINVAL",
  "ENOTSUP"
] as const)

type PortableErrorCode = (typeof PortableErrorCodes)[number]

declare const SecureDirectoryBrand: unique symbol

/** An opaque retained-directory lease owned by the native filesystem broker. */
export interface SecureDirectory {
  readonly [SecureDirectoryBrand]: true
}

export interface OpenSecureDirectoryOptions {
  readonly containedRoot?: string | undefined
}

export interface WriteSecureFileOptions {
  readonly readOnly?: boolean | undefined
}

export interface SecureDarwinProcessIdentity {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly uid: number
  readonly startMicroseconds: bigint
}

interface NativeResponse {
  readonly status: number
  readonly errorNumber: number
  readonly value: number
  readonly payload: Uint8Array
}

interface DirectoryState {
  readonly session: FilesystemSession
  readonly path: string
  readonly ownedHandleIds: number[]
  queue: Promise<void>
  closing: boolean
  closed: boolean
}

interface OpenedNativeDirectory {
  readonly handleId: number
  readonly path: string
}

interface BufferedReader {
  value: Uint8Array
}

export class SecureFilesystemError extends Error {
  readonly code: PortableErrorCode
  readonly status: number
  readonly errorNumber: number

  constructor(operation: string, response: NativeResponse) {
    const selected = PortableErrorCodes[response.value] ?? "UNKNOWN"
    super(`secure filesystem ${operation} failed (${selected})`)
    this.name = "SecureFilesystemError"
    this.code = selected
    this.status = response.status
    this.errorNumber = response.errorNumber
  }
}

function errorSummary(value: Uint8Array): string {
  const text = new TextDecoder().decode(value).replaceAll(/\s+/gu, " ").trim()
  return text.length === 0 ? "no compiler diagnostic" : text.slice(0, 2_000)
}

async function existingNativeBinary(): Promise<boolean> {
  try {
    const [binary, source, protocol] = await Promise.all([
      stat(NativeBinary),
      stat(NativeSource),
      stat(NativeProtocol)
    ])
    return binary.isFile() && binary.mtimeMs >= source.mtimeMs && binary.mtimeMs >= protocol.mtimeMs
  } catch {
    return false
  }
}

async function runNativeSelfTest(binary: string): Promise<void> {
  const result = spawnSync(binary, ["--self-test"], {
    cwd: RepositoryRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  })
  const stdout = result.stdout ?? Buffer.alloc(0)
  const stderr = result.stderr ?? Buffer.alloc(0)
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    !stdout.toString().includes("likego_e2e_posix_filesystem self-test: PASS")
  ) {
    throw new Error(
      `prerequisite-native-filesystem-self-test-failed: ${errorSummary(
        stderr.byteLength === 0 ? stdout : stderr
      )}`
    )
  }
}

async function compileNativeBinary(): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`prerequisite-secure-filesystem-unavailable: unsupported ${process.platform}`)
  }
  if (await existingNativeBinary()) {
    await runNativeSelfTest(NativeBinary)
    return NativeBinary
  }
  const compiler = "cc"
  await mkdir(NativeArtifactDirectory, { recursive: true, mode: 0o700 })
  const temporary = `${NativeBinary}.${process.pid}.${randomUUID()}.tmp`
  try {
    const result = spawnSync(
      compiler,
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-Werror",
        NativeSource,
        "-o",
        temporary
      ],
      { cwd: RepositoryRoot, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] }
    )
    const stdout = result.stdout ?? Buffer.alloc(0)
    const stderr = result.stderr ?? Buffer.alloc(0)
    if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
      throw new Error("prerequisite-native-compiler-unavailable: cc was not found")
    }
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `prerequisite-native-filesystem-build-failed: ${errorSummary(
          stderr.byteLength === 0 ? stdout : stderr
        )}`
      )
    }
    await runNativeSelfTest(temporary)
    await rename(temporary, NativeBinary)
    await runNativeSelfTest(NativeBinary)
    return NativeBinary
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

let nativeBinary: Promise<string> | null = null

async function nativeFilesystemBinary(): Promise<string> {
  nativeBinary ??= compileNativeBinary().catch((error: unknown) => {
    nativeBinary = null
    throw error
  })
  return await nativeBinary
}

function validateUint32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} is outside uint32`)
  }
}

function validateComponent(component: string): Uint8Array {
  if (typeof component !== "string" || !ComponentPattern.test(component)) {
    throw new Error("invalid secure filesystem path component")
  }
  const encoded = Utf8Encoder.encode(component)
  if (encoded.byteLength === 0 || encoded.byteLength > MaximumComponentBytes) {
    throw new Error("invalid secure filesystem path component")
  }
  return encoded
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: BufferedReader,
  length: number
): Promise<Uint8Array> {
  while (buffered.value.byteLength < length) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("secure filesystem broker protocol ended unexpectedly")
    buffered.value = concatenate([buffered.value, chunk.value])
  }
  const result = buffered.value.slice(0, length)
  buffered.value = buffered.value.slice(length)
  return result
}

async function settleWithin<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("secure filesystem broker operation exceeded its bounded deadline")),
      milliseconds
    )
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

class FilesystemBroker {
  readonly #process: ChildProcessByStdio<NodeWritable, NodeReadable, null>
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #exited: Promise<number>
  readonly #buffered: BufferedReader = { value: new Uint8Array() }
  #tail: Promise<void> = Promise.resolve()
  #nextRequestId = 1n
  #closed = false
  #terminal: unknown = null
  #requestStarted = false

  private constructor(
    processHandle: ChildProcessByStdio<NodeWritable, NodeReadable, null>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    exited: Promise<number>
  ) {
    this.#process = processHandle
    this.#writer = writer
    this.#reader = reader
    this.#exited = exited
  }

  static async start(): Promise<FilesystemBroker> {
    const binary = await nativeFilesystemBinary()
    const child = spawn(binary, ["--broker"], {
      cwd: RepositoryRoot,
      stdio: ["pipe", "pipe", "ignore"]
    })
    const exited = new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit)
      child.once("exit", (code, signal) => {
        if (signal !== null) rejectExit(new Error(`secure filesystem broker exited by ${signal}`))
        else resolveExit(code ?? -1)
      })
    })
    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
    const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    return new FilesystemBroker(child, input.getWriter(), output.getReader(), exited)
  }

  async request(
    opcode: number,
    handleId: number,
    flags: number,
    payload: Uint8Array,
    operation: string
  ): Promise<NativeResponse> {
    if (this.#closed || this.#terminal !== null) {
      throw new Error("secure filesystem broker is unavailable", { cause: this.#terminal })
    }
    const result = this.#tail.then(
      async () => await this.#requestNow(opcode, handleId, flags, payload, operation)
    )
    this.#tail = result.then(
      () => undefined,
      () => undefined
    )
    return await result
  }

  async #requestNow(
    opcode: number,
    handleId: number,
    flags: number,
    payload: Uint8Array,
    operation: string
  ): Promise<NativeResponse> {
    validateUint32(handleId, "secure filesystem handle ID")
    validateUint32(flags, "secure filesystem request flags")
    if (payload.byteLength > MaximumPayloadBytes) {
      throw new RangeError("secure filesystem request payload is too large")
    }
    if (this.#nextRequestId > 0xffffffffffffffffn) {
      throw new Error("secure filesystem request ID space was exhausted")
    }
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1n
    this.#requestStarted = false
    const header = new Uint8Array(HeaderSize)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, ProtocolMagic, true)
    headerView.setUint16(4, ProtocolVersion, true)
    headerView.setUint16(6, opcode, true)
    headerView.setBigUint64(8, requestId, true)
    headerView.setUint32(16, handleId, true)
    headerView.setUint32(20, flags, true)
    headerView.setUint32(24, payload.byteLength, true)
    try {
      const response = await settleWithin(
        (async (): Promise<NativeResponse> => {
          this.#requestStarted = true
          await this.#writer.write(concatenate([header, payload]))
          const responseHeader = await readExactly(this.#reader, this.#buffered, HeaderSize)
          const view = new DataView(
            responseHeader.buffer,
            responseHeader.byteOffset,
            responseHeader.byteLength
          )
          if (
            view.getUint32(0, true) !== ProtocolMagic ||
            view.getUint16(4, true) !== ProtocolVersion ||
            view.getUint16(6, true) !== (opcode | ResponseBit) ||
            view.getBigUint64(8, true) !== requestId
          ) {
            throw new Error("secure filesystem broker returned an invalid response header")
          }
          const status = view.getUint32(16, true)
          const errorNumber = view.getUint32(20, true)
          const value = view.getUint32(24, true)
          const payloadLength = view.getUint32(28, true)
          if (
            status > StatusPermissions ||
            payloadLength > MaximumPayloadBytes ||
            (status === StatusOk && errorNumber !== 0) ||
            (status !== StatusOk && errorNumber === 0)
          ) {
            throw new Error("secure filesystem broker returned invalid response metadata")
          }
          const responsePayload = await readExactly(this.#reader, this.#buffered, payloadLength)
          return Object.freeze({ status, errorNumber, value, payload: responsePayload })
        })(),
        RequestBudgetMs
      )
      if (response.status !== StatusOk) throw new SecureFilesystemError(operation, response)
      return response
    } catch (error) {
      if (error instanceof SecureFilesystemError) throw error
      if (!this.#requestStarted) throw error
      this.#terminal = error
      this.#process.kill("SIGKILL")
      await this.#reader.cancel().catch(() => {})
      await this.#exited.catch(() => {})
      throw new Error("secure filesystem broker became unavailable", { cause: error })
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#terminal === null) {
      try {
        await this.requestWhileClosing(Shutdown, 0, 0, new Uint8Array(), "shutdown")
        await this.#writer.close()
        const exitCode = await settleWithin(this.#exited, 5_000)
        if (exitCode !== 0) {
          throw new Error(`secure filesystem broker exited with status ${exitCode}`)
        }
      } catch (error) {
        this.#terminal = error
        if (this.#process.exitCode === null && this.#process.signalCode === null) {
          this.#process.kill("SIGKILL")
        }
        await this.#exited.catch(() => {})
        throw error
      } finally {
        await this.#reader.cancel().catch(() => {})
      }
      return
    }
    if (this.#process.exitCode === null && this.#process.signalCode === null) {
      this.#process.kill("SIGKILL")
    }
    await this.#exited.catch(() => {})
    await this.#reader.cancel().catch(() => {})
  }

  async requestWhileClosing(
    opcode: number,
    handleId: number,
    flags: number,
    payload: Uint8Array,
    operation: string
  ): Promise<NativeResponse> {
    const result = this.#tail.then(
      async () => await this.#requestNow(opcode, handleId, flags, payload, operation)
    )
    this.#tail = result.then(
      () => undefined,
      () => undefined
    )
    return await result
  }
}

class FilesystemSession {
  readonly broker: FilesystemBroker
  readonly platformRootHandleId: number
  readonly userRootHandleId: number
  readonly platformRootPath: string
  readonly userRootPath: string
  references = 0
  closing = false

  private constructor(
    broker: FilesystemBroker,
    platformRoot: OpenedNativeDirectory,
    userRoot: OpenedNativeDirectory
  ) {
    this.broker = broker
    this.platformRootHandleId = platformRoot.handleId
    this.userRootHandleId = userRoot.handleId
    this.platformRootPath = platformRoot.path
    this.userRootPath = userRoot.path
  }

  static async create(): Promise<FilesystemSession> {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error(`prerequisite-secure-filesystem-unavailable: unsupported ${process.platform}`)
    }
    if (typeof process.getuid !== "function") {
      throw new Error("prerequisite-secure-filesystem-unavailable: POSIX UID is unavailable")
    }
    const canonicalPlatformRoot = await realpath(tmpdir())
    if (
      !isAbsolute(canonicalPlatformRoot) ||
      resolve(canonicalPlatformRoot) !== canonicalPlatformRoot
    ) {
      throw new Error("canonical platform temp root is invalid")
    }
    const broker = await FilesystemBroker.start()
    try {
      const root = await openRoot(broker, canonicalPlatformRoot)
      if (root.path !== canonicalPlatformRoot) {
        throw new Error("native filesystem broker changed the canonical platform temp root")
      }
      const userComponent = `likego-${process.getuid()}`
      const userRoot = await openChild(
        broker,
        root.handleId,
        EnsurePrivateChild,
        userComponent,
        "ensure private user temp root"
      )
      if (userRoot.path !== join(canonicalPlatformRoot, userComponent)) {
        throw new Error("native filesystem broker changed the private user temp root")
      }
      return new FilesystemSession(broker, root, userRoot)
    } catch (error) {
      await broker.shutdown().catch(() => {})
      throw error
    }
  }

  retain(): void {
    if (this.closing) throw new Error("secure filesystem session is closing")
    this.references += 1
  }

  async closeBaseHandles(): Promise<void> {
    await closeNativeHandles(this, [this.platformRootHandleId, this.userRootHandleId])
  }
}

let activeSession: FilesystemSession | null = null
let creatingSession: Promise<FilesystemSession> | null = null

async function acquireSession(): Promise<FilesystemSession> {
  if (activeSession !== null && !activeSession.closing) {
    activeSession.retain()
    return activeSession
  }
  creatingSession ??= FilesystemSession.create().finally(() => {
    creatingSession = null
  })
  const created = await creatingSession
  if (activeSession === null || activeSession.closing) activeSession = created
  else if (activeSession !== created) await created.broker.shutdown()
  const selected = activeSession
  selected.retain()
  return selected
}

async function releaseSession(session: FilesystemSession): Promise<void> {
  if (session.references <= 0) throw new Error("secure filesystem session reference underflow")
  session.references -= 1
  if (session.references !== 0) return
  session.closing = true
  if (activeSession === session) activeSession = null
  try {
    await session.closeBaseHandles()
  } finally {
    await session.broker.shutdown()
  }
}

async function openRoot(broker: FilesystemBroker, path: string): Promise<OpenedNativeDirectory> {
  const payload = Utf8Encoder.encode(path)
  const response = await broker.request(OpenRoot, 0, 0, payload, "open canonical root")
  if (response.value === 0 || response.payload.byteLength === 0) {
    throw new Error("secure filesystem broker returned an invalid root handle")
  }
  return Object.freeze({
    handleId: response.value,
    path: Utf8Decoder.decode(response.payload)
  })
}

async function openChild(
  broker: FilesystemBroker,
  parentHandleId: number,
  opcode: number,
  component: string,
  operation: string
): Promise<OpenedNativeDirectory> {
  const payload = validateComponent(component)
  const response = await broker.request(opcode, parentHandleId, 0, payload, operation)
  if (response.value === 0 || response.payload.byteLength === 0) {
    throw new Error("secure filesystem broker returned an invalid child handle")
  }
  return Object.freeze({
    handleId: response.value,
    path: Utf8Decoder.decode(response.payload)
  })
}

const consumedHandleErrors = new WeakSet<object>()

function nativeHandleInventoryConsumed(error: unknown): boolean {
  return typeof error === "object" && error !== null && consumedHandleErrors.has(error)
}

async function closeNativeHandles(session: FilesystemSession, handleIds: number[]): Promise<void> {
  const failures: Error[] = []
  while (handleIds.length > 0) {
    const handleId = handleIds.at(-1)
    if (handleId === undefined) throw new Error("secure filesystem handle inventory changed")
    try {
      await session.broker.request(CloseHandle, handleId, 0, new Uint8Array(), "close handle")
    } catch (error) {
      if (!(error instanceof SecureFilesystemError && error.status === StatusIncomplete)) {
        if (failures.length === 0) throw error
        throw new AggregateError(
          [...failures, errorValue(error, "secure filesystem handle cleanup failed")],
          "secure filesystem handle cleanup failed"
        )
      }
      failures.push(error)
      handleIds.pop()
      continue
    }
    handleIds.pop()
  }
  if (failures.length === 0) return
  const failure =
    failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "secure filesystem handles closed with diagnostics")
  if (failure === undefined) throw new Error("secure filesystem close diagnostic was lost")
  consumedHandleErrors.add(failure)
  throw failure
}

function directoryState(directory: SecureDirectory): DirectoryState {
  const state = issuedDirectories.get(directory)
  if (state === undefined || state.closed || state.closing) {
    throw new Error("unknown secure filesystem directory handle")
  }
  return state
}

function runDirectoryOperation<T>(
  directory: SecureDirectory,
  operation: (state: DirectoryState) => Promise<T>
): Promise<T> {
  const state = directoryState(directory)
  const result = state.queue.then(async () => await operation(state))
  state.queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

const issuedDirectories = new WeakMap<object, DirectoryState>()
const consumedDirectoryErrors = new WeakSet<object>()

/** Returns whether an error permanently consumed its secure directory lease. */
export function secureDirectoryLeaseConsumed(error: unknown): boolean {
  return typeof error === "object" && error !== null && consumedDirectoryErrors.has(error)
}

function issueDirectory(
  session: FilesystemSession,
  path: string,
  ownedHandleIds: number[]
): SecureDirectory {
  if (ownedHandleIds.length === 0 && path !== session.userRootPath) {
    throw new Error("secure filesystem directory lease has no retained handle")
  }
  session.retain()
  const directory = Object.freeze({}) as SecureDirectory
  issuedDirectories.set(directory, {
    session,
    path,
    ownedHandleIds,
    queue: Promise.resolve(),
    closing: false,
    closed: false
  })
  return directory
}

function validatedAbsolutePath(path: string, label: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new Error(`${label} must be absolute and canonical`)
  }
  return path
}

function strictRelative(root: string, candidate: string): string | null {
  const child = relative(root, candidate)
  if (child === "") return ""
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return null
  return child
}

function relativeComponents(value: string): readonly string[] {
  if (value.length === 0) return Object.freeze([])
  const components = value.split(sep)
  for (const component of components) validateComponent(component)
  return Object.freeze(components)
}

/** Reads one stable macOS process identity through native `proc_pidinfo`. */
export async function readSecureDarwinProcessIdentity(
  pid: number
): Promise<SecureDarwinProcessIdentity> {
  if (process.platform !== "darwin") {
    throw new Error("native Darwin process identity is unavailable on this platform")
  }
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) {
    throw new RangeError("Darwin process PID is outside the supported bounds")
  }
  const session = await acquireSession()
  try {
    const request = new Uint8Array(4)
    new DataView(request.buffer).setUint32(0, pid, true)
    const response = await session.broker.request(
      ReadProcessIdentity,
      0,
      0,
      request,
      "read Darwin process identity"
    )
    if (response.value !== 0 || response.payload.byteLength !== 24) {
      throw new Error("secure filesystem broker returned an invalid Darwin process identity")
    }
    const view = new DataView(
      response.payload.buffer,
      response.payload.byteOffset,
      response.payload.byteLength
    )
    const observedPid = view.getUint32(0, true)
    const ppid = view.getUint32(4, true)
    const pgid = view.getUint32(8, true)
    const uid = view.getUint32(12, true)
    const startMicroseconds = view.getBigUint64(16, true)
    if (observedPid !== pid || pgid === 0 || startMicroseconds === 0n) {
      throw new Error("secure filesystem broker returned an invalid Darwin process identity")
    }
    return Object.freeze({ pid: observedPid, ppid, pgid, uid, startMicroseconds })
  } finally {
    await releaseSession(session)
  }
}

/** Returns the canonical private per-user temp root represented by retained native FDs. */
export async function canonicalSecureTempRoot(): Promise<string> {
  const session = await acquireSession()
  try {
    return session.userRootPath
  } finally {
    await releaseSession(session)
  }
}

/** Exclusively creates and retains one random private directory under the secure temp root. */
export async function createSecureTempDirectory(prefix: string): Promise<SecureDirectory> {
  if (!TempPrefixPattern.test(prefix)) throw new Error("invalid secure temp directory prefix")
  const session = await acquireSession()
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const component = `${prefix}${randomUUID()}`
      try {
        const opened = await openChild(
          session.broker,
          session.userRootHandleId,
          CreatePrivateChild,
          component,
          "create private temp directory"
        )
        const expected = join(session.userRootPath, component)
        if (opened.path !== expected) {
          await session.broker
            .request(CloseHandle, opened.handleId, 0, new Uint8Array(), "close mismatched handle")
            .catch(() => {})
          throw new Error("secure filesystem broker changed a created temp directory path")
        }
        return issueDirectory(session, opened.path, [opened.handleId])
      } catch (error) {
        if (error instanceof SecureFilesystemError && error.code === "EEXIST") continue
        throw error
      }
    }
    throw new Error("secure filesystem could not allocate an exclusive temp directory")
  } finally {
    await releaseSession(session)
  }
}

/** Opens a private directory by walking each component from the retained secure temp root. */
export async function openSecureDirectory(
  path: string,
  options: OpenSecureDirectoryOptions = {}
): Promise<SecureDirectory> {
  const requested = validatedAbsolutePath(path, "secure filesystem directory path")
  const containedRoot =
    options.containedRoot === undefined
      ? null
      : validatedAbsolutePath(options.containedRoot, "secure filesystem contained root path")
  const session = await acquireSession()
  const openedIds: number[] = []
  try {
    const fromUserRoot = strictRelative(session.userRootPath, requested)
    if (fromUserRoot === null) {
      throw new Error("secure filesystem directory escaped the private temp root")
    }
    if (containedRoot !== null) {
      const containedFromUser = strictRelative(session.userRootPath, containedRoot)
      const requestedFromContained = strictRelative(containedRoot, requested)
      if (
        containedFromUser === null ||
        requestedFromContained === null ||
        requestedFromContained === ""
      ) {
        throw new Error("secure filesystem directory escaped its required contained root")
      }
    }
    let parentHandleId = session.userRootHandleId
    let expectedPath = session.userRootPath
    for (const component of relativeComponents(fromUserRoot)) {
      const opened = await openChild(
        session.broker,
        parentHandleId,
        OpenPrivateChild,
        component,
        "open private directory"
      )
      openedIds.push(opened.handleId)
      parentHandleId = opened.handleId
      expectedPath = join(expectedPath, component)
      if (opened.path !== expectedPath) {
        throw new Error("secure filesystem broker changed an opened directory path")
      }
    }
    return issueDirectory(session, requested, openedIds)
  } catch (error) {
    await closeNativeHandles(session, openedIds).catch(() => {})
    throw error
  } finally {
    await releaseSession(session)
  }
}

/** Returns the external canonical identity path of one retained directory. */
export function secureDirectoryPath(directory: SecureDirectory): string {
  return directoryState(directory).path
}

/** Creates one private child exclusively relative to a retained directory FD. */
export async function createSecurePrivateDirectory(
  parent: SecureDirectory,
  component: string
): Promise<SecureDirectory> {
  return await runDirectoryOperation(parent, async (state) => {
    const opened = await openChild(
      state.session.broker,
      state.ownedHandleIds.at(-1) ?? state.session.userRootHandleId,
      CreatePrivateChild,
      component,
      "create private child directory"
    )
    const expected = join(state.path, component)
    if (opened.path !== expected) {
      await state.session.broker
        .request(CloseHandle, opened.handleId, 0, new Uint8Array(), "close mismatched handle")
        .catch(() => {})
      throw new Error("secure filesystem broker changed a created child directory path")
    }
    return issueDirectory(state.session, opened.path, [opened.handleId])
  })
}

/** Revalidates a retained directory and every retained ancestor entry. */
export async function verifySecureDirectory(directory: SecureDirectory): Promise<void> {
  await runDirectoryOperation(directory, async (state) => {
    const handleId = state.ownedHandleIds.at(-1) ?? state.session.userRootHandleId
    await state.session.broker.request(
      VerifyDirectory,
      handleId,
      0,
      new Uint8Array(),
      "verify directory"
    )
  })
}

/** Atomically publishes bounded bytes without replacing an existing final component. */
export async function writeSecureFileNoReplace(
  directory: SecureDirectory,
  temporaryComponent: string,
  finalComponent: string,
  bytes: Uint8Array,
  options: WriteSecureFileOptions = {}
): Promise<void> {
  const temporary = validateComponent(temporaryComponent)
  const final = validateComponent(finalComponent)
  if (temporaryComponent === finalComponent) {
    throw new Error("secure filesystem temporary and final components must differ")
  }
  if (bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("secure filesystem file exceeds the supported byte bound")
  }
  const payload = new Uint8Array(8 + temporary.byteLength + final.byteLength + bytes.byteLength)
  const view = new DataView(payload.buffer)
  view.setUint16(0, temporary.byteLength, true)
  view.setUint16(2, final.byteLength, true)
  view.setUint32(4, bytes.byteLength, true)
  payload.set(temporary, 8)
  payload.set(final, 8 + temporary.byteLength)
  payload.set(bytes, 8 + temporary.byteLength + final.byteLength)
  await runDirectoryOperation(directory, async (state) => {
    const handleId = state.ownedHandleIds.at(-1) ?? state.session.userRootHandleId
    await state.session.broker.request(
      WriteFile,
      handleId,
      options.readOnly === true ? WriteReadOnly : 0,
      payload,
      "write file"
    )
  })
}

/** Reads bounded bytes from one no-follow regular file relative to a retained directory FD. */
export async function readSecureFile(
  directory: SecureDirectory,
  component: string,
  maximumBytes: number,
  publicationStabilizationTimeoutMs: number
): Promise<Uint8Array> {
  validateUint32(maximumBytes, "secure filesystem maximum file bytes")
  validateUint32(
    publicationStabilizationTimeoutMs,
    "secure filesystem publication stabilization timeout"
  )
  if (
    maximumBytes < 1 ||
    maximumBytes > 4 * 1024 * 1024 ||
    publicationStabilizationTimeoutMs < 1 ||
    publicationStabilizationTimeoutMs > MaximumStabilizationMs
  ) {
    throw new RangeError("secure filesystem bounded read options are invalid")
  }
  const encoded = validateComponent(component)
  const payload = new Uint8Array(10 + encoded.byteLength)
  const view = new DataView(payload.buffer)
  view.setUint16(0, encoded.byteLength, true)
  view.setUint32(2, maximumBytes, true)
  view.setUint32(6, publicationStabilizationTimeoutMs, true)
  payload.set(encoded, 10)
  return await runDirectoryOperation(directory, async (state) => {
    const handleId = state.ownedHandleIds.at(-1) ?? state.session.userRootHandleId
    const response = await state.session.broker.request(ReadFile, handleId, 0, payload, "read file")
    if (response.payload.byteLength > maximumBytes) {
      throw new Error("secure filesystem broker exceeded the requested read bound")
    }
    return response.payload
  })
}

/** Closes retained native handles and permanently invalidates an opaque directory lease. */
export async function closeSecureDirectory(directory: SecureDirectory): Promise<void> {
  const state = issuedDirectories.get(directory)
  if (state === undefined || state.closed || state.closing) {
    throw new Error("unknown secure filesystem directory handle")
  }
  state.closing = true
  let primary: Error | null = null
  try {
    await state.queue
    await closeNativeHandles(state.session, state.ownedHandleIds)
  } catch (error) {
    if (!nativeHandleInventoryConsumed(error)) {
      state.closing = false
      throw error
    }
    primary = errorValue(error, "secure filesystem close failed")
  }
  state.closed = true
  issuedDirectories.delete(directory)
  let failure: Error | null = primary
  try {
    await releaseSession(state.session)
  } catch (error) {
    const releaseFailure = errorValue(error, "secure filesystem session release failed")
    failure =
      primary === null
        ? releaseFailure
        : new AggregateError(
            [primary, releaseFailure],
            "secure filesystem close and release failed"
          )
  }
  if (failure !== null) {
    consumedDirectoryErrors.add(failure)
    throw failure
  }
}

async function finishConsumedDirectory(
  directory: SecureDirectory,
  state: DirectoryState,
  primary: unknown | null
): Promise<void> {
  const failures: Error[] = []
  if (primary !== null)
    failures.push(errorValue(primary, "secure filesystem directory removal failed"))
  try {
    await closeNativeHandles(state.session, state.ownedHandleIds)
  } catch (error) {
    failures.push(errorValue(error, "secure filesystem ancestor handle cleanup failed"))
  }
  state.closed = true
  issuedDirectories.delete(directory)
  try {
    await releaseSession(state.session)
  } catch (error) {
    failures.push(errorValue(error, "secure filesystem session release failed"))
  }
  if (failures.length === 0) return
  const failure =
    failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "secure filesystem directory removal and teardown failed")
  if (failure === undefined) throw new Error("secure filesystem consumed removal failure was lost")
  consumedDirectoryErrors.add(failure)
  throw failure
}

/** Quarantines and recursively removes one retained private directory tree. */
export async function removeSecureDirectoryTree(directory: SecureDirectory): Promise<void> {
  const state = issuedDirectories.get(directory)
  if (state === undefined || state.closed || state.closing) {
    throw new Error("unknown secure filesystem directory handle")
  }
  state.closing = true
  try {
    await state.queue
  } catch (error) {
    state.closing = false
    throw error
  }
  const leaf = state.ownedHandleIds.at(-1)
  if (leaf === undefined) {
    state.closing = false
    throw new Error("secure filesystem root lease cannot be recursively removed")
  }

  let primary: unknown | null = null
  try {
    await state.session.broker.request(
      RemoveTree,
      leaf,
      0,
      validateComponent(`.cleanup-${randomUUID()}`),
      "remove directory tree"
    )
  } catch (error) {
    if (!(error instanceof SecureFilesystemError && error.status === StatusIncomplete)) {
      state.closing = false
      throw error
    }
    primary = error
  }

  state.ownedHandleIds.pop()
  await finishConsumedDirectory(directory, state, primary)
}
