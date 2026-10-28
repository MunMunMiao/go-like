import { expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

const Root = resolve(import.meta.dir, "..")
const NativeSource = resolve(Root, "e2e/harness/native/go-like_e2e_posix_filesystem.c")
const Posix = process.platform === "darwin" || process.platform === "linux"

const ProtocolMagic = 0x5346474c
const ProtocolVersion = 1
const ResponseBit = 0x8000
const HeaderSize = 32
const MaximumPayloadBytes = 4 * 1024 * 1024 + 4096

const OpenRoot = 1
const CreatePrivateChild = 3
const OpenPrivateChild = 4
const WriteFile = 6
const ReadFile = 7
const RemoveTree = 8
const CloseHandle = 9
const Shutdown = 10

const StatusOk = 0
const StatusIdentity = 3
const StatusIncomplete = 5

const BeforeCreateChild = 1
const AfterOpenFinal = 4
const AfterTempFsyncBeforeLink = 5
const AfterLinkBeforeTempUnlink = 6
const BeforeCleanupRename = 7
const AfterCleanupRenameBeforeIdentityCheck = 8
const BeforeCleanupUnlink = 9

const Encoder = new TextEncoder()
const Decoder = new TextDecoder()

interface NativeResponse {
  readonly status: number
  readonly errorNumber: number
  readonly value: number
  readonly payload: Uint8Array
}

interface BufferedReader {
  value: Uint8Array
}

interface TestBroker {
  readonly request: (
    opcode: number,
    handleId: number,
    flags?: number,
    payload?: Uint8Array
  ) => Promise<NativeResponse>
  readonly waitForBarrier: (stage: number) => Promise<void>
  readonly releaseBarrier: (stage: number) => Promise<void>
  readonly close: (handles?: readonly number[]) => Promise<void>
  readonly abort: () => Promise<void>
}

function combine(chunks: readonly Uint8Array[]): Uint8Array {
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
    if (chunk.done) throw new Error("native filesystem test broker ended unexpectedly")
    buffered.value = combine([buffered.value, chunk.value])
  }
  const result = buffered.value.slice(0, length)
  buffered.value = buffered.value.slice(length)
  return result
}

function component(value: string): Uint8Array {
  const encoded = Encoder.encode(value)
  if (encoded.byteLength === 0 || encoded.byteLength > 128 || value.includes("/")) {
    throw new Error("invalid test component")
  }
  return encoded
}

function writePayload(temporary: string, final: string, value: Uint8Array): Uint8Array {
  const temporaryBytes = component(temporary)
  const finalBytes = component(final)
  const payload = new Uint8Array(
    8 + temporaryBytes.byteLength + finalBytes.byteLength + value.byteLength
  )
  const view = new DataView(payload.buffer)
  view.setUint16(0, temporaryBytes.byteLength, true)
  view.setUint16(2, finalBytes.byteLength, true)
  view.setUint32(4, value.byteLength, true)
  payload.set(temporaryBytes, 8)
  payload.set(finalBytes, 8 + temporaryBytes.byteLength)
  payload.set(value, 8 + temporaryBytes.byteLength + finalBytes.byteLength)
  return payload
}

function readPayload(final: string): Uint8Array {
  const finalBytes = component(final)
  const payload = new Uint8Array(10 + finalBytes.byteLength)
  const view = new DataView(payload.buffer)
  view.setUint16(0, finalBytes.byteLength, true)
  view.setUint32(2, 4096, true)
  view.setUint32(6, 1000, true)
  payload.set(finalBytes, 10)
  return payload
}

async function compileTestBroker(
  directory: string,
  stage: number,
  extra: readonly string[] = []
): Promise<string> {
  const compiler = Bun.which("cc")
  if (compiler === null) throw new Error("cc is required for native filesystem tests")
  const output = join(directory, `filesystem-broker-${stage}`)
  const compile = Bun.spawnSync(
    [
      compiler,
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      "-DLGFS_TEST_BARRIERS=1",
      `-DLGFS_TEST_BARRIER_STAGE=${stage}`,
      ...extra,
      NativeSource,
      "-o",
      output
    ],
    { cwd: Root, stdout: "pipe", stderr: "pipe" }
  )
  if (compile.exitCode !== 0) {
    throw new Error(
      `native filesystem test broker compilation failed: ${compile.stderr.toString()}`
    )
  }
  return output
}

