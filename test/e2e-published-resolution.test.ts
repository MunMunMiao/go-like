import { expect, test } from "bun:test"
import { chmod, cp, lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { runCommand } from "../e2e/harness/process"
import {
  createTempDirectory,
  createTempSubdirectories,
  removeTempDirectory,
  verifyTempDirectory
} from "../e2e/harness/temp"
import {
  copyPublishedFixture,
  createPublishedMtlsFixture,
  parsePublishedJsonValues,
  parseNpmPackOutput,
  parsePublishedNativeRuntimeEvidence,
  parsePublishedMtlsUpstreamEvidence,
  publishedEnvironment,
  runBufMatrix,
  runRuntimeInterop,
  validateInstalledBuf,
  validateInstalledProtocGenLike,
  validatePublishedBrowserBundle,
  validatePublishedNativeMetafile,
  validatePublishedNodeVersion,
  validatePublishedTrace,
  validatePublishedUpstreamMetafile
} from "../e2e/published"

const Fixture = resolve("e2e/fixtures/published-consumer")

function errorMessages(error: unknown): readonly string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(errorMessages)]
  }
  return [error instanceof Error ? error.message : String(error)]
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

async function waitForProcessIds(path: string, signal: AbortSignal): Promise<readonly number[]> {
  const deadline = performance.now() + 500
  while (true) {
    if (signal.aborted) throw signal.reason
    try {
      const values = (await readFile(path, "utf8")).trim().split("\n").map(Number)
      if (values.length === 2 && values.every((pid) => Number.isInteger(pid) && pid > 0)) {
        return values
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error("published server process tree did not become ready")
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", aborted)
          resolve()
        },
        Math.min(10, remaining)
      )
      function aborted(): void {
        clearTimeout(timer)
        signal.removeEventListener("abort", aborted)
        reject(signal.reason)
      }
      signal.addEventListener("abort", aborted, { once: true })
      if (signal.aborted === true) aborted()
    })
  }
}

async function readyFailure(
  source: string,
  options: {
    readonly abortReason?: string
    readonly ignoreSigterm?: boolean
    readonly readyTimeoutMs?: number
  } = {}
): Promise<{
  readonly durationMs: number
  readonly messages: readonly string[]
  readonly pids: readonly number[]
}> {
  const directory = await createTempDirectory("go-like-published-ready-")
  const script = join(directory.path, "server.mjs")
  const pids = join(directory.path, "pids.txt")
  const safety = new AbortController()
  const caller = new AbortController()
  const signal = AbortSignal.any([caller.signal, safety.signal])
  const safetyTimer = setTimeout(
    () => safety.abort(new Error("published ready test safety deadline exceeded")),
    1_500
  )
  try {
    const wait = `${options.ignoreSigterm === true ? 'process.on("SIGTERM", () => {}); ' : ""}setInterval(() => {}, 10_000)`
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process"',
        'import { writeFileSync } from "node:fs"',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(wait)}], { stdio: "ignore" })`,
        `writeFileSync(${JSON.stringify(pids)}, [process.pid, child.pid].join("\\n"))`,
        source,
        wait
      ].join("\n")
    )
    const startedAt = performance.now()
    const interop = runRuntimeInterop(
      process.cwd(),
      directory,
      directory.path,
      {
        tarballs: directory.path,
        nodeOutput: script,
        nativeOutput: script,
        nativeMetafile: script,
        upstreamOutput: script,
        upstreamMetafile: script,
        browserOutput: script,
        browserMetafile: script,
        markers: directory.path
      },
      {},
      script,
      "node",
      "test-version",
      signal,
      options.readyTimeoutMs ?? 250
    )
    let barrierFailure: unknown = null
    let observedPids: readonly number[] | null = null
    if (options.abortReason !== undefined) {
      try {
        observedPids = await waitForProcessIds(pids, signal)
        caller.abort(new Error(options.abortReason))
      } catch (error) {
        barrierFailure = error
      }
    }
    let failure: unknown = null
    try {
      await interop
    } catch (error) {
      failure = error
    }
    if (barrierFailure !== null) throw barrierFailure
    expect(failure).not.toBeNull()
    if (observedPids === null) {
      observedPids = (await readFile(pids, "utf8")).trim().split("\n").map(Number)
    }
    return {
      durationMs: performance.now() - startedAt,
      messages: errorMessages(failure),
      pids: observedPids
    }
  } finally {
    clearTimeout(safetyTimer)
    await removeTempDirectory(directory)
  }
}

async function bufLauncherWithExtraResponse(
  directory: Awaited<ReturnType<typeof createTempDirectory>>,
  extraMethod: "GetOrder" | "UploadEvents"
): Promise<string> {
  const launcher = join(directory.path, "buf")
  await writeFile(
    launcher,
    `#!/usr/bin/env node
