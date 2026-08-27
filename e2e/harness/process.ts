import { randomBytes } from "node:crypto"
import { closeSync } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import { resolve } from "node:path"

import { finalizeWithCleanup, type CleanupFailure } from "./cleanup"
import { createStreamingRedactor, errorSummary, type StreamingRedactor } from "./diagnostics"
import { errorValue, failureRecord, type FailureRecord } from "./result"

export type ProcessMode = "managed" | "platform-containment"
export type ProcessStrategy = "linux-cgroup-v2" | "posix-anchored-best-effort" | "runtime-managed"
export type ContainmentClaim = "validated" | "not-claimed" | "unsupported"
export type ResidualObservation = "zero-observed" | "present" | "inconclusive" | "n/a"
export type ProcessTermination = "exit" | "signal" | "timeout" | "abort" | "supervisor-error"

export interface ProcessPreflightResult {
  readonly processMode: ProcessMode
  readonly strategy: ProcessStrategy
  readonly containment: ContainmentClaim
  readonly cgroupV2: "available" | "unavailable" | "n/a"
}

export interface CommandResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly termination: ProcessTermination
  readonly timedOut: boolean
  readonly abortReason: string | null
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly cleanupFailures: readonly FailureRecord[]
  readonly containment: ContainmentClaim
  readonly residual: ResidualObservation
}

export interface CommandDefinition {
  readonly cwd: string
  readonly command: readonly string[]
  readonly timeoutMs: number
  readonly terminationPolicy?: "combined" | "hard-only" | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly forwardOutput?: boolean | undefined
  readonly onStdout?: ((value: string) => void) | undefined
  readonly onStderr?: ((value: string) => void) | undefined
  readonly knownSecrets?: readonly string[] | undefined
}

export interface ProcessSupervisor {
  readonly mode: ProcessMode
  readonly preflight: () => Promise<ProcessPreflightResult>
  readonly run: (root: string, definition: CommandDefinition) => Promise<CommandResult>
  readonly close: () => Promise<void>
}

export interface ProcessSupervisorDependencies {
  readonly run?:
    | ((root: string, definition: CommandDefinition) => Promise<CommandResult>)
    | undefined
  readonly compileNativeHelper?: ((root: string) => Promise<string>) | undefined
}

interface StreamCapture {
  readonly done: Promise<void>
  readonly cancel: (reason: unknown) => Promise<void>
  readonly text: () => string
}

interface CaptureOptions {
  readonly captureRedactor: StreamingRedactor
  readonly forwardRedactor?: StreamingRedactor | undefined
  readonly forward?: ((chunk: string) => void) | undefined
}

type TimedSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly reason: unknown }
  | { readonly kind: "aborted"; readonly reason: unknown }
  | { readonly kind: "timeout" }

const SupportsProcessGroups = process.platform === "darwin" || process.platform === "linux"

/** Settles one promise within a caller-owned deadline without leaving an unhandled rejection. */
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<TimedSettlement<T>> {
  return await new Promise<TimedSettlement<T>>(function settle(resolveSettlement) {
    let settled = false
    function finish(settlement: TimedSettlement<T>): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener("abort", aborted)
      resolveSettlement(Object.freeze(settlement))
    }
    function aborted(): void {
      finish({ kind: "aborted", reason: signal?.reason })
    }
    const timeout = setTimeout(function timedOut() {
      finish({ kind: "timeout" })
    }, timeoutMs)
    signal?.addEventListener("abort", aborted, { once: true })
    if (signal?.aborted === true) aborted()
    promise.then(
      function fulfilled(value) {
        finish({ kind: "fulfilled", value })
      },
      function rejected(reason: unknown) {
        finish({ kind: "rejected", reason })
      }
    )
  })
}