async function startTestBroker(binary: string): Promise<TestBroker> {
  const child = Bun.spawn([binary, "--broker"], {
    cwd: Root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]
  })
  const notifyFd = child.stdio[3]
  const resumeFd = child.stdio[4]
  if (
    child.stdin === undefined ||
    !(child.stdout instanceof ReadableStream) ||
    notifyFd === null ||
    notifyFd === undefined ||
    resumeFd === null ||
    resumeFd === undefined
  ) {
    child.kill("SIGKILL")
    throw new Error("native filesystem test broker pipes were not created")
  }
  const responseReader = child.stdout.getReader()
  const barrierReader = Bun.file(notifyFd).stream().getReader()
  const barrierWriter = Bun.file(resumeFd).writer()
  const responseBuffer: BufferedReader = { value: new Uint8Array() }
  const barrierBuffer: BufferedReader = { value: new Uint8Array() }
  let requestId = 0n
  const request = async (
    opcode: number,
    handleId: number,
    flags = 0,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ): Promise<NativeResponse> => {
    requestId += 1n
    const header = new Uint8Array(HeaderSize)
    const view = new DataView(header.buffer)
    view.setUint32(0, ProtocolMagic, true)
    view.setUint16(4, ProtocolVersion, true)
    view.setUint16(6, opcode, true)
    view.setBigUint64(8, requestId, true)
    view.setUint32(16, handleId, true)
    view.setUint32(20, flags, true)
    view.setUint32(24, payload.byteLength, true)
    child.stdin.write(combine([header, payload]))
    await child.stdin.flush()

    const responseHeader = await readExactly(responseReader, responseBuffer, HeaderSize)
    const responseView = new DataView(
      responseHeader.buffer,
      responseHeader.byteOffset,
      responseHeader.byteLength
    )
    if (
      responseView.getUint32(0, true) !== ProtocolMagic ||
      responseView.getUint16(4, true) !== ProtocolVersion ||
      responseView.getUint16(6, true) !== (opcode | ResponseBit) ||
      responseView.getBigUint64(8, true) !== requestId
    ) {
      throw new Error("native filesystem test broker returned an invalid response")
    }
    const payloadLength = responseView.getUint32(28, true)
    if (payloadLength > MaximumPayloadBytes) {
      throw new Error("native filesystem test broker exceeded the protocol payload bound")
    }
    const responsePayload = await readExactly(responseReader, responseBuffer, payloadLength)
    return Object.freeze({
      status: responseView.getUint32(16, true),
      errorNumber: responseView.getUint32(20, true),
      value: responseView.getUint32(24, true),
      payload: responsePayload
    })
  }

  return Object.freeze({
    request,
    async waitForBarrier(stage: number): Promise<void> {
      const frame = await readExactly(barrierReader, barrierBuffer, 4)
      expect(
        new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true)
      ).toBe(stage)
    },
    async releaseBarrier(stage: number): Promise<void> {
      const frame = new Uint8Array(4)
      new DataView(frame.buffer).setUint32(0, stage, true)
      barrierWriter.write(frame)
      await barrierWriter.flush()
    },
    async close(handles: readonly number[] = []): Promise<void> {
      for (const handle of handles) {
        const response = await request(CloseHandle, handle)
        expect(response.status).toBe(StatusOk)
      }
      const shutdown = await request(Shutdown, 0)
      expect(shutdown.status).toBe(StatusOk)
      await child.stdin.end()
      await barrierWriter.end()
      const exitCode = await child.exited
      const stderr = await new Response(child.stderr).text()
      expect(exitCode, stderr).toBe(0)
      await Promise.allSettled([responseReader.cancel(), barrierReader.cancel()])
    },
    async abort(): Promise<void> {
      await Promise.resolve(child.stdin.end()).catch(() => {})
      await Promise.resolve(barrierWriter.end()).catch(() => {})
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited.catch(() => {})
      await Promise.allSettled([responseReader.cancel(), barrierReader.cancel()])
    }
  })
}