const method = process.argv.at(-1).split("/").at(-1)
const outputs = {
  GetOrder: [{ id: "buf-order", state: "READY" }],
  WatchOrders: [
    { orderId: "buf-customer-1", type: "CREATED", sequence: 1 },
    { orderId: "buf-customer-2", type: "READY", sequence: 2 }
  ],
  UploadEvents: [{ count: 3 }],
  SyncOrders: [
    { orderId: "buf-sync-1", type: "ACK:CREATE", sequence: 1 },
    { orderId: "buf-sync-2", type: "ACK:SHIP", sequence: 2 }
  ]
}
if (method === ${JSON.stringify(extraMethod)}) outputs[method].push({ unexpected: true })
process.stdout.write(outputs[method].map((value) => JSON.stringify(value)).join("\\n") + "\\n")
`
  )
  await chmod(launcher, 0o755)
  return launcher
}

test("published JSON parser reads concatenated pretty response objects", () => {
  expect(parsePublishedJsonValues('{\n  "value": "{one}"\n}\n{\n  "value": "two"\n}\n')).toEqual([
    { value: "{one}" },
    { value: "two" }
  ])
  expect(() => parsePublishedJsonValues('{"value":')).toThrow("before its object completed")
  expect(() => parsePublishedJsonValues("[]")).toThrow("must contain objects")
})

test("published native lifecycle evidence requires canonical cancellation and per-call completion", () => {
  const lifecycle = {
    servers: 1,
    serverStreaming: {
      nextCanonical: true,
      handlerCanonical: true
    },
    bidi: {
      nextCanonical: true,
      handlerCanonical: true
    },
    forcedStop: {
      waiterCanonical: true,
      activeNextRejected: true,
      handlerCanonical: true,
      backgroundStop: true,
      running: true
    },
    selectionCompletions: [1, 1, 1],
    handlerFinally: { serverStreaming: 1, bidi: 1, forcedBidi: 1 },
    cleanup: { client: true, server: true, running: true }
  } as const
  const output = {
    kind: "managed-self-test",
    runtime: "node",
    version: "test-version",
    result: {
      unary: { id: "managed-order", state: "READY" },
      serverStreaming: [
        { orderId: "managed-customer-1", type: "CREATED", sequence: 1 },
        { orderId: "managed-customer-2", type: "READY", sequence: 2 }
      ],
      clientStreaming: { count: 3 },
      bidi: [
        { orderId: "sync-1", type: "ACK:CREATE", sequence: 1 },
        { orderId: "sync-2", type: "ACK:SHIP", sequence: 2 }
      ]
    },
    counters: { unary: 1, serverStreaming: 1, clientStreaming: 1, bidi: 1 },
    cleanup: { client: true, server: true, running: true },
    lifecycle,
    faults: {
      canceledRequestsAndClose: {
        preCanceledCardinalities: 4,
        counts: {
          unary: 1,
          upload: 1,
          producer: 1,
          uploadFinally: 1,
          producerFinally: 1,
          unaryFinally: 1,
          serverStreaming: 0,
          bidi: 0
        },
        repeatedClose: true
      },
      gracefulDrain: {
        inflightUnaryCompleted: true,
        messages: 16,
        payloadBytes: 65536,
        delayedReadMs: 2,
        handlerFinally: 1
      },
      peerReset: { receivedPrefix: 1, requests: 1, completions: 1, errorCode: 13 }
    }
  }

  const evidence = parsePublishedNativeRuntimeEvidence(JSON.stringify(output), "node")
  expect(evidence.lifecycle).toEqual(lifecycle)
  expect(() =>
    parsePublishedNativeRuntimeEvidence(
      JSON.stringify({ ...output, lifecycle: { ...lifecycle, selectionCompletions: [3] } }),
      "node"
    )
  ).toThrow("lifecycle")
  expect(() =>
    parsePublishedNativeRuntimeEvidence(
      JSON.stringify({
        ...output,
        lifecycle: {
          ...lifecycle,
          serverStreaming: { ...lifecycle.serverStreaming, nextCanonical: false }
        }
      }),
      "node"
    )
  ).toThrow("lifecycle")
  output.faults.peerReset.errorCode = 0
  expect(() => parsePublishedNativeRuntimeEvidence(JSON.stringify(output), "node")).toThrow(
    "peer reset error code"
  )
  output.faults.peerReset.errorCode = 14
  expect(parsePublishedNativeRuntimeEvidence(JSON.stringify(output), "node").faults).toEqual(
    output.faults
  )
  output.faults.canceledRequestsAndClose.counts.uploadFinally = 0
  expect(() => parsePublishedNativeRuntimeEvidence(JSON.stringify(output), "node")).toThrow(
    "native faults"
  )
})

test("workspace native runtime proves cancellation feedback and forced stop", async () => {
  const result = await runCommand(process.cwd(), {
    cwd: resolve("packages/transport/grpc-buf"),
    command: ["bun", "test/e2e/native-runtime.ts", "self-test"],
    timeoutMs: 30_000
  })
  expect(result.exitCode).toBe(0)
  expect(parsePublishedNativeRuntimeEvidence(result.stdout.trim(), "bun").lifecycle).toEqual({
    servers: 1,
    serverStreaming: { nextCanonical: true, handlerCanonical: true },
    bidi: { nextCanonical: true, handlerCanonical: true },
    forcedStop: {
      waiterCanonical: true,
      activeNextRejected: true,
      handlerCanonical: true,
      backgroundStop: true,
      running: true
    },
    selectionCompletions: [1, 1, 1],
    handlerFinally: { serverStreaming: 1, bidi: 1, forcedBidi: 1 },
    cleanup: { client: true, server: true, running: true }
  })
})

test("portable runtime calls request-streaming methods without entering the Fetch handler", async () => {
  const result = await runCommand(process.cwd(), {
    cwd: resolve("packages/transport/grpc-buf"),
    command: ["bun", "test/e2e/portable-runtime.ts"],
    timeoutMs: 30_000
  })
  expect(result.exitCode).toBe(0)
  const output = JSON.parse(result.stdout.trim()) as { readonly boundaries?: unknown }
  expect(output.boundaries).toEqual({
    connect: {
      clientStreaming: "[unknown] The fetch API does not support streaming request bodies",
      bidi: "[unknown] The fetch API does not support streaming request bodies"
    },
    grpcWeb: {
      clientStreaming: "[unknown] The fetch API does not support streaming request bodies",
      bidi: "[unknown] The fetch API does not support streaming request bodies"
    },
    handlerEntries: { clientStreaming: 0, bidi: 0 }
  })
})

test("published server ready deadline aborts a silent process tree", async () => {
  const result = await readyFailure("")
  expect(result.messages).toContain("node published server ready deadline exceeded 250ms")
  expect(result.durationMs).toBeLessThan(1_000)
  expect(result.pids).toHaveLength(2)
  for (const pid of result.pids) expect(processIsAlive(pid)).toBe(false)
})

test("published malformed server ready aborts its process tree immediately", async () => {
  const result = await readyFailure('process.stdout.write("not-json\\n")')
  expect(result.messages.some((message) => message.includes("JSON"))).toBe(true)
  expect(result.durationMs).toBeLessThan(1_000)
  expect(result.pids).toHaveLength(2)
  for (const pid of result.pids) expect(processIsAlive(pid)).toBe(false)
})

test("published caller abort stays primary while its slow process tree drains", async () => {
  const result = await readyFailure("", {
    abortReason: "published caller canceled before ready",
    ignoreSigterm: true,
    readyTimeoutMs: 1_000
  })
  expect(result.messages).toContain("published caller canceled before ready")
  expect(result.messages.some((message) => message.includes("ready deadline"))).toBe(false)
  expect(result.durationMs).toBeLessThan(3_000)
  expect(result.pids).toHaveLength(2)
  for (const pid of result.pids) expect(processIsAlive(pid)).toBe(false)
}, 5_000)

test("published Buf unary rejects an extra response object", async () => {
  const directory = await createTempDirectory("go-like-published-buf-unary-")
  try {
    const launcher = await bufLauncherWithExtraResponse(directory, "GetOrder")
    await expect(
      runBufMatrix(process.cwd(), directory, directory.path, {}, launcher, "http://127.0.0.1:1/")
    ).rejects.toThrow("published Buf GetOrder must return exactly one response object")
  } finally {
    await removeTempDirectory(directory)
  }
})

test("published Buf client-streaming rejects an extra response object", async () => {
  const directory = await createTempDirectory("go-like-published-buf-upload-")
  try {
    const launcher = await bufLauncherWithExtraResponse(directory, "UploadEvents")
    await expect(
      runBufMatrix(process.cwd(), directory, directory.path, {}, launcher, "http://127.0.0.1:1/")
    ).rejects.toThrow("published Buf UploadEvents must return exactly one response object")
  } finally {
    await removeTempDirectory(directory)
  }
})

test("published fixture stages local Buf and native inputs", async () => {
  const directory = await createTempDirectory("go-like-published-fixture-")
  try {
    await copyPublishedFixture(process.cwd(), directory)
    expect(await Bun.file(join(directory.path, "buf.yaml")).exists()).toBe(true)
    expect(await Bun.file(join(directory.path, "buf.gen.yaml")).exists()).toBe(true)
    expect(await Bun.file(join(directory.path, "proto/published/v1/probe.proto")).exists()).toBe(
      true
    )
    expect(await Bun.file(join(directory.path, "proto/order/v1/order.proto")).exists()).toBe(true)
    expect(await Bun.file(join(directory.path, "browser.ts")).exists()).toBe(true)
    expect(await Bun.file(join(directory.path, "test/e2e/native-harness.ts")).exists()).toBe(true)
    expect(await Bun.file(join(directory.path, "test/e2e/native-faults.ts")).exists()).toBe(true)
    expect(await Bun.file(join(directory.path, "test/e2e/native-runtime.ts")).exists()).toBe(true)
    expect(await Bun.file(join(directory.path, "test/e2e/native-upstream.ts")).exists()).toBe(true)
    const manifest = await Bun.file(join(directory.path, "package.json")).json()
    expect(manifest.scripts).toEqual({ "proto:generate": "buf generate" })
    expect(manifest.devDependencies).toEqual({
      "@bufbuild/buf": "1.72.0",
      "@bufbuild/protoc-gen-es": "2.14.0",
      "@go-like/protoc-gen-like": "0.0.1"
    })
  } finally {
    await removeTempDirectory(directory)
  }
})

test("published mTLS evidence preserves runtime errors and requires every trust rejection", () => {
  const value = {
    kind: "upstream-mtls",
    runtime: "node",
    version: "test-version",
    cases: {
      none: "rejected",
      untrusted: "rejected",
      wrongTrust: "rejected",
      trusted: { id: "mtls-order", state: "READY" }
    },
    cleanup: { managers: 4 },
    rejectionContexts: { noneTimedOut: false, untrustedTimedOut: false, wrongTrustTimedOut: false },
    rejectionErrors: {
      none: { code: 1, message: "[canceled] session closed", cause: null },
      untrusted: {
        code: 10,
        message: "[aborted] session error",
        cause: { name: "Error", message: "TLS alert" }
      },
      wrongTrust: {
        code: 13,
        message: "[internal] certificate verification failed",
        cause: { name: "Error", message: "self-signed certificate in certificate chain" }
      }
    }
  }
  const parse = () =>
    parsePublishedMtlsUpstreamEvidence(JSON.stringify(value), "node", "test-version")
  expect(parse().rejectionErrors).toEqual(value.rejectionErrors)
  expect(parse().managerCleanups).toBe(4)
  value.rejectionErrors.wrongTrust.code = 0
  expect(parse).toThrow("wrongTrust rejection error was invalid")
  value.rejectionErrors.wrongTrust.code = 13
  value.rejectionContexts.wrongTrustTimedOut = true
  expect(parse).toThrow("mTLS rejection contexts")
  value.rejectionContexts.wrongTrustTimedOut = false
  value.cases.wrongTrust = "accepted"
  expect(parse).toThrow("mTLS upstream cases")
})

test("published mTLS fixture proves equivalent clients with isolated chain trust", async () => {
  const directory = await createTempDirectory("go-like-published-mtls-")
  try {
    const fixture = await createPublishedMtlsFixture(
      process.cwd(),
      directory,
      publishedEnvironment(directory.path)
    )
    expect(fixture.opensslVersion).toStartWith("OpenSSL ")
    expect(fixture.evidence.serverIdentity).toEqual({
      dnsLocalhost: true,
      ipLoopback: true,
      serverAuth: true
    })
    expect(fixture.evidence.clientEquivalence).toEqual({
      subject: true,
      spki: true,
      publicKeyAlgorithm: true,
      serial: true,
      validFrom: true,
      validTo: true,
      clientAuth: true
    })
    expect(fixture.evidence.chainTrust).toEqual({
      issuersDifferent: true,
      trustedByTrustedCa: true,
      untrustedByUntrustedCa: true,
      untrustedByTrustedCaRejected: true
    })
    expect((await lstat(fixture.paths.directory)).mode & 0o777).toBe(0o700)
    for (const key of [
      fixture.paths.trustedCaKey,
      fixture.paths.untrustedCaKey,
      fixture.paths.serverKey,
      fixture.paths.clientKey
    ]) {
      expect((await lstat(key)).mode & 0o777).toBe(0o600)
    }
  } finally {
    await removeTempDirectory(directory)
  }
})

test("published Node plugin validates its controller and installed executable contract", async () => {
  expect(() => validatePublishedNodeVersion("v22.0.0")).not.toThrow()
  expect(() => validatePublishedNodeVersion("v21.99.0")).toThrow("Node 22")

  const directory = await createTempDirectory("go-like-published-plugin-")
  try {
    await createTempSubdirectories(directory, [
      ["node_modules"],
      ["node_modules", "@go-like"],
      ["node_modules", "@go-like", "protoc-gen-like"],
      ["node_modules", "@go-like", "protoc-gen-like", "bin"]
    ])
    const packageRoot = join(directory.path, "node_modules/@go-like/protoc-gen-like")
    const manifestPath = join(packageRoot, "package.json")
    const binary = join(packageRoot, "bin/protoc-gen-like.cjs")
    const manifest = {
      engines: { node: ">=22" },
      bin: { "protoc-gen-like": "bin/protoc-gen-like.cjs" }
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(binary, "#!/usr/bin/env node\n", { mode: 0o755 })
    expect(await validateInstalledProtocGenLike(directory.path)).toBe(binary)

    await writeFile(manifestPath, JSON.stringify({ ...manifest, engines: { node: ">=20" } }))
    await expect(validateInstalledProtocGenLike(directory.path)).rejects.toThrow(
      "manifest contract"
    )
    await writeFile(manifestPath, JSON.stringify(manifest))

    await chmod(binary, 0o644)
    await expect(validateInstalledProtocGenLike(directory.path)).rejects.toThrow("not executable")
    await chmod(binary, 0o755)

    await writeFile(binary, "#!/usr/bin/env bun\n")
    await expect(validateInstalledProtocGenLike(directory.path)).rejects.toThrow("Node shebang")

    const outside = join(directory.path, "outside.cjs")
    await writeFile(outside, "#!/usr/bin/env node\n", { mode: 0o755 })
    await unlink(binary)
    await symlink(outside, binary)
    await expect(validateInstalledProtocGenLike(directory.path)).rejects.toThrow("regular file")
  } finally {
    await removeTempDirectory(directory)
  }
})

test("published Buf launcher resolves to its physical package target", async () => {
  const directory = await createTempDirectory("go-like-published-buf-")
  try {
    await createTempSubdirectories(directory, [
      ["node_modules"],
      ["node_modules", "@bufbuild"],
      ["node_modules", "@bufbuild", "buf"],
      ["node_modules", "@bufbuild", "buf", "bin"]
    ])
    await mkdir(join(directory.path, "node_modules/.bin"))
    const packageRoot = join(directory.path, "node_modules/@bufbuild/buf")
    const target = join(packageRoot, "bin/buf")
    const launcher = join(directory.path, "node_modules/.bin/buf")
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ bin: { buf: "./bin/buf" } })
    )
    await writeFile(target, "#!/usr/bin/env node\n", { mode: 0o755 })
    await symlink("../@bufbuild/buf/bin/buf", launcher)
    await expect(validateInstalledBuf(directory.path)).resolves.toBe(launcher)
  } finally {
    await removeTempDirectory(directory)
  }
})

test("published native metafiles accept only their physical stage inputs", async () => {
  const directory = await createTempDirectory("go-like-published-native-meta-")
  try {
    const nativeRequired = [
      "test/e2e/native-runtime.ts",
      "test/e2e/native-harness.ts",
      "test/e2e/native-faults.ts",
      ".artifacts/gen/order/v1/order_pb.ts",
      ".artifacts/gen/order/v1/order_like.ts"
    ]
    const upstreamRequired = [
      "test/e2e/native-upstream.ts",
      ".artifacts/gen/order/v1/order_pb.ts",
      ".artifacts/gen/order/v1/order_like.ts"
    ]
    for (const path of new Set([...nativeRequired, ...upstreamRequired])) {
      const file = join(directory.path, path)
      await mkdir(resolve(file, ".."), { recursive: true })
      await writeFile(file, "export {}\n")
    }
    const nativeMetafile = join(directory.path, "native-runtime.meta.json")
    await writeFile(
      nativeMetafile,
      JSON.stringify({ inputs: Object.fromEntries(nativeRequired.map((path) => [path, {}])) })
    )
    await expect(
      validatePublishedNativeMetafile(directory.path, nativeMetafile)
    ).resolves.toBeUndefined()

    const upstreamMetafile = join(directory.path, "native-upstream.meta.json")
    await writeFile(
      upstreamMetafile,
      JSON.stringify({
        inputs: {
          ...Object.fromEntries(upstreamRequired.map((path) => [path, {}])),
          [resolve("packages/transport/grpc-buf/.artifacts/generated.ts")]: {}
        }
      })
    )
    await expect(
      validatePublishedUpstreamMetafile(directory.path, upstreamMetafile)
    ).rejects.toThrow("escaped its stage")
  } finally {
    await removeTempDirectory(directory)
  }
})

test("published browser bundle requires portable generated inputs and rejects native graph state", async () => {
  const directory = await createTempDirectory("go-like-published-browser-meta-")
  try {
    const required = [
      "browser.ts",
      ".artifacts/gen/published/v1/probe_pb.ts",
      ".artifacts/gen/published/v1/probe_like.ts",
      "node_modules/@go-like/transport-grpc-buf/index.js"
    ]
    for (const path of required) {
      const file = join(directory.path, path)
      await mkdir(resolve(file, ".."), { recursive: true })
      await writeFile(file, "export {}\n")
    }
    const output = join(directory.path, "compiled/browser.js")
    const metafile = join(directory.path, "compiled/browser.meta.json")
    await mkdir(resolve(output, ".."), { recursive: true })
    await writeFile(
      output,
      `export const handler = () => new Response();\n${"/* portable */\n".repeat(32)}`
    )
    const bundledInputs = Object.fromEntries(required.map((path) => [path, { bytesInOutput: 1 }]))
    await writeFile(
      metafile,
      JSON.stringify({
        inputs: Object.fromEntries(required.map((path) => [path, { imports: [] }])),
        outputs: { "./browser.js": { inputs: bundledInputs, imports: [] } }
      })
    )

    const evidence = await validatePublishedBrowserBundle(directory.path, metafile, output)
    expect(evidence.inputCount).toBe(4)
    expect(evidence.portableRoot).toBe(true)
    expect(evidence.generatedGlue).toBe(true)
    expect(evidence.forbiddenModules).toBe(false)
    expect(evidence.bytes).toBeGreaterThan(62)

    await writeFile(
      metafile,
      JSON.stringify({
        inputs: Object.fromEntries(required.map((path) => [path, { imports: [] }])),
        outputs: {
          "./browser.js": {
            inputs: { ...bundledInputs, [required[2]!]: { bytesInOutput: 0 } },
            imports: []
          }
        }
      })
    )
    await expect(validatePublishedBrowserBundle(directory.path, metafile, output)).rejects.toThrow(
      "omitted required input"
    )

    const forbiddenInput = "node_modules/@connectrpc/connect-node/dist/esm/node-transport.js"
    await mkdir(resolve(directory.path, forbiddenInput, ".."), { recursive: true })
    await writeFile(join(directory.path, forbiddenInput), "export {}\n")
    await writeFile(
      metafile,
      JSON.stringify({
        inputs: {
          ...Object.fromEntries(required.map((path) => [path, { imports: [] }])),
          [forbiddenInput]: { imports: [] }
        },
        outputs: { "./browser.js": { inputs: bundledInputs, imports: [] } }
      })
    )
    await expect(validatePublishedBrowserBundle(directory.path, metafile, output)).rejects.toThrow(
      "forbidden native module"
    )

    await writeFile(
      metafile,
      JSON.stringify({
        inputs: Object.fromEntries(required.map((path) => [path, { imports: [] }])),
        outputs: {
          "./browser.js": {
            inputs: bundledInputs,
            imports: [{ path: "node:http2", kind: "import-statement" }]
          }
        }
      })
    )
    await expect(validatePublishedBrowserBundle(directory.path, metafile, output)).rejects.toThrow(
      "forbidden native module"
    )
  } finally {
    await removeTempDirectory(directory)
  }
})

function packOutput(
  files: readonly { readonly path: string; readonly mode?: number }[],
  filename = "go-like-context-0.0.1.tgz"
): string {
  return JSON.stringify([
    {
      name: "@go-like/context",
      filename,
      files: files.map((file) => ({ ...file, mode: file.mode ?? 0o644 }))
    }
  ])
}

test("authoring check depends only on its committed wildcard stub", async () => {
  const directory = await createTempDirectory("go-like-published-authoring-")
  try {
    await cp(Fixture, directory.path, { recursive: true })
    await verifyTempDirectory(directory)
    const command = [
      resolve("node_modules/.bin/tsc"),
      "-p",
      "tsconfig.authoring.json",
      "--pretty",
      "false"
    ]
    const positive = await runCommand(process.cwd(), {
      cwd: directory.path,
      command,
      timeoutMs: 65_000,
      environment: { NODE_OPTIONS: undefined, NODE_PATH: undefined }
    })
    expect(positive.timedOut).toBe(false)
    expect(positive.termination).toBe("exit")
    expect(positive.cleanupFailures).toHaveLength(0)
    expect(positive.exitCode).toBe(0)
    await unlink(join(directory.path, "authoring-stubs/go-like.d.ts"))
    await verifyTempDirectory(directory)
    const negative = await runCommand(process.cwd(), {
      cwd: directory.path,
      command,
      timeoutMs: 65_000,
      environment: { NODE_OPTIONS: undefined, NODE_PATH: undefined }
    })
    expect(negative.timedOut).toBe(false)
    expect(negative.termination).toBe("exit")
    expect(negative.cleanupFailures).toHaveLength(0)
    expect(negative.exitCode).not.toBe(0)
  } finally {
    await removeTempDirectory(directory)
  }
}, 75_000)

test("npm pack JSON accepts a complete safe inventory and rejects archive escapes", () => {
  const valid = [
    { path: "package.json" },
    { path: "index.js" },
    { path: "index.d.ts" },
    { path: "index.js.map" }
  ]
  expect(parseNpmPackOutput(packOutput(valid), "@go-like/context")).toBe(
    "go-like-context-0.0.1.tgz"
  )
  expect(() =>
    parseNpmPackOutput(packOutput([...valid, { path: "../escape" }]), "@go-like/context")
  ).toThrow("unsafe entry")
  expect(() =>
    parseNpmPackOutput(packOutput([...valid, { path: "index.js" }]), "@go-like/context")
  ).toThrow("duplicate entry")
  expect(() =>
    parseNpmPackOutput(packOutput([{ path: "package.json" }]), "@go-like/context")
  ).toThrow("incomplete runtime contract")
  expect(() => parseNpmPackOutput(packOutput(valid, "..\\escape.tgz"), "@go-like/context")).toThrow(
    "unsafe filename"
  )
})

test("published trace accepts only staged resolutions and requires every public package", () => {
  const stage = "/tmp/go-like-published-trace"
  const valid = [
    "======== Module name '@go-like/context' was successfully resolved to '/tmp/go-like-published-trace/node_modules/@go-like/context/index.d.ts'. ========",
    "======== Module name '@go-like/core' was successfully resolved to '/tmp/go-like-published-trace/node_modules/@go-like/core/index.d.ts'. ========"
  ].join("\n")
  expect(() =>
    validatePublishedTrace(valid, stage, ["@go-like/context", "@go-like/core"])
  ).not.toThrow()
  expect(() =>
    validatePublishedTrace(
      valid.replace(
        "/tmp/go-like-published-trace/node_modules/@go-like/context",
        `${process.cwd()}/packages/context/src`
      ),
      stage,
      ["@go-like/context", "@go-like/core"]
    )
  ).toThrow("escaped staged node_modules")
  expect(() =>
    validatePublishedTrace(valid, stage, ["@go-like/context", "@go-like/server"])
  ).toThrow("missed public packages")
})

test("published environment clears ambient module and tool configuration", () => {
  const environment = publishedEnvironment("/stage", {
    PATH: "/bin",
    HOME: "/ambient",
    NODE_PATH: "/ambient/node_modules",
    NODE_OPTIONS: "--require=/ambient/preload.js",
    node_path: "/ambient/lowercase-node-modules",
    NPM_CONFIG_PREFIX: "/ambient/npm",
    npm_config_registry: "https://ambient.invalid",
    BUN_OPTIONS: "--preload=/ambient/preload.ts",
    DENO_AUTH_TOKENS: "secret"
  })
  expect(environment.HOME).toBe("/stage/home")
  expect(environment.NODE_PATH).toBeUndefined()
  expect(environment.NODE_OPTIONS).toBeUndefined()
  expect(environment.node_path).toBeUndefined()
  expect(environment.NPM_CONFIG_PREFIX).toBeUndefined()
  expect(environment.npm_config_registry).toBeUndefined()
  expect(environment.BUN_OPTIONS).toBeUndefined()
  expect(environment.DENO_AUTH_TOKENS).toBeUndefined()
  expect(environment.npm_config_cache).toBe("/stage/cache/npm")
  expect(environment.BUN_INSTALL_CACHE_DIR).toBe("/stage/cache/bun")
  expect(environment.DENO_DIR).toBe("/stage/cache/deno")
  expect(Object.hasOwn(environment, "PATH")).toBe(false)
})