/** Captures a subprocess pipe after streaming redaction and retains a cancellation path. */
function captureStream(stream: ReadableStream<Uint8Array>, options: CaptureOptions): StreamCapture {
  const reader = stream.getReader()
  let output = ""
  const done = (async function read(): Promise<void> {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        const safe = options.captureRedactor.write(chunk.value)
        output += safe
        if (options.forwardRedactor !== undefined) {
          const forwarded = options.forwardRedactor.write(chunk.value)
          if (forwarded.length > 0) options.forward?.(forwarded)
        }
      }
      output += options.captureRedactor.end()
      if (options.forwardRedactor !== undefined) {
        const forwarded = options.forwardRedactor.end()
        if (forwarded.length > 0) options.forward?.(forwarded)
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return Object.freeze({
    done,
    async cancel(reason: unknown): Promise<void> {
      await reader.cancel(reason)
    },
    text(): string {
      return output
    }
  })
}

/** Returns whether a POSIX process group still owns at least one process. */
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

/** Sends one argv-safe signal to the complete detached child tree. */
function signalProcessTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (!SupportsProcessGroups) {
    child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    child.kill(signal)
  }
}

/** Terminates an argv-spawned process tree, escalating after a bounded POSIX grace period. */
async function terminateProcessTree(child: Bun.Subprocess): Promise<void> {
  if (!SupportsProcessGroups) {
    child.kill("SIGKILL")
    return
  }
  signalProcessTree(child, "SIGTERM")
  const deadline = performance.now() + 2_000
  while (processGroupExists(child.pid) && performance.now() < deadline) {
    await Bun.sleep(25)
  }
  if (processGroupExists(child.pid)) signalProcessTree(child, "SIGKILL")
}

/** Cancels inherited output pipes without allowing cancellation itself to become unbounded. */
async function cancelCaptures(captures: readonly StreamCapture[], reason: unknown): Promise<void> {
  const cancellation = Promise.allSettled(
    captures.map(function cancel(capture) {
      return capture.cancel(reason)
    })
  )
  const settlement = await settleWithin(cancellation, 1_000)
  if (settlement.kind === "fulfilled") {
    const failures = settlement.value.flatMap((outcome) =>
      outcome.status === "rejected"
        ? [errorValue(outcome.reason, "stream cancellation failed")]
        : []
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "stream cancellation failed")
    return
  }
  if (settlement.kind === "rejected") throw settlement.reason
  if (settlement.kind === "aborted") {
    throw new Error("stream cancellation was aborted", { cause: settlement.reason })
  }
  throw new Error("stream cancellation exceeded 1000ms")
}

function cleanupFailure(label: string, value: unknown): CleanupFailure {
  return Object.freeze({ label, error: errorValue(value, `${label} failed`) })
}

function commandCleanupFailure(
  label: string,
  value: unknown,
  knownSecrets: readonly string[] | undefined
): FailureRecord {
  return failureRecord(
    "process-cleanup-failed",
    "process-cleanup",
    `${label}: ${errorSummary(value, { knownSecrets })}`
  )
}

function unmanagedContainment(): ContainmentClaim {
  return "not-claimed"
}

function legacyResidual(cleanupFailures: readonly FailureRecord[]): ResidualObservation {
  return cleanupFailures.length === 0 ? "zero-observed" : "inconclusive"
}

const NativeHelperSource = "e2e/harness/native/go-like_e2e_posix_controller.c"
const NativeHelperHeader = "e2e/harness/native/go-like_e2e_posix_protocol.h"
const NativeHelperBinary = ".artifacts/e2e-native/go-like-e2e-posix-controller"

const PosixFrameMagic = 0x4c475033
const PosixProtocolVersion = 1
const PosixNonceSize = 32
const PosixHeaderSize = 52
const PosixMaximumBody = 1024 * 1024
const PosixTransitionBudgetMs = 5_000
const PosixControllerOnlyEnvironment = new Set([
  "BUN_FEATURE_FLAG_NO_ORPHANS",
  "GO_LIKE_E2E_CGROUP_PARENT"
])

function closeFileDescriptors(descriptors: readonly (number | null | undefined)[]): void {
  const failures: unknown[] = []
  for (const descriptor of descriptors) {
    if (typeof descriptor !== "number") continue
    try {
      closeSync(descriptor)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, "failed to close caller-owned subprocess descriptors")
  }
}

export interface PosixControllerFrame {
  readonly type: number
  readonly flags: number
  readonly requestId: bigint
  readonly nonce: Uint8Array
  readonly payload: Uint8Array
}

export function encodePosixControllerFrame(frame: PosixControllerFrame): Uint8Array {
  if (frame.nonce.byteLength !== PosixNonceSize) {
    throw new RangeError(`POSIX controller nonce must be ${PosixNonceSize} bytes`)
  }
  if (frame.requestId < 0n || frame.requestId > 0xffffffffffffffffn) {
    throw new RangeError("POSIX controller request ID is outside uint64")
  }
  const bodyLength = PosixHeaderSize + frame.payload.byteLength
  if (bodyLength > PosixMaximumBody) throw new RangeError("POSIX controller frame is too large")
  const wire = new Uint8Array(4 + bodyLength)
  const view = new DataView(wire.buffer)
  view.setUint32(0, bodyLength)
  view.setUint32(4, PosixFrameMagic)
  view.setUint16(8, PosixProtocolVersion)
  view.setUint16(10, frame.type)
  view.setUint32(12, frame.flags)
  view.setBigUint64(16, frame.requestId)
  wire.set(frame.nonce, 24)
  wire.set(frame.payload, 56)
  return wire
}

export function decodePosixControllerFrame(wire: Uint8Array): PosixControllerFrame {
  if (wire.byteLength < 4 + PosixHeaderSize) {
    throw new Error("POSIX controller frame is truncated")
  }
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  const bodyLength = view.getUint32(0)
  if (bodyLength < PosixHeaderSize || bodyLength > PosixMaximumBody) {
    throw new Error("POSIX controller frame length is invalid")
  }
  if (wire.byteLength !== 4 + bodyLength) {
    throw new Error("POSIX controller frame length does not match its prefix")
  }
  if (view.getUint32(4) !== PosixFrameMagic) {
    throw new Error("POSIX controller frame magic is invalid")
  }
  if (view.getUint16(8) !== PosixProtocolVersion) {
    throw new Error("POSIX controller frame version is unsupported")
  }
  return Object.freeze({
    type: view.getUint16(10),
    flags: view.getUint32(12),
    requestId: view.getBigUint64(16),
    nonce: wire.slice(24, 56),
    payload: wire.slice(56)
  })
}

function completePosixWireFrame(buffer: Uint8Array): { wire: Uint8Array; rest: Uint8Array } | null {
  if (buffer.byteLength < 4) return null
  const bodyLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0)
  if (bodyLength < PosixHeaderSize || bodyLength > PosixMaximumBody) {
    throw new Error("POSIX controller frame length is invalid")
  }
  const wireLength = 4 + bodyLength
  if (buffer.byteLength < wireLength) return null
  return Object.freeze({ wire: buffer.slice(0, wireLength), rest: buffer.slice(wireLength) })
}

async function readPosixControllerFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: { value: Uint8Array }
): Promise<PosixControllerFrame> {
  while (true) {
    const complete = completePosixWireFrame(buffered.value)
    if (complete !== null) {
      buffered.value = complete.rest
      return decodePosixControllerFrame(complete.wire)
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error("POSIX controller protocol ended with a truncated frame")
    const combined = new Uint8Array(buffered.value.byteLength + chunk.value.byteLength)
    combined.set(buffered.value)
    combined.set(chunk.value, buffered.value.byteLength)
    buffered.value = combined
  }
}

function payloadU32(payload: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > payload.byteLength) {
    throw new Error("POSIX controller response payload is truncated")
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset)
}

function textPayload(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

async function writePosixControllerFrame(
  writer: Bun.FileSink,
  frame: PosixControllerFrame
): Promise<void> {
  writer.write(encodePosixControllerFrame(frame))
  await writer.flush()
}

function expectPosixFrame(
  frame: PosixControllerFrame,
  type: number,
  requestId: bigint,
  nonce?: Uint8Array
): void {
  if (frame.type === 0x80ff) {
    const errorCode = payloadU32(frame.payload, 0)
    throw new Error(`POSIX controller returned terminal error ${errorCode}`)
  }
  if (frame.type !== type || frame.requestId !== requestId) {
    throw new Error(
      `POSIX controller returned unexpected frame type=${frame.type} requestId=${frame.requestId}`
    )
  }
  if (nonce !== undefined && !frame.nonce.every((value, index) => value === nonce[index])) {
    throw new Error("POSIX controller response nonce changed")
  }
}

interface PosixFrameWaiter {
  readonly type: number
  readonly requestId: bigint
  readonly resolve: (frame: PosixControllerFrame) => void
  readonly reject: (error: unknown) => void
}

class PosixFrameInbox {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #buffered = { value: new Uint8Array() }
  readonly #queued: PosixControllerFrame[] = []
  readonly #waiters: PosixFrameWaiter[] = []
  #terminal: unknown = null

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader
    void this.#pump()
  }

  async #pump(): Promise<void> {
    try {
      while (true) {
        const frame = await readPosixControllerFrame(this.#reader, this.#buffered)
        if (frame.type === 0x80ff) throw posixControllerError(frame)
        const index = this.#waiters.findIndex(
          (waiter) => waiter.type === frame.type && waiter.requestId === frame.requestId
        )
        if (index < 0) this.#queued.push(frame)
        else {
          const waiter = this.#waiters.splice(index, 1)[0]
          waiter?.resolve(frame)
        }
      }
    } catch (error) {
      this.#terminal = error
      for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
    }
  }

  waitFor(type: number, requestId: bigint): Promise<PosixControllerFrame> {
    const queuedIndex = this.#queued.findIndex(
      (frame) => frame.type === type && frame.requestId === requestId
    )
    if (queuedIndex >= 0) {
      const frame = this.#queued.splice(queuedIndex, 1)[0]
      if (frame !== undefined) return Promise.resolve(frame)
    }
    if (this.#terminal !== null) return Promise.reject(this.#terminal)
    return new Promise<PosixControllerFrame>((resolveFrame, rejectFrame) => {
      this.#waiters.push({ type, requestId, resolve: resolveFrame, reject: rejectFrame })
    })
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => {})
  }
}