async function openRoot(broker: TestBroker, path: string): Promise<number> {
  const response = await broker.request(OpenRoot, 0, 0, Encoder.encode(path))
  expect(response.status).toBe(StatusOk)
  expect(Decoder.decode(response.payload)).toBe(path)
  return response.value
}

async function openChild(broker: TestBroker, parent: number, name: string): Promise<number> {
  const response = await broker.request(OpenPrivateChild, parent, 0, component(name))
  expect(response.status).toBe(StatusOk)
  return response.value
}

async function privateRoot(
  directory: string,
  name: string
): Promise<{ readonly root: string; readonly child: string }> {
  const root = await realpath(directory)
  const child = join(root, name)
  await mkdir(child, { mode: 0o700 })
  return Object.freeze({ root, child })
}

async function restoreMovedDirectory(current: string, moved: string): Promise<void> {
  const metadata = await lstat(current).catch(() => null)
  if (metadata?.isSymbolicLink() === true) await unlink(current)
  else if (metadata !== null) await rm(current, { recursive: true, force: true })
  await rename(moved, current)
}

test("native child creation rejects an invocation path swap at the syscall barrier", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-child-"))
  const { root, child: invocation } = await privateRoot(temporary, "invocation")
  const victim = join(root, "victim")
  const moved = join(root, "invocation-moved")
  await mkdir(victim, { mode: 0o700 })
  await writeFile(join(victim, "canary"), "preserve", { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(root, BeforeCreateChild))
    const rootHandle = await openRoot(broker, root)
    const invocationHandle = await openChild(broker, rootHandle, "invocation")
    const creating = broker.request(CreatePrivateChild, invocationHandle, 0, component("results"))
    await broker.waitForBarrier(BeforeCreateChild)
    await rename(invocation, moved)
    await symlink(victim, invocation, "dir")
    await broker.releaseBarrier(BeforeCreateChild)
    const response = await creating
    expect(response.status).toBe(StatusIdentity)
    expect(await Bun.file(join(victim, "results")).exists()).toBe(false)
    expect(await Bun.file(join(victim, "canary")).text()).toBe("preserve")
    expect((await lstat(join(moved, "results"))).isDirectory()).toBe(true)
    await restoreMovedDirectory(invocation, moved)
    await broker.close([invocationHandle, rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native durable publication stays on the retained directory and fails after a path swap", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-write-swap-"))
  const { root, child: results } = await privateRoot(temporary, "results")
  const victim = join(root, "victim")
  const moved = join(root, "results-moved")
  await mkdir(victim, { mode: 0o700 })
  await writeFile(join(victim, "canary"), "preserve", { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(root, AfterTempFsyncBeforeLink))
    const rootHandle = await openRoot(broker, root)
    const resultsHandle = await openChild(broker, rootHandle, "results")
    const writing = broker.request(
      WriteFile,
      resultsHandle,
      0,
      writePayload(".durable-swap.tmp", "result.json", Encoder.encode('{"stable":true}\n'))
    )
    await broker.waitForBarrier(AfterTempFsyncBeforeLink)
    await rename(results, moved)
    await symlink(victim, results, "dir")
    await broker.releaseBarrier(AfterTempFsyncBeforeLink)
    const response = await writing
    expect(response.status).toBe(StatusIdentity)
    expect(await Bun.file(join(victim, "result.json")).exists()).toBe(false)
    expect(await Bun.file(join(victim, ".durable-swap.tmp")).exists()).toBe(false)
    expect(await Bun.file(join(victim, "canary")).text()).toBe("preserve")
    expect(await Bun.file(join(moved, "result.json")).exists()).toBe(false)
    expect(await Bun.file(join(moved, ".durable-swap.tmp")).exists()).toBe(false)
    await restoreMovedDirectory(results, moved)
    await broker.close([resultsHandle, rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native durable publication never follows a final-name symlink collision", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-write-collision-"))
  const { root, child: results } = await privateRoot(temporary, "results")
  const canary = join(root, "canary")
  await writeFile(canary, "preserve", { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(root, AfterTempFsyncBeforeLink))
    const rootHandle = await openRoot(broker, root)
    const resultsHandle = await openChild(broker, rootHandle, "results")
    const writing = broker.request(
      WriteFile,
      resultsHandle,
      0,
      writePayload(".durable-collision.tmp", "result.json", Encoder.encode("replacement\n"))
    )
    await broker.waitForBarrier(AfterTempFsyncBeforeLink)
    await symlink(canary, join(results, "result.json"))
    await broker.releaseBarrier(AfterTempFsyncBeforeLink)
    const response = await writing
    expect(response.status).not.toBe(StatusOk)
    expect(await Bun.file(canary).text()).toBe("preserve")
    expect((await lstat(join(results, "result.json"))).isSymbolicLink()).toBe(true)
    expect(await readdir(results)).toEqual(["result.json"])
    await unlink(join(results, "result.json"))
    await broker.close([resultsHandle, rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native durable publication never removes a replacement temporary entry", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-temp-swap-"))
  const { root, child: results } = await privateRoot(temporary, "results")
  const moved = join(results, "owned.tmp")
  const replacement = join(results, ".durable-temp.tmp")
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(root, AfterLinkBeforeTempUnlink))
    const rootHandle = await openRoot(broker, root)
    const resultsHandle = await openChild(broker, rootHandle, "results")
    const writing = broker.request(
      WriteFile,
      resultsHandle,
      0,
      writePayload(".durable-temp.tmp", "result.json", Encoder.encode("owned\n"))
    )
    await broker.waitForBarrier(AfterLinkBeforeTempUnlink)
    await rename(replacement, moved)
    await writeFile(replacement, "replacement\n", { mode: 0o600 })
    await broker.releaseBarrier(AfterLinkBeforeTempUnlink)
    const response = await writing
    expect(response.status).toBe(StatusIdentity)
    expect(await Bun.file(replacement).text()).toBe("replacement\n")
    expect(await Bun.file(moved).text()).toBe("owned\n")
    expect(await Bun.file(join(results, "result.json")).text()).toBe("owned\n")
    await unlink(replacement)
    await unlink(moved)
    await unlink(join(results, "result.json"))
    await broker.close([resultsHandle, rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native reads reject a final-name inode swap after the no-follow open", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-read-swap-"))
  const { root, child: results } = await privateRoot(temporary, "results")
  const original = join(results, "result.json")
  const replacement = join(results, "replacement.json")
  const moved = join(results, "original.json")
  await writeFile(original, '{"generation":1}\n', { mode: 0o600 })
  await writeFile(replacement, '{"generation":2}\n', { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(root, AfterOpenFinal))
    const rootHandle = await openRoot(broker, root)
    const resultsHandle = await openChild(broker, rootHandle, "results")
    const reading = broker.request(ReadFile, resultsHandle, 0, readPayload("result.json"))
    await broker.waitForBarrier(AfterOpenFinal)
    await rename(original, moved)
    await rename(replacement, original)
    await broker.releaseBarrier(AfterOpenFinal)
    const response = await reading
    expect(response.status).toBe(StatusIdentity)
    expect(response.payload.byteLength).toBe(0)
    expect(await Bun.file(original).text()).toBe('{"generation":2}\n')
    expect(await Bun.file(moved).text()).toBe('{"generation":1}\n')
    await broker.close([resultsHandle, rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native cleanup refuses a replacement entry at the rename barrier", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-cleanup-"))
  const { root, child: invocation } = await privateRoot(temporary, "invocation")
  const moved = join(root, "invocation-moved")
  await writeFile(join(invocation, "owned"), "original", { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(root, BeforeCleanupRename))
    const rootHandle = await openRoot(broker, root)
    const invocationHandle = await openChild(broker, rootHandle, "invocation")
    const removing = broker.request(RemoveTree, invocationHandle, 0, component(".cleanup-race"))
    await broker.waitForBarrier(BeforeCleanupRename)
    await rename(invocation, moved)
    await mkdir(invocation, { mode: 0o700 })
    await writeFile(join(invocation, "canary"), "preserve", { mode: 0o600 })
    await broker.releaseBarrier(BeforeCleanupRename)
    const response = await removing
    expect(response.status).toBe(StatusIncomplete)
    expect(await Bun.file(join(root, ".cleanup-race", "canary")).text()).toBe("preserve")
    expect(await Bun.file(join(moved, "owned")).text()).toBe("original")
    expect(await Bun.file(invocation).exists()).toBe(false)
    const consumed = await broker.request(CloseHandle, invocationHandle)
    expect(consumed.status).toBe(StatusIdentity)
    await rename(join(root, ".cleanup-race"), invocation)
    await rm(invocation, { recursive: true, force: true })
    await rename(moved, invocation)
    await broker.close([rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native cleanup never unlinks a replacement quarantine entry", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-cleanup-unlink-"))
  const { root, child: invocation } = await privateRoot(temporary, "invocation")
  const moved = join(root, "owned-quarantine")
  const quarantine = join(root, ".cleanup-unlink")
  await writeFile(join(invocation, "owned"), "original", { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(root, BeforeCleanupUnlink))
    const rootHandle = await openRoot(broker, root)
    const invocationHandle = await openChild(broker, rootHandle, "invocation")
    const removing = broker.request(RemoveTree, invocationHandle, 0, component(".cleanup-unlink"))
    await broker.waitForBarrier(BeforeCleanupUnlink)
    await rename(quarantine, moved)
    await mkdir(quarantine, { mode: 0o700 })
    await broker.releaseBarrier(BeforeCleanupUnlink)
    const response = await removing
    expect(response.status).toBe(StatusIncomplete)
    expect((await lstat(quarantine)).isDirectory()).toBe(true)
    expect((await lstat(moved)).isDirectory()).toBe(true)
    const consumed = await broker.request(CloseHandle, invocationHandle)
    expect(consumed.status).toBe(StatusIdentity)
    await broker.close([rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

for (const failure of [
  {
    name: "parent fsync",
    define: "-DLGFS_TEST_REMOVE_TREE_PARENT_FSYNC_FAILURE=1"
  },
  {
    name: "leaf close",
    define: "-DLGFS_TEST_REMOVE_TREE_CLOSE_FAILURE=1"
  }
] as const) {
  test(`native cleanup consumes the leaf after irreversible ${failure.name} failure`, async () => {
    if (!Posix) return
    const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-cleanup-commit-"))
    const { root, child: invocation } = await privateRoot(temporary, "invocation")
    await writeFile(join(invocation, "owned"), "original", { mode: 0o600 })
    let broker: TestBroker | null = null
    try {
      broker = await startTestBroker(
        await compileTestBroker(root, BeforeCreateChild, [failure.define])
      )
      const rootHandle = await openRoot(broker, root)
      const invocationHandle = await openChild(broker, rootHandle, "invocation")
      const response = await broker.request(
        RemoveTree,
        invocationHandle,
        0,
        component(".cleanup-commit")
      )
      expect(response.status).toBe(StatusIncomplete)
      expect(response.errorNumber).not.toBe(0)
      expect(await Bun.file(invocation).exists()).toBe(false)
      expect(await Bun.file(join(root, ".cleanup-commit")).exists()).toBe(false)
      const consumed = await broker.request(CloseHandle, invocationHandle)
      expect(consumed.status).toBe(StatusIdentity)
      await broker.close([rootHandle])
      broker = null
    } finally {
      await broker?.abort()
      await rm(temporary, { recursive: true, force: true })
    }
  })
}

test("native cleanup keeps the leaf active when a pre-commit failure is rolled back", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-cleanup-restore-"))
  const { root, child: invocation } = await privateRoot(temporary, "invocation")
  await writeFile(join(invocation, "owned"), "original", { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(
      await compileTestBroker(root, BeforeCreateChild, [
        "-DLGFS_TEST_REMOVE_TREE_PRECOMMIT_FAILURE=1"
      ])
    )
    const rootHandle = await openRoot(broker, root)
    const invocationHandle = await openChild(broker, rootHandle, "invocation")
    const response = await broker.request(
      RemoveTree,
      invocationHandle,
      0,
      component(".cleanup-restore")
    )
    expect(response.status).not.toBe(StatusOk)
    expect(response.status).not.toBe(StatusIncomplete)
    expect(await Bun.file(join(invocation, "owned")).text()).toBe("original")
    expect(await Bun.file(join(root, ".cleanup-restore")).exists()).toBe(false)
    const closeLeaf = await broker.request(CloseHandle, invocationHandle)
    expect(closeLeaf.status).toBe(StatusOk)
    await broker.close([rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native cleanup consumes the leaf when a pre-commit failure cannot be rolled back", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-cleanup-rollback-"))
  const { root, child: invocation } = await privateRoot(temporary, "invocation")
  await writeFile(join(invocation, "owned"), "original", { mode: 0o600 })
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(
      await compileTestBroker(root, AfterCleanupRenameBeforeIdentityCheck, [
        "-DLGFS_TEST_REMOVE_TREE_PRECOMMIT_FAILURE=1",
        "-DLGFS_TEST_REMOVE_TREE_RESTORE_FAILURE=1"
      ])
    )
    const rootHandle = await openRoot(broker, root)
    const invocationHandle = await openChild(broker, rootHandle, "invocation")
    const removing = broker.request(RemoveTree, invocationHandle, 0, component(".cleanup-rollback"))
    await broker.waitForBarrier(AfterCleanupRenameBeforeIdentityCheck)
    await broker.releaseBarrier(AfterCleanupRenameBeforeIdentityCheck)
    const response = await removing
    expect(response.status).toBe(StatusIncomplete)
    expect(response.errorNumber).not.toBe(0)
    expect(await Bun.file(invocation).exists()).toBe(false)
    expect(await Bun.file(join(root, ".cleanup-rollback", "owned")).text()).toBe("original")
    const consumed = await broker.request(CloseHandle, invocationHandle)
    expect(consumed.status).toBe(StatusIdentity)
    await broker.close([rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("native close failure consumes the handle and does not block session teardown", async () => {
  if (!Posix) return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-close-"))
  const { root } = await privateRoot(temporary, "results")
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(
      await compileTestBroker(root, BeforeCreateChild, ["-DLGFS_TEST_CLOSE_HANDLE_FAILURE=1"])
    )
    const rootHandle = await openRoot(broker, root)
    const resultsHandle = await openChild(broker, rootHandle, "results")
    const response = await broker.request(CloseHandle, resultsHandle)
    expect(response.status).toBe(StatusIncomplete)
    expect(response.errorNumber).not.toBe(0)
    const consumed = await broker.request(CloseHandle, resultsHandle)
    expect(consumed.status).toBe(StatusIdentity)
    await broker.close([rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("Darwin canonical temp aliases resolve before native root bootstrap", async () => {
  if (process.platform !== "darwin") return
  const lexical = tmpdir()
  const canonical = await realpath(lexical)
  expect(canonical.startsWith("/")).toBe(true)
  if (lexical === "/var" || lexical.startsWith("/var/")) {
    expect(canonical === "/private/var" || canonical.startsWith("/private/var/")).toBe(true)
  }
  const temporary = await mkdtemp(join(canonical, "go-like-fs-native-canonical-"))
  let broker: TestBroker | null = null
  try {
    broker = await startTestBroker(await compileTestBroker(temporary, BeforeCreateChild))
    const rootHandle = await openRoot(broker, canonical)
    expect(relative(canonical, temporary)).not.toStartWith("..")
    await broker.close([rootHandle])
    broker = null
  } finally {
    await broker?.abort()
    await rm(temporary, { recursive: true, force: true })
  }
})

test("Linux path recovery uses procfs and fails closed when its configured root is unavailable", async () => {
  if (process.platform !== "linux") return
  const temporary = await mkdtemp(join(tmpdir(), "go-like-fs-native-proc-"))
  const canonical = await realpath(temporary)
  let working: TestBroker | null = null
  let unavailable: TestBroker | null = null
  try {
    working = await startTestBroker(await compileTestBroker(canonical, BeforeCreateChild))
    const rootHandle = await openRoot(working, canonical)
    await working.close([rootHandle])
    working = null

    unavailable = await startTestBroker(
      await compileTestBroker(canonical, BeforeCreateChild, [
        '-DLGFS_PROC_SELF_FD_ROOT="/go-like-e2e-proc-unavailable"'
      ])
    )
    const response = await unavailable.request(OpenRoot, 0, 0, Encoder.encode(canonical))
    expect(response.status).toBe(StatusIdentity)
    expect(response.errorNumber).not.toBe(0)
    expect(response.value).toBe(22)
    await unavailable.close()
    unavailable = null
  } finally {
    await working?.abort()
    await unavailable?.abort()
    await rm(canonical, { recursive: true, force: true })
  }
})