function posixControllerError(frame: PosixControllerFrame): Error {
  const code = payloadU32(frame.payload, 0)
  const systemError = payloadU32(frame.payload, 4)
  const terminal = payloadU32(frame.payload, 8)
  const messageLength = payloadU32(frame.payload, 12)
  if (16 + messageLength > frame.payload.byteLength) {
    return new Error("POSIX controller returned a truncated ERROR payload")
  }
  const message = new TextDecoder().decode(frame.payload.slice(16, 16 + messageLength))
  return new Error(
    `native-posix-controller-error: code=${code} errno=${systemError} terminal=${terminal} summary=${message}`
  )
}

class PosixPayloadBuilder {
  readonly #chunks: Uint8Array[] = []
  #length = 0

  u32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError("POSIX controller payload value is outside uint32")
    }
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value)
    this.bytes(bytes)
  }

  bytes(value: Uint8Array): void {
    this.#chunks.push(value)
    this.#length += value.byteLength
    if (this.#length + PosixHeaderSize > PosixMaximumBody) {
      throw new RangeError("POSIX controller PREPARE payload is too large")
    }
  }

  string(value: string, label: string): void {
    if (value.includes("\0")) throw new Error(`${label} contains NUL`)
    const encoded = textPayload(value)
    this.u32(encoded.byteLength)
    this.bytes(encoded)
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.#length)
    let offset = 0
    for (const chunk of this.#chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
}

function preparePosixPayload(
  root: string,
  definition: CommandDefinition,
  mode: ProcessMode
): Uint8Array {
  if (definition.command.length === 0 || definition.command[0]?.length === 0) {
    throw new Error("POSIX controller command argv is empty")
  }
  const cwd = resolve(root, definition.cwd)
  for (const key of Object.keys(definition.environment ?? {})) {
    if (PosixControllerOnlyEnvironment.has(key)) {
      throw new Error(`POSIX target environment cannot override controller-only key ${key}`)
    }
  }
  const environment = Object.entries(processEnv(definition.environment))
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !PosixControllerOnlyEnvironment.has(entry[0])
    )
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
  const payload = new PosixPayloadBuilder()
  payload.u32(mode === "platform-containment" ? 2 : 1)
  payload.u32(definition.command.length)
  payload.u32(environment.length)
  payload.string(cwd, "command cwd")
  for (const argument of definition.command) payload.string(argument, "command argument")
  for (const [key, value] of environment) {
    if (key.length === 0 || key.includes("=")) throw new Error(`invalid environment key ${key}`)
    if (key.includes("\0")) throw new Error("environment key contains NUL")
    if (value.includes("\0")) throw new Error("environment value contains NUL")
    const encodedKey = textPayload(key)
    const encodedValue = textPayload(value)
    payload.u32(encodedKey.byteLength)
    payload.u32(encodedValue.byteLength)
    payload.bytes(encodedKey)
    payload.bytes(encodedValue)
  }
  return payload.finish()
}

function parsePosixTargetExit(frame: PosixControllerFrame): {
  readonly exitKind: number
  readonly exitValue: number
} {
  if (frame.payload.byteLength !== 12) throw new Error("TARGET_EXIT payload is invalid")
  const view = new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength
  )
  return Object.freeze({ exitKind: view.getUint32(0), exitValue: view.getInt32(4) })
}

interface PosixAnchorReady {
  readonly mode: ProcessMode
  readonly anchorPid: number
  readonly cgroupIdentity: string
}

function parsePosixAnchorReady(frame: PosixControllerFrame, mode: ProcessMode): PosixAnchorReady {
  if (frame.payload.byteLength < 20) throw new Error("ANCHOR_READY payload is truncated")
  const view = new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength
  )
  const nativeMode = view.getUint32(0)
  const anchorPid = view.getUint32(4)
  const processGroupId = view.getUint32(8)
  const sessionId = view.getUint32(12)
  const identityLength = view.getUint32(16)
  if (
    anchorPid === 0 ||
    processGroupId !== anchorPid ||
    sessionId !== anchorPid ||
    20 + identityLength !== frame.payload.byteLength
  ) {
    throw new Error("ANCHOR_READY identity is invalid")
  }
  if (nativeMode !== (mode === "platform-containment" ? 2 : 1)) {
    throw new Error("ANCHOR_READY process mode changed")
  }
  const cgroupIdentity = new TextDecoder("utf-8", { fatal: true }).decode(frame.payload.slice(20))
  if (mode === "platform-containment" && process.platform === "linux") {
    if (!cgroupIdentity.startsWith("/") || cgroupIdentity.includes("\0")) {
      throw new Error("ANCHOR_READY strict cgroup identity is invalid")
    }
  } else if (cgroupIdentity.length !== 0) {
    throw new Error("ANCHOR_READY unexpectedly reported a cgroup identity")
  }
  return Object.freeze({ mode, anchorPid, cgroupIdentity })
}

interface PosixFinalized {
  readonly residual: ResidualObservation
  readonly termSent: boolean
  readonly killRounds: number
  readonly cgroupPopulated: number
  readonly targetStatusKnown: boolean
  readonly exitKind: number
  readonly exitValue: number
  readonly detail: string
}

function parsePosixFinalized(frame: PosixControllerFrame): PosixFinalized {
  if (frame.payload.byteLength < 40) throw new Error("FINALIZED payload is truncated")
  const view = new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength
  )
  const cleanupResult = view.getUint32(0)
  const termSent = view.getUint32(4)
  const detailLength = view.getUint32(36)
  if (termSent > 1) throw new Error("FINALIZED term_sent is invalid")
  if (40 + detailLength > frame.payload.byteLength) {
    throw new Error("FINALIZED detail is truncated")
  }
  const residual: ResidualObservation =
    cleanupResult === 0 ? "zero-observed" : cleanupResult === 1 ? "present" : "inconclusive"
  return Object.freeze({
    residual,
    termSent: termSent === 1,
    killRounds: view.getUint32(8),
    cgroupPopulated: view.getUint32(20),
    targetStatusKnown: view.getUint32(24) === 1,
    exitKind: view.getUint32(28),
    exitValue: view.getInt32(32),
    detail: new TextDecoder().decode(frame.payload.slice(40, 40 + detailLength))
  })
}

function signalName(signalNumber: number): string {
  for (const [name, number] of Object.entries(osConstants.signals)) {
    if (number === signalNumber) return name
  }
  return `SIG${signalNumber}`
}

function testPosixProtocolRoundTrip(): void {
  const nonce = randomBytes(PosixNonceSize)
  const wire = encodePosixControllerFrame({
    type: 5,
    flags: 0,
    requestId: 1n,
    nonce,
    payload: new Uint8Array([1, 2, 3])
  })
  const decoded = decodePosixControllerFrame(wire)
  if (
    decoded.type !== 5 ||
    decoded.requestId !== 1n ||
    decoded.payload.byteLength !== 3 ||
    !decoded.nonce.every((value, index) => value === nonce[index])
  ) {
    throw new Error("POSIX controller TypeScript protocol self-test failed")
  }
}

async function existingNativeHelper(root: string): Promise<string | null> {
  const binary = resolve(root, NativeHelperBinary)
  try {
    const [binaryEntry, sourceEntry, headerEntry] = await Promise.all([
      stat(binary),
      stat(resolve(root, NativeHelperSource)),
      stat(resolve(root, NativeHelperHeader))
    ])
    if (
      binaryEntry.isFile() &&
      binaryEntry.mtimeMs >= sourceEntry.mtimeMs &&
      binaryEntry.mtimeMs >= headerEntry.mtimeMs
    ) {
      return binary
    }
  } catch {}
  return null
}

async function smokePosixNativeHelper(binary: string, root: string): Promise<void> {
  const controller = Bun.spawn([binary], {
    cwd: root,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "pipe"]
  })
  const controllerStderrDone = new Response(controller.stderr).text()
  const protocolFd = controller.stdio[3]
  const stdoutFd = controller.stdio[4]
  const stderrFd = controller.stdio[5]
  if (
    protocolFd === null ||
    protocolFd === undefined ||
    stdoutFd === null ||
    stdoutFd === undefined ||
    stderrFd === null ||
    stderrFd === undefined
  ) {
    controller.kill("SIGKILL")
    await Promise.allSettled([controller.exited, controllerStderrDone])
    const failure = new Error("POSIX controller smoke extra stdio was not created")
    const cleanupFailures: CleanupFailure[] = []
    try {
      closeFileDescriptors([protocolFd, stdoutFd, stderrFd])
    } catch (error) {
      cleanupFailures.push(cleanupFailure("POSIX controller smoke descriptor cleanup", error))
    }
    finalizeWithCleanup(failure, cleanupFailures, "POSIX controller smoke setup and cleanup failed")
    throw failure
  }
  const protocol = Bun.file(protocolFd).stream().getReader()
  const stdout = Bun.file(stdoutFd).stream().getReader()
  const stderr = Bun.file(stderrFd).stream().getReader()
  const buffered = { value: new Uint8Array() }
  const writer = controller.stdin
  let primary: unknown | null = null
  const readSmokeFrame = async (label: string): Promise<PosixControllerFrame> => {
    const settlement = await settleWithin(
      readPosixControllerFrame(protocol, buffered),
      PosixTransitionBudgetMs
    )
    if (settlement.kind === "fulfilled") return settlement.value
    throw new Error(
      settlement.kind === "rejected"
        ? `POSIX controller smoke ${label} failed: ${errorSummary(settlement.reason)}`
        : `POSIX controller smoke ${label} exceeded ${PosixTransitionBudgetMs}ms`
    )
  }
  try {
    const ready = await readSmokeFrame("CONTROLLER_READY")
    expectPosixFrame(ready, 0x8001, 0n)
    if (ready.payload.byteLength !== 24 || ready.nonce.byteLength !== PosixNonceSize) {
      throw new Error("POSIX controller ready payload is invalid")
    }
    const nonce = ready.nonce
    await writePosixControllerFrame(writer, {
      type: 0x0005,
      flags: 0,
      requestId: 1n,
      nonce,
      payload: new Uint8Array()
    })
    const query = await readSmokeFrame("QUERY")
    expectPosixFrame(query, 0x8006, 1n, nonce)
    await writePosixControllerFrame(writer, {
      type: 0x0007,
      flags: 0,
      requestId: 2n,
      nonce,
      payload: new Uint8Array()
    })
    const closed = await readSmokeFrame("CLOSED")
    expectPosixFrame(closed, 0x8008, 2n, nonce)
    await writer.end()
    const exitCode = await controller.exited
    if (exitCode !== 0) {
      throw new Error(`POSIX controller protocol smoke exited ${exitCode}`)
    }
  } catch (error) {
    if (controller.exitCode === null) controller.kill("SIGKILL")
    const [exitCode, controllerStderr] = await Promise.all([
      controller.exited.catch(() => null),
      controllerStderrDone.catch(() => "")
    ])
    const stderrSummary = errorSummary(controllerStderr)
    const failure = new Error(
      `${errorSummary(error)}; controller exited ${exitCode ?? "unknown"}${stderrSummary.length === 0 ? "" : `: ${stderrSummary}`}`
    )
    primary = failure
    throw failure
  } finally {
    await Promise.resolve(writer.end()).catch(() => {})
    await Promise.allSettled([protocol.cancel(), stdout.cancel(), stderr.cancel()])
    if (controller.exitCode === null) controller.kill("SIGKILL")
    await controller.exited.catch(() => {})
    await controllerStderrDone.catch(() => {})
    const cleanupFailures: CleanupFailure[] = []
    try {
      closeFileDescriptors([protocolFd, stdoutFd, stderrFd])
    } catch (error) {
      cleanupFailures.push(cleanupFailure("POSIX controller smoke descriptor cleanup", error))
    }
    if (cleanupFailures.length > 0) {
      finalizeWithCleanup(primary, cleanupFailures, "POSIX controller smoke and cleanup failed")
    }
  }
}

async function preflightLinuxCgroupNativeHelper(binary: string, root: string): Promise<void> {
  const cgroupParent = process.env.GO_LIKE_E2E_CGROUP_PARENT
  if (cgroupParent === undefined || cgroupParent.length === 0) {
    throw new Error(
      "prerequisite-linux-cgroup-v2-unavailable: GO_LIKE_E2E_CGROUP_PARENT is not set"
    )
  }
  const result = Bun.spawnSync([binary, "--cgroup-preflight", "--cgroup-parent", cgroupParent], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `prerequisite-linux-cgroup-v2-unavailable: ${errorSummary(result.stderr.toString() || result.stdout.toString())}`
    )
  }
}

async function defaultCompileNativeHelper(root: string): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`native POSIX helper is unavailable on ${process.platform}`)
  }
  const existing = await existingNativeHelper(root)
  if (existing !== null) {
    testPosixProtocolRoundTrip()
    await smokePosixNativeHelper(existing, root)
    return existing
  }
  const compiler = Bun.which("cc")
  if (compiler === null)
    throw new Error("prerequisite-native-compiler-unavailable: cc was not found")
  const binary = resolve(root, NativeHelperBinary)
  await mkdir(resolve(root, ".artifacts/e2e-native"), { recursive: true, mode: 0o700 })
  const result = Bun.spawnSync(
    [
      compiler,
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      resolve(root, NativeHelperSource),
      "-o",
      binary
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" }
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `prerequisite-native-helper-build-failed: ${errorSummary(result.stderr.toString() || result.stdout.toString())}`
    )
  }
  const selfTest = Bun.spawnSync([binary, "--self-test"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  if (selfTest.exitCode !== 0) {
    throw new Error(
      `prerequisite-native-helper-self-test-failed: ${errorSummary(selfTest.stderr.toString() || selfTest.stdout.toString())}`
    )
  }
  testPosixProtocolRoundTrip()
  await smokePosixNativeHelper(binary, root)
  return binary
}

function baseCommandResult(
  child: Bun.Subprocess,
  startedAt: number,
  values: {
    readonly exitCode: number | null
    readonly termination: ProcessTermination
    readonly timedOut: boolean
    readonly abortReason: string | null
    readonly stdout: string
    readonly stderr: string
    readonly cleanupFailures: readonly FailureRecord[]
  }
): CommandResult {
  return Object.freeze({
    exitCode: child.signalCode === null ? values.exitCode : null,
    signal:
      values.termination === "timeout" || values.termination === "abort" ? null : child.signalCode,
    termination: values.termination,
    timedOut: values.timedOut,
    abortReason: values.abortReason,
    durationMs: Math.round(performance.now() - startedAt),
    stdout: values.stdout,
    stderr: values.stderr,
    cleanupFailures: Object.freeze(values.cleanupFailures.slice()),
    containment: unmanagedContainment(),
    residual: legacyResidual(values.cleanupFailures)
  })
}

/** Runs one argv-safe detached child tree with a hard owner timeout. */
export async function runCommand(
  root: string,
  definition: CommandDefinition
): Promise<CommandResult> {
  if (definition.signal?.aborted === true) throw definition.signal.reason
  const startedAt = performance.now()
  const sanitizer = Object.freeze({ knownSecrets: definition.knownSecrets })
  const stdoutCaptureRedactor = createStreamingRedactor(sanitizer)
  const stderrCaptureRedactor = createStreamingRedactor(sanitizer)
  const stdoutForwardRedactor =
    definition.forwardOutput === true || definition.onStdout !== undefined
      ? createStreamingRedactor(sanitizer)
      : undefined
  const stderrForwardRedactor =
    definition.forwardOutput === true || definition.onStderr !== undefined
      ? createStreamingRedactor(sanitizer)
      : undefined
  const child = Bun.spawn(definition.command.slice(), {
    cwd: resolve(root, definition.cwd),
    stdout: "pipe",
    stderr: "pipe",
    env: processEnv(definition.environment),
    detached: SupportsProcessGroups
  })
  const stdout = captureStream(child.stdout, {
    captureRedactor: stdoutCaptureRedactor,
    forwardRedactor: stdoutForwardRedactor,
    forward: definition.forwardOutput
      ? (chunk) => {
          definition.onStdout?.(chunk)
          process.stdout.write(chunk)
        }
      : definition.onStdout
  })
  const stderr = captureStream(child.stderr, {
    captureRedactor: stderrCaptureRedactor,
    forwardRedactor: stderrForwardRedactor,
    forward: definition.forwardOutput
      ? (chunk) => {
          definition.onStderr?.(chunk)
          process.stderr.write(chunk)
        }
      : definition.onStderr
  })
  let exitCode: number | null = null
  let exitedAt: number | null = null
  const exited = child.exited.then(function observed(code) {
    exitCode = code
    exitedAt = performance.now()
    return code
  })
  const complete = Promise.all([exited, stdout.done, stderr.done]).then(
    function commandComplete(values) {
      return values[0]
    }
  )
  let abortObserved: unknown = null
  const observeAbort = (): void => {
    abortObserved = definition.signal?.reason
  }
  definition.signal?.addEventListener("abort", observeAbort, { once: true })
  const settlement = await settleWithin(complete, definition.timeoutMs, definition.signal)
  definition.signal?.removeEventListener("abort", observeAbort)
  if (settlement.kind === "fulfilled") {
    if (SupportsProcessGroups && processGroupExists(child.pid)) {
      try {
        await terminateProcessTree(child)
      } catch (cleanupError) {
        throw new AggregateError(
          [new Error("command exited while descendant processes remained"), cleanupError],
          "command exited and process-tree cleanup failed"
        )
      }
      throw new Error("command exited while descendant processes remained")
    }
    const termination: ProcessTermination =
      child.signalCode === null
        ? "exit"
        : abortObserved !== null && exitedAt !== null
          ? "abort"
          : "signal"
    return baseCommandResult(child, startedAt, {
      exitCode: settlement.value,
      termination,
      timedOut: false,
      abortReason:
        termination === "abort"
          ? errorSummary(abortObserved, { knownSecrets: definition.knownSecrets })
          : null,
      stdout: stdout.text(),
      stderr: stderr.text(),
      cleanupFailures: Object.freeze([])
    })
  }

  const reason =
    settlement.kind === "timeout"
      ? new Error(`command exceeded ${definition.timeoutMs}ms`)
      : settlement.kind === "aborted"
        ? settlement.reason
        : new Error("command output capture failed", { cause: settlement.reason })
  const cleanupFailures: CleanupFailure[] = []
  const resultCleanupFailures: FailureRecord[] = []
  try {
    await terminateProcessTree(child)
  } catch (cleanupError) {
    cleanupFailures.push(cleanupFailure("process-tree termination", cleanupError))
    resultCleanupFailures.push(
      commandCleanupFailure("process-tree termination", cleanupError, definition.knownSecrets)
    )
    if (SupportsProcessGroups) {
      try {
        signalProcessTree(child, "SIGKILL")
      } catch (fallbackError) {
        cleanupFailures.push(cleanupFailure("process-tree fallback termination", fallbackError))
        resultCleanupFailures.push(
          commandCleanupFailure(
            "process-tree fallback termination",
            fallbackError,
            definition.knownSecrets
          )
        )
      }
    }
    try {
      child.kill("SIGKILL")
    } catch (directError) {
      cleanupFailures.push(cleanupFailure("direct child termination", directError))
      resultCleanupFailures.push(
        commandCleanupFailure("direct child termination", directError, definition.knownSecrets)
      )
    }
  }
  const drained = await settleWithin(complete, 2_000)
  if (drained.kind !== "fulfilled") {
    try {
      await cancelCaptures([stdout, stderr], reason)
    } catch (captureError) {
      cleanupFailures.push(cleanupFailure("command stream cancellation", captureError))
      resultCleanupFailures.push(
        commandCleanupFailure("command stream cancellation", captureError, definition.knownSecrets)
      )
    }
    const finalDrain = await settleWithin(complete, 1_000)
    if (finalDrain.kind !== "fulfilled") {
      const drainError =
        finalDrain.kind === "rejected"
          ? finalDrain.reason
          : new Error(`command streams did not drain after ${finalDrain.kind}`)
      cleanupFailures.push(cleanupFailure("command stream drain", drainError))
      resultCleanupFailures.push(
        failureRecord(
          "stream-drain-failed",
          "stream-drain",
          errorSummary(drainError, { knownSecrets: definition.knownSecrets })
        )
      )
    }
  }
  if (settlement.kind === "rejected" || settlement.kind === "aborted") {
    if (cleanupFailures.length === 0) throw reason
    finalizeWithCleanup(reason, cleanupFailures, "command failed and cleanup failed")
    throw reason
  }
  if (cleanupFailures.length > 0) {
    finalizeWithCleanup(reason, cleanupFailures, "command timed out and cleanup failed")
  }
  return baseCommandResult(child, startedAt, {
    exitCode,
    termination: "timeout",
    timedOut: true,
    abortReason: null,
    stdout: stdout.text(),
    stderr: stderr.text(),
    cleanupFailures: resultCleanupFailures
  })
}

async function runPosixControlledCommand(
  helperPath: string,
  mode: ProcessMode,
  root: string,
  definition: CommandDefinition
): Promise<CommandResult> {
  if (definition.signal?.aborted === true) throw definition.signal.reason
  const startedAt = performance.now()
  const sanitizer = Object.freeze({ knownSecrets: definition.knownSecrets })
  const stdoutCapture = createStreamingRedactor(sanitizer)
  const stderrCapture = createStreamingRedactor(sanitizer)
  const stdoutForward =
    definition.forwardOutput === true || definition.onStdout !== undefined
      ? createStreamingRedactor(sanitizer)
      : null
  const stderrForward =
    definition.forwardOutput === true || definition.onStderr !== undefined
      ? createStreamingRedactor(sanitizer)
      : null
  let stdout = ""
  let stderr = ""
  const argv = [helperPath]
  if (mode === "platform-containment" && process.platform === "linux") {
    const cgroupParent = process.env.GO_LIKE_E2E_CGROUP_PARENT
    if (cgroupParent === undefined || cgroupParent.length === 0) {
      throw new Error(
        "prerequisite-linux-cgroup-v2-unavailable: GO_LIKE_E2E_CGROUP_PARENT is not set"
      )
    }
    argv.push("--cgroup-parent", cgroupParent)
  }
  const controller = Bun.spawn(argv, {
    cwd: root,
    env: Object.freeze({ ...process.env, GO_LIKE_E2E_CGROUP_PARENT: undefined }),
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "pipe"]
  })
  const controllerStderrDone = new Response(controller.stderr).text()
  const protocolFd = controller.stdio[3]
  const stdoutFd = controller.stdio[4]
  const stderrFd = controller.stdio[5]
  if (
    protocolFd === null ||
    protocolFd === undefined ||
    stdoutFd === null ||
    stdoutFd === undefined ||
    stderrFd === null ||
    stderrFd === undefined
  ) {
    controller.kill("SIGKILL")
    await Promise.allSettled([controller.exited, controllerStderrDone])
    const failure = new Error("native POSIX controller extra stdio was not created")
    const cleanupFailures: CleanupFailure[] = []
    try {
      closeFileDescriptors([protocolFd, stdoutFd, stderrFd])
    } catch (error) {
      cleanupFailures.push(cleanupFailure("native POSIX descriptor cleanup", error))
    }
    finalizeWithCleanup(failure, cleanupFailures, "native POSIX setup and cleanup failed")
    throw failure
  }
  const inbox = new PosixFrameInbox(Bun.file(protocolFd).stream().getReader())
  const writer = controller.stdin
  let requestId = 0n
  let nonce: Uint8Array | null = null
  let targetExit: { readonly exitKind: number; readonly exitValue: number } | null = null
  let finalized: PosixFinalized | null = null
  let streamDrainFailure: FailureRecord | null = null
  let streamDrainInconclusive = false
  let termination: ProcessTermination | null = null
  let abortValue: unknown = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let terminateResolve: (() => void) | null = null
  const terminateRequested = new Promise<void>((resolveTerminate) => {
    terminateResolve = resolveTerminate
  })
  const requestTerminate = (value: ProcessTermination, reason: unknown): void => {
    if (termination !== null) return
    termination = value
    abortValue = reason
    terminateResolve?.()
  }
  const onAbort = (): void => requestTerminate("abort", definition.signal?.reason)
  definition.signal?.addEventListener("abort", onAbort, { once: true })
  timeoutHandle = setTimeout(
    () => requestTerminate("timeout", new Error(`command exceeded ${definition.timeoutMs}ms`)),
    definition.timeoutMs
  )
  const capture = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    redactor: StreamingRedactor,
    forward: StreamingRedactor | null,
    append: (value: string) => void,
    onChunk: ((value: string) => void) | undefined,
    output: NodeJS.WriteStream | null
  ): Promise<void> => {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        append(redactor.write(chunk.value))
        if (forward !== null) {
          const safe = forward.write(chunk.value)
          if (safe.length > 0) {
            onChunk?.(safe)
            output?.write(safe)
          }
        }
      }
      append(redactor.end())
      if (forward !== null) {
        const safe = forward.end()
        if (safe.length > 0) {
          onChunk?.(safe)
          output?.write(safe)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
  const stdoutReader = Bun.file(stdoutFd).stream().getReader()
  const stderrReader = Bun.file(stderrFd).stream().getReader()
  const waitForTransition = async (
    type: number,
    selectedRequestId: bigint,
    label: string
  ): Promise<PosixControllerFrame> => {
    const settlement = await settleWithin(
      inbox.waitFor(type, selectedRequestId),
      PosixTransitionBudgetMs
    )
    if (settlement.kind === "fulfilled") return settlement.value
    const error = new Error(
      settlement.kind === "rejected"
        ? `${label} failed: ${errorSummary(settlement.reason, { knownSecrets: definition.knownSecrets })}`
        : `${label} exceeded the ${PosixTransitionBudgetMs}ms protocol budget`
    )
    requestTerminate("supervisor-error", error)
    throw error
  }
  const stdoutDone = capture(
    stdoutReader,
    stdoutCapture,
    stdoutForward,
    (value) => {
      stdout += value
    },
    definition.onStdout,
    definition.forwardOutput ? process.stdout : null
  )
  const stderrDone = capture(
    stderrReader,
    stderrCapture,
    stderrForward,
    (value) => {
      stderr += value
    },
    definition.onStderr,
    definition.forwardOutput ? process.stderr : null
  )
  void stdoutDone.catch((error) => requestTerminate("supervisor-error", error))
  void stderrDone.catch((error) => requestTerminate("supervisor-error", error))
  let primary: unknown | null = null
  try {
    const ready = await waitForTransition(0x8001, 0n, "CONTROLLER_READY")
    if (ready.payload.byteLength !== 24) throw new Error("CONTROLLER_READY payload is invalid")
    nonce = ready.nonce
    requestId += 1n
    await writePosixControllerFrame(writer, {
      type: 0x0001,
      flags: 0,
      requestId,
      nonce,
      payload: preparePosixPayload(root, definition, mode)
    })
    const anchorReady = await waitForTransition(0x8002, requestId, "ANCHOR_READY")
    expectPosixFrame(anchorReady, 0x8002, requestId, nonce)
    parsePosixAnchorReady(anchorReady, mode)
    requestId += 1n
    await writePosixControllerFrame(writer, {
      type: 0x0002,
      flags: 0,
      requestId,
      nonce,
      payload: new Uint8Array()
    })
    const startedPromise = inbox.waitFor(0x8003, requestId).then((frame) => {
      expectPosixFrame(frame, 0x8003, requestId, nonce ?? undefined)
      return frame
    })
    const exitPromise = inbox.waitFor(0x8004, requestId).then(parsePosixTargetExit)
    void startedPromise.catch(() => {})
    void exitPromise.catch(() => {})
    const launchSettlement = await settleWithin(
      Promise.race([
        startedPromise.then(() => ({ kind: "started" as const })),
        exitPromise.then((value) => ({ kind: "exit" as const, value })),
        terminateRequested.then(() => ({ kind: "terminate" as const }))
      ]),
      PosixTransitionBudgetMs
    )
    if (launchSettlement.kind !== "fulfilled") {
      const error = new Error(
        launchSettlement.kind === "rejected"
          ? `target launch transition failed: ${errorSummary(launchSettlement.reason, { knownSecrets: definition.knownSecrets })}`
          : `target launch transition exceeded the ${PosixTransitionBudgetMs}ms protocol budget`
      )
      requestTerminate("supervisor-error", error)
      throw error
    }
    const launch = launchSettlement.value
    const first =
      launch.kind === "started"
        ? await Promise.race([
            exitPromise.then((value) => ({ kind: "exit" as const, value })),
            terminateRequested.then(() => ({ kind: "terminate" as const }))
          ])
        : launch
    if (first.kind === "exit") targetExit = first.value
    else {
      requestId += 1n
      const hardOnlyTermination =
        definition.terminationPolicy === "hard-only" &&
        (termination === "abort" || termination === "timeout")
      await writePosixControllerFrame(writer, {
        type: hardOnlyTermination ? 0x0008 : 0x0004,
        flags: 0,
        requestId,
        nonce,
        payload: new Uint8Array()
      })
      const finalizedFrame = await waitForTransition(
        0x8005,
        requestId,
        hardOnlyTermination ? "HARD_TERMINATE FINALIZED" : "TERMINATE FINALIZED"
      )
      expectPosixFrame(finalizedFrame, 0x8005, requestId, nonce)
      finalized = parsePosixFinalized(finalizedFrame)
      if (hardOnlyTermination && finalized.termSent) {
        throw new Error("HARD_TERMINATE FINALIZED unexpectedly reported term_sent=1")
      }
      targetExit = finalized.targetStatusKnown
        ? { exitKind: finalized.exitKind, exitValue: finalized.exitValue }
        : null
    }
    if (finalized === null) {
      requestId += 1n
      await writePosixControllerFrame(writer, {
        type: 0x0003,
        flags: 0,
        requestId,
        nonce,
        payload: new Uint8Array()
      })
      const finalizedFrame = await waitForTransition(0x8005, requestId, "FINALIZE")
      expectPosixFrame(finalizedFrame, 0x8005, requestId, nonce)
      finalized = parsePosixFinalized(finalizedFrame)
    }
    requestId += 1n
    await writePosixControllerFrame(writer, {
      type: 0x0007,
      flags: 0,
      requestId,
      nonce,
      payload: new Uint8Array()
    })
    const closed = await waitForTransition(0x8008, requestId, "CLOSED")
    expectPosixFrame(closed, 0x8008, requestId, nonce)
    await writer.end()
    const [controllerExit, controllerStderr] = await Promise.all([
      controller.exited,
      controllerStderrDone
    ])
    const streamsDrained = await settleWithin(Promise.all([stdoutDone, stderrDone]), 2_000)
    if (streamsDrained.kind !== "fulfilled") {
      await Promise.allSettled([
        stdoutReader.cancel(new Error("target stdout did not close after native cleanup")),
        stderrReader.cancel(new Error("target stderr did not close after native cleanup"))
      ])
      const drainFailure =
        streamsDrained.kind === "rejected"
          ? streamsDrained.reason
          : new Error(`target streams did not drain after ${streamsDrained.kind}`)
      streamDrainFailure = failureRecord(
        "stream-drain-failed",
        "stream-drain",
        errorSummary(drainFailure, { knownSecrets: definition.knownSecrets })
      )
      streamDrainInconclusive = streamsDrained.kind === "timeout"
    }
    if (controllerExit !== 0) {
      throw new Error(
        `native POSIX controller exited ${controllerExit}: ${errorSummary(controllerStderr, {
          knownSecrets: definition.knownSecrets
        })}`
      )
    }
    if (finalized === null) {
      throw new Error("native POSIX controller did not report a finalized result")
    }
    const naturalTermination: ProcessTermination =
      targetExit?.exitKind === 1
        ? "exit"
        : targetExit?.exitKind === 2
          ? "signal"
          : "supervisor-error"
    const selectedTermination = (
      termination === null ? naturalTermination : termination
    ) as ProcessTermination
    const cleanupFailures: FailureRecord[] = []
    if (streamDrainFailure !== null) cleanupFailures.push(streamDrainFailure)
    if (finalized.residual === "present") {
      cleanupFailures.push(
        failureRecord("process-residual-present", "process-cleanup", finalized.detail)
      )
    } else if (finalized.residual === "inconclusive") {
      cleanupFailures.push(
        failureRecord("process-residual-inconclusive", "process-cleanup", finalized.detail)
      )
    }
    const residual: ResidualObservation =
      streamDrainInconclusive && finalized.residual === "zero-observed"
        ? "inconclusive"
        : finalized.residual
    const containment: ContainmentClaim =
      mode === "platform-containment" && process.platform === "linux"
        ? finalized.cgroupPopulated === 0 &&
          cleanupFailures.length === 0 &&
          residual === "zero-observed"
          ? "validated"
          : "not-claimed"
        : "not-claimed"
    return Object.freeze({
      exitCode:
        selectedTermination === "exit" && targetExit?.exitKind === 1 ? targetExit.exitValue : null,
      signal:
        selectedTermination === "signal" && targetExit?.exitKind === 2
          ? signalName(targetExit.exitValue)
          : null,
      termination: selectedTermination,
      timedOut: selectedTermination === "timeout",
      abortReason:
        (selectedTermination === "abort" || selectedTermination === "supervisor-error") &&
        abortValue !== null
          ? errorSummary(abortValue, { knownSecrets: definition.knownSecrets })
          : null,
      durationMs: Math.round(performance.now() - startedAt),
      stdout,
      stderr,
      cleanupFailures: Object.freeze(cleanupFailures),
      containment,
      residual
    })
  } catch (error) {
    primary = error
    throw error
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    definition.signal?.removeEventListener("abort", onAbort)
    await Promise.resolve(writer.end()).catch(() => {})
    if (controller.exitCode === null) {
      const nativeShutdown = await settleWithin(controller.exited, 3_000)
      if (nativeShutdown.kind !== "fulfilled" && controller.exitCode === null) {
        controller.kill("SIGKILL")
      }
    }
    await controller.exited.catch(() => {})
    await inbox.cancel().catch(() => {})
    await Promise.allSettled([controllerStderrDone, stdoutDone, stderrDone])
    const cleanupFailures: CleanupFailure[] = []
    try {
      closeFileDescriptors([protocolFd, stdoutFd, stderrFd])
    } catch (error) {
      cleanupFailures.push(cleanupFailure("native POSIX descriptor cleanup", error))
    }
    if (cleanupFailures.length > 0) {
      finalizeWithCleanup(primary, cleanupFailures, "native POSIX execution and cleanup failed")
    }
  }
}

/** Creates one invocation-scoped supervisor before any runtime or suite process can start. */
export async function createProcessSupervisor(
  mode: ProcessMode,
  root: string = process.cwd(),
  dependencies: ProcessSupervisorDependencies = Object.freeze({})
): Promise<ProcessSupervisor> {
  const runner = dependencies.run ?? runCommand
  const compileNativeHelper = dependencies.compileNativeHelper ?? defaultCompileNativeHelper
  let preflighted = false
  let closed = false
  let nativeHelperPath: string | null = null
  const preflightResult: ProcessPreflightResult = Object.freeze({
    processMode: mode,
    strategy:
      mode === "platform-containment" && process.platform === "linux"
        ? "linux-cgroup-v2"
        : SupportsProcessGroups
          ? "posix-anchored-best-effort"
          : "runtime-managed",
    containment: "not-claimed",
    cgroupV2:
      process.platform === "linux"
        ? mode === "platform-containment"
          ? "available"
          : "unavailable"
        : "n/a"
  })
  return Object.freeze({
    mode,
    async preflight(): Promise<ProcessPreflightResult> {
      if (closed) throw new Error("process supervisor is closed")
      if (preflighted) return preflightResult
      if (mode === "platform-containment") {
        if (process.platform !== "linux") {
          throw new Error(
            `platform-containment-unsupported: unsupported platform ${process.platform}`
          )
        }
      }
      if (!SupportsProcessGroups) {
        preflighted = true
        return preflightResult
      }
      nativeHelperPath = await compileNativeHelper(root)
      if (nativeHelperPath.length === 0) {
        throw new Error("prerequisite-native-helper-build-failed: compiler returned no binary path")
      }
      if (mode === "platform-containment" && process.platform === "linux") {
        await preflightLinuxCgroupNativeHelper(nativeHelperPath, root)
      }
      preflighted = true
      return preflightResult
    },
    async run(commandRoot: string, definition: CommandDefinition): Promise<CommandResult> {
      if (!preflighted) throw new Error("process supervisor run requested before preflight")
      if (closed) throw new Error("process supervisor is closed")
      if (dependencies.run !== undefined) return await runner(commandRoot, definition)
      if (!SupportsProcessGroups) return await runner(commandRoot, definition)
      if (nativeHelperPath === null) {
        throw new Error("process supervisor native helper is unavailable after preflight")
      }
      return await runPosixControlledCommand(nativeHelperPath, mode, commandRoot, definition)
    },
    async close(): Promise<void> {
      closed = true
    }
  })
}

/** Runs one command that must finish successfully inside its complete process-tree boundary. */
export async function runCheckedCommand(
  root: string,
  command: readonly string[],
  timeoutMs: number,
  runner: ProcessSupervisor["run"] = runCommand
): Promise<CommandResult> {
  const result = await runner(root, { cwd: ".", command, timeoutMs })
  if (result.timedOut) throw new Error(`command exceeded ${timeoutMs}ms`)
  if (result.termination === "signal") {
    throw new Error(`${command[0] ?? "command"} terminated by ${result.signal ?? "signal"}`)
  }
  if (result.termination !== "exit" || result.exitCode === null) {
    throw new Error(`${command[0] ?? "command"} ended with ${result.termination}`)
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${command[0] ?? "command"} exited ${result.exitCode}: ${result.stderr.slice(-4_000)}`
    )
  }
  return result
}

/** Captures the current environment plus explicit child-only overrides. */
function processEnv(
  overrides: Readonly<Record<string, string | undefined>> = Object.freeze({})
): Readonly<Record<string, string | undefined>> {
  return Object.freeze(
    Object.fromEntries([...Object.entries(process.env), ...Object.entries(overrides)])
  )
}
