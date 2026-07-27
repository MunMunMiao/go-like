import { readFileSync } from "node:fs"

import type { PublishedBusinessCaseRegistry } from "../../../scripts/published/business-cases"
import { identityRuntimeModule, identityTypeConsumer } from "./identity"

const runtimeTranspiler = new Bun.Transpiler({ loader: "ts" })

const RuntimeTestHarness = String.raw`
import assert from "node:assert/strict"

const likegoPublishedCases = []

function describe(_name, register) { register() }
function test(name, invoke) { likegoPublishedCases.push({ name, invoke }) }
test.each = (values) => (name, invoke) => {
  for (const value of values) test(name.replace("%s", String(value)), () => invoke(value))
}

function partial(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected)
  if (actual === null || typeof actual !== "object") return false
  for (const key of Reflect.ownKeys(expected)) {
    if (!partial(Reflect.get(actual, key), Reflect.get(expected, key))) return false
  }
  return true
}

function deeplyEqual(actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected)
    return true
  } catch {
    return false
  }
}

function matchesThrown(error, expected) {
  if (expected === undefined) return true
  if (typeof expected === "string") return error instanceof Error && error.message.includes(expected)
  if (typeof expected === "function") return error instanceof expected
  return partial(error, expected)
}

function requireThrown(invoke, expected) {
  let thrown = false
  let observed
  try { invoke() } catch (error) { thrown = true; observed = error }
  assert.equal(thrown, true, "expected function to throw")
  assert.equal(matchesThrown(observed, expected), true, "thrown value did not match")
}

function baseExpectation(value, inverted = false) {
  function verify(condition, message) {
    assert.equal(inverted ? !condition : condition, true, message)
  }
  return {
    toBe(expected) { verify(Object.is(value, expected), "toBe failed") },
    toEqual(expected) { verify(deeplyEqual(value, expected), "toEqual failed") },
    toMatchObject(expected) { verify(partial(value, expected), "toMatchObject failed") },
    toBeInstanceOf(expected) { verify(value instanceof expected, "toBeInstanceOf failed") },
    toBeNull() { verify(value === null, "toBeNull failed") },
    toBeUndefined() { verify(value === undefined, "toBeUndefined failed") },
    toHaveLength(expected) { verify(value !== null && value !== undefined && value.length === expected, "toHaveLength failed") },
    toContain(expected) { verify(value !== null && value !== undefined && value.includes(expected), "toContain failed") },
    toContainEqual(expected) { verify(value !== null && value !== undefined && Array.from(value).some((entry) => deeplyEqual(entry, expected)), "toContainEqual failed") },
    toBeTrue() { verify(value === true, "toBeTrue failed") },
    toBeFalse() { verify(value === false, "toBeFalse failed") },
    toBeFunction() { verify(typeof value === "function", "toBeFunction failed") },
    toBeGreaterThanOrEqual(expected) { verify(value >= expected, "toBeGreaterThanOrEqual failed") },
    toThrow(expected) {
      if (inverted) {
        let threw = false
        try { value() } catch { threw = true }
        assert.equal(threw, false, "expected function not to throw")
        return
      }
      requireThrown(value, expected)
    }
  }
}

async function promiseOutcome(value, expectRejection) {
  try {
    const resolved = await value
    assert.equal(expectRejection, false, "expected promise rejection")
    return resolved
  } catch (error) {
    assert.equal(expectRejection, true, "expected promise resolution")
    return error
  }
}

function promisedExpectation(value, expectRejection) {
  return {
    async toBe(expected) { assert.equal(Object.is(await promiseOutcome(value, expectRejection), expected), true) },
    async toEqual(expected) { assert.equal(deeplyEqual(await promiseOutcome(value, expectRejection), expected), true) },
    async toBeUndefined() { assert.equal(await promiseOutcome(value, expectRejection), undefined) },
    async toBeInstanceOf(expected) { assert.equal(await promiseOutcome(value, expectRejection) instanceof expected, true) },
    async toMatchObject(expected) { assert.equal(partial(await promiseOutcome(value, expectRejection), expected), true) },
    async toThrow(expected) { assert.equal(matchesThrown(await promiseOutcome(value, expectRejection), expected), true) }
  }
}

function expect(value) {
  const base = baseExpectation(value)
  Object.defineProperties(base, {
    not: { enumerable: true, value: baseExpectation(value, true) },
    resolves: { enumerable: true, value: promisedExpectation(value, false) },
    rejects: { enumerable: true, value: promisedExpectation(value, true) }
  })
  return base
}
`

/** Transpiles one authoritative TypeScript lifecycle suite into a runner-neutral published case. */
function authoritativeRuntimeModule(
  path: string,
  packageName: string,
  supplemental = "",
  transformSource: (source: string) => string = (source) => source,
  packageImport = 'from "../src/index"'
): string {
  const testImport = 'import { describe, expect, test } from "bun:test"\n\n'
  let source = transformSource(readFileSync(new URL(path, import.meta.url), "utf8"))
  source = source.replace(testImport, "")
  source = source.replaceAll(packageImport, `from "${packageName}"`)
  const transpiled = runtimeTranspiler.transformSync(source)
  const sleepShim =
    "const Bun = Object.freeze({ sleep(timeoutMs) { return new Promise((resolve) => setTimeout(resolve, timeoutMs)) } })"
  return `${RuntimeTestHarness}\n${sleepShim}\n${transpiled}\n${supplemental}\nexport async function run() {\n  for (const subject of likegoPublishedCases) await subject.invoke()\n}\n`
}

/** Keeps the timer-clear proof meaningful without relying on a scheduler-fragile two-millisecond window. */
function stabilizeNatsTimerClearProof(source: string): string {
  const original = `Timeout(2))
    const running = server.start(background())
    await nextTurn()
    await server.stop(background())
    await running
    await Bun.sleep(5)`
  const stable = `Timeout(100))
    const running = server.start(background())
    await nextTurn()
    await server.stop(background())
    await running
    await Bun.sleep(150)`
  const first = source.indexOf(original)
  if (first === -1 || first !== source.lastIndexOf(original)) {
    throw new Error("NATS timer-clear authority must contain exactly one recognized proof")
  }
  return source.replace(original, stable)
}

const NatsCorePublishedCoverage = String.raw`
test("published coverage observes a deadline crossed during asynchronous drain settlement", async () => {
  const subscription = new FakeSubscription()
  subscription.drainOperation = async () => {
    await Promise.resolve()
    block(5)
  }
  const server = newNatsCoreServer(subscription, natsCoreDrainTimeout(1))
  const running = server.start(background())
  await nextTurn()
  const failure = await server.stop(background()).catch((value) => value)
  expect(failure).toMatchObject({ code: "LIKEGO_NATS_CORE_DRAIN_TIMEOUT" })
  await expect(running).rejects.toBe(failure)
})

test("published coverage keeps repeated owner timeout callbacks idempotent", async () => {
  const subscription = new FakeSubscription()
  const drainGate = deferred()
  subscription.drainOperation = () => drainGate.promise
  const server = newNatsCoreServer(subscription, natsCoreDrainTimeout(60_000))
  const running = server.start(background())
  await nextTurn()
  const originalSetTimeout = globalThis.setTimeout
  let timeoutCallback = null
  globalThis.setTimeout = (handler, timeout, ...args) => {
    const timer = originalSetTimeout(handler, timeout, ...args)
    if (timeout === 60_000 && typeof handler === "function") {
      timeoutCallback = () => { handler(...args) }
    }
    return timer
  }
  try {
    const stopping = server.stop(background()).catch((value) => value)
    await nextTurn()
    expect(timeoutCallback).not.toBeNull()
    timeoutCallback()
    timeoutCallback()
    drainGate.resolve()
    const failure = await stopping
    expect(failure).toMatchObject({ code: "LIKEGO_NATS_CORE_DRAIN_TIMEOUT" })
    await expect(running).rejects.toBe(failure)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})
`

const NatsJetStreamPublishedCoverage = String.raw`
test("published coverage observes a deadline crossed during asynchronous close settlement", async () => {
  const messages = new FakeConsumerMessages()
  messages.closeOperation = async () => {
    await Promise.resolve()
    block(5)
  }
  const server = newNatsJetStreamServer(messages, natsJetStreamCloseTimeout(1))
  const running = server.start(background())
  await nextTurn()
  const failure = await server.stop(background()).catch((value) => value)
  expect(failure).toMatchObject({ code: "LIKEGO_NATS_JETSTREAM_CLOSE_TIMEOUT" })
  await expect(running).rejects.toBe(failure)
})

test("published coverage keeps repeated owner timeout callbacks idempotent", async () => {
  const messages = new FakeConsumerMessages()
  const closeGate = deferred()
  messages.closeOperation = () => closeGate.promise
  const server = newNatsJetStreamServer(messages, natsJetStreamCloseTimeout(60_000))
  const running = server.start(background())
  await nextTurn()
  const originalSetTimeout = globalThis.setTimeout
  let timeoutCallback = null
  globalThis.setTimeout = (handler, timeout, ...args) => {
    const timer = originalSetTimeout(handler, timeout, ...args)
    if (timeout === 60_000 && typeof handler === "function") {
      timeoutCallback = () => { handler(...args) }
    }
    return timer
  }
  try {
    const stopping = server.stop(background()).catch((value) => value)
    await nextTurn()
    expect(timeoutCallback).not.toBeNull()
    timeoutCallback()
    timeoutCallback()
    closeGate.resolve()
    const failure = await stopping
    expect(failure).toMatchObject({ code: "LIKEGO_NATS_JETSTREAM_CLOSE_TIMEOUT" })
    await expect(running).rejects.toBe(failure)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})
`

/** Exercises the public Web Node Server through its real listener. */
export function webNodeRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import { newNodeServer, port } from "@likego/web/node"

export async function run() {
  const server = newNodeServer(() => new Response("published web"), port(0))
  const endpoint = await server.endpoint(background())
  const running = server.start(background())
  const response = await fetch(endpoint)
  if (response.status !== 200 || await response.text() !== "published web") {
    throw new Error("published Web Node exchange changed")
  }
  await server.stop(background())
  await running
}
`
}

/** Reads one runner-neutral package-name-only published runtime fixture. */
function runtimeFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

/** Removes TypeScript test imports before one consolidated package-name-only published rewrite. */
function sourceWithoutImports(path: string): string {
  const lines = readFileSync(new URL(path, import.meta.url), "utf8").split("\n")
  const retained: string[] = []
  let skipping = false
  for (const line of lines) {
    if (!skipping && line.startsWith("import ")) {
      skipping = !line.includes(" from ")
      continue
    }
    if (skipping) {
      if (line.includes(" from ")) skipping = false
      continue
    }
    retained.push(line)
  }
  return retained.join("\n")
}

/** Exercises public provisional rollback and message ownership branches omitted by package suites. */
function natsBrokerSupplemental(kind: "core" | "jetstream"): string {
  const admission =
    kind === "core"
      ? `
test("published Core Broker bounds a provisional rollback terminal wait", async () => {
  const subscription = new FakeSubscription()
  subscription.unsubscribe = () => { subscription.unsubscribeCalls += 1 }
  const [ctx, cancel] = withCancelCause(background())
  const primary = new Error("published Core admission canceled")
  const connection = {
    publish() {},
    subscribe() {
      cancel(primary)
      return subscription
    }
  }
  const originalSetTimeout = globalThis.setTimeout
  let timeoutCallback = null
  globalThis.setTimeout = ((handler, timeout, ...args) => {
    const timer = originalSetTimeout(handler, timeout, ...args)
    if (timeout === 25_000 && typeof handler === "function") {
      timeoutCallback = () => { handler(...args) }
    }
    return timer
  })
  try {
    const pending = newNatsCoreBroker(connection).subscribe(ctx, "events", () => {})
    await nextTurn()
    expect(subscription.unsubscribeCalls).toBe(1)
    expect(timeoutCallback).not.toBeNull()
    timeoutCallback()
    const failure = await pending.catch((value) => value)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toMatchObject({
      code: "LIKEGO_NATS_CORE_DRAIN_TIMEOUT",
      timeoutMs: 25_000,
      forced: true
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})
`
      : `
test("published JetStream Broker bounds a provisional rollback terminal wait", async () => {
  const messages = new FakeConsumerMessages()
  messages.stop = () => { messages.stopCalls += 1 }
  const [ctx, cancel] = withCancelCause(background())
  const primary = new Error("published JetStream admission canceled")
  const client = { publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false }) }
  const broker = newNatsJetStreamBroker(client, () => {
    cancel(primary)
    return messages
  })
  const originalSetTimeout = globalThis.setTimeout
  let timeoutCallback = null
  globalThis.setTimeout = ((handler, timeout, ...args) => {
    const timer = originalSetTimeout(handler, timeout, ...args)
    if (timeout === 25_000 && typeof handler === "function") {
      timeoutCallback = () => { handler(...args) }
    }
    return timer
  })
  try {
    const pending = broker.subscribe(ctx, "events", () => {})
    await nextTurn()
    expect(messages.stopCalls).toBe(1)
    expect(timeoutCallback).not.toBeNull()
    timeoutCallback()
    const failure = await pending.catch((value) => value)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors[0]).toBe(primary)
    expect(failure.errors[1]).toMatchObject({
      code: "LIKEGO_NATS_JETSTREAM_CLOSE_TIMEOUT",
      timeoutMs: 25_000,
      forced: true
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test("published JetStream Broker exposes defensive message bytes", async () => {
  const messages = new FakeConsumerMessages()
  const client = { publish: async () => ({ stream: "EVENTS", seq: 1, duplicate: false }) }
  const broker = newNatsJetStreamBroker(client, () => messages)
  let firstBody = null
  let secondBody = null
  const handle = await broker.subscribe(background(), "events", (_ctx, event) => {
    firstBody = event.message.body
    firstBody[0] = 99
    secondBody = event.message.body
  })
  const settlement = { ack: 0, nak: 0, term: 0 }
  const native = jetStreamMessage("events", [4, 5], settlement)
  messages.push(native)
  await nextTurn()
  expect(firstBody).toEqual(new Uint8Array([99, 5]))
  expect(secondBody).toEqual(new Uint8Array([4, 5]))
  expect(native.data).toEqual(new Uint8Array([4, 5]))
  await handle.unsubscribe(background())
})
`
  return admission
}

/** Replays one typed NATS Broker suite through only its installed public subpath. */
function natsBrokerRuntimeModule(kind: "core" | "jetstream"): string {
  const target = kind === "core" ? "@likego/nats/broker" : "@likego/nats/jetstream/broker"
  const factory = kind === "core" ? "newNatsCoreBroker" : "newNatsJetStreamBroker"
  const test = kind === "core" ? "broker.test.ts" : "jetstream-broker.test.ts"
  const imports = `
import { background, withCancelCause } from "@likego/context"
import { headers } from "@nats-io/transport-node"
import { ${factory} } from "${target}"
`
  const source = [
    imports,
    sourceWithoutImports("../../../packages/nats/test/broker-helpers.ts"),
    `{\n${sourceWithoutImports(`../../../packages/nats/test/${test}`)}\n}`,
    natsBrokerSupplemental(kind)
  ].join("\n")
  return `${RuntimeTestHarness}\n${runtimeTranspiler.transformSync(source)}\nexport async function run() {\n  for (const subject of likegoPublishedCases) await subject.invoke()\n}\n`
}

/** Uses the package's reviewed compile-time Broker consumer against its final subpath. */
function natsBrokerTypeConsumer(kind: "core" | "jetstream"): string {
  const file = kind === "core" ? "broker-public-types.ts" : "jetstream-broker-public-types.ts"
  const target = kind === "core" ? "@likego/nats/broker" : "@likego/nats/jetstream/broker"
  const relative = kind === "core" ? '"../src/broker"' : '"../src/jetstream-broker"'
  return readFileSync(
    new URL(`../../../packages/nats/test/${file}`, import.meta.url),
    "utf8"
  ).replaceAll(relative, JSON.stringify(target))
}

/** Transpiles the BullMQ authoritative suites against the packed root export. */
function bullMqRuntimeModule(supplemental = ""): string {
  const imports = `
import { EventEmitter } from "node:events"
import { background, canceled, withCancel } from "@likego/context"
import {
  newApp,
  server as registerServer,
  stopTimeout as appStopTimeout
} from "@likego/core"
import { Worker } from "bullmq"
import * as publicApi from "@likego/bullmq"
import {
  bullMqWorkerShutdownTimeout,
  newBullMqWorkerServer
} from "@likego/bullmq"

function newBullMqWorkerServerWithFactory(factory, options = []) {
  if (typeof factory !== "function") throw new TypeError("BullMQ worker factory must be a function")
  return newBullMqWorkerServer(() => {
    const worker = factory()
    Object.setPrototypeOf(worker, Worker.prototype)
    return worker
  }, ...options)
}

const Bun = Object.freeze({
  sleep(timeoutMs) { return new Promise((resolve) => setTimeout(resolve, timeoutMs)) }
})
`
  const paths = [
    "../../../packages/bullmq/test/helpers.ts",
    "../../../packages/bullmq/test/construction.test.ts",
    "../../../packages/bullmq/test/lifecycle.test.ts",
    "../../../packages/bullmq/test/public-api.test.ts"
  ]
  let source = imports
  for (const path of paths) {
    let cases = sourceWithoutImports(path)
    if (path.endsWith("construction.test.ts")) {
      const privateCaseStart = cases.indexOf(
        'test("rejects every malformed structural testing lifecycle without inventing data-plane fields"'
      )
      const privateCaseEnd = cases.indexOf(
        'test("a factory candidate remains one-shot after validation failure"',
        privateCaseStart
      )
      if (privateCaseStart < 0 || privateCaseEnd < 0) {
        throw new Error("BullMQ package-private behavior boundary drifted")
      }
      cases = cases.slice(0, privateCaseStart) + cases.slice(privateCaseEnd)
    }
    source += `\n${cases}\n`
  }
  const nativeBoundary = sourceWithoutImports(
    "../../../packages/bullmq/test/native-boundary.test.ts"
  )
  const redisFreeBoundary = nativeBoundary.indexOf(
    'test("runs the direct official Worker overload without wrapping its lifecycle"'
  )
  if (redisFreeBoundary < 0) {
    throw new Error("BullMQ Redis-free native-boundary authority is missing")
  }
  source += `\n${nativeBoundary.slice(redisFreeBoundary)}\n`
  source += String.raw`
test("accepts an official Worker identity without native I/O before canceled start", async () => {
  const native = fakeWorker()
  Object.setPrototypeOf(native.worker, Worker.prototype)
  const subject = newBullMqWorkerServer(native.worker)
  const [ctx, cancel] = withCancel(background())
  cancel()

  await expect(subject.start(ctx)).rejects.toBe(canceled)
  expect(native.calls).toEqual([])
})

test("keeps the production Worker factory lifecycle-only and zero-argument", async () => {
  const native = fakeWorker()
  Object.setPrototypeOf(native.worker, Worker.prototype)
  let argumentCount = -1
  const guarded = new Proxy(native.worker, {
    get(target, property, receiver) {
      if (["processFn", "processor", "job", "data", "queue"].includes(String(property))) {
        throw new Error("adapter inspected the BullMQ data plane")
      }
      return Reflect.get(target, property, receiver)
    }
  })
  const factory = function createWorker() {
    argumentCount = arguments.length
    return guarded
  }

  const server = newBullMqWorkerServer(factory)
  const running = server.start(background())
  await waitForRun(native)
  expect(argumentCount).toBe(0)
  await server.stop(background())
  await running
})

test("normalizes a non-Error native run rejection through the published lifecycle", async () => {
  const native = fakeWorker()
  const server = newBullMqWorkerServerWithFactory(native.factory)
  const running = server.start(background())
  await waitForRun(native)
  native.rejectRun("native run rejection")

  const failure = await running.catch((error) => error)
  expect(failure).toMatchObject({
    name: "BullMqUnexpectedExitError",
    cause: {
      message: "BullMQ worker run rejected with a non-Error value",
      cause: "native run rejection"
    }
  })
})

test("ignores duplicate native closed delivery and a later run settlement", async () => {
  const native = fakeWorker()
  const closedListeners = []
  const nativeOn = native.worker.on.bind(native.worker)
  const nativeOff = native.worker.off.bind(native.worker)
  native.worker.on = function on(event, listener) {
    if (event === "closed") closedListeners.push(listener)
    nativeOn(event, listener)
    return native.worker
  }
  native.worker.off = function off(event, listener) {
    const index = closedListeners.indexOf(listener)
    if (index >= 0) closedListeners.splice(index, 1)
    nativeOff(event, listener)
    return native.worker
  }

  const server = newBullMqWorkerServerWithFactory(native.factory)
  const running = server.start(background())
  await waitForRun(native)
  const installed = closedListeners.slice()
  expect(installed).toHaveLength(1)
  installed[0]()
  installed[0]()
  native.resolveRun()

  await expect(running).rejects.toMatchObject({
    name: "BullMqUnexpectedExitError",
    cause: null
  })
})

test("publishes only lifecycle runtime values from the root boundary", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "bullMqWorkerShutdownTimeout",
    "newBullMqWorkerServer"
  ])
})
`
  const transpiled = runtimeTranspiler.transformSync(source)
  return `${RuntimeTestHarness}\n${transpiled}\n${supplemental}\nexport async function run() {\n  for (const subject of likegoPublishedCases) await subject.invoke()\n}\n`
}

/** Registers published cases for Node-hosted and resident service adapters. */
export function registerNodeServiceCases(registry: PublishedBusinessCaseRegistry): void {
  registry.register({
    package: "@likego/create",
    exports: ["."],
    runtimeModule: `
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject } from "@likego/create"

function readyEndpoint(child) {
  return new Promise((resolve, reject) => {
    let output = ""
    let error = ""
    let settled = false
    const timer = setTimeout(() => finish(new Error("generated service readiness timed out")), 10_000)

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      output += chunk
      const match = /^LIKEGO_READY=(.+)$/m.exec(output)
      if (match !== null) finish(JSON.parse(match[1]).endpoint)
    })
    child.stderr.on("data", (chunk) => {
      error += chunk
    })
    child.once("exit", (code, signal) => {
      finish(new Error("generated service exited before readiness: " + code + "/" + signal + " " + error))
    })
  })
}

async function released(endpoint) {
  const address = new URL(endpoint)
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(Number(address.port), address.hostname, () => probe.close(resolve))
  })
}

export async function run() {
  const root = await mkdtemp(join(tmpdir(), "likego-create-published-"))
  let service = null
  try {
    const executable = join(process.cwd(), "node_modules", ".bin", "create-likego")
    const installedManifest = JSON.parse(
      await readFile(
        join(process.cwd(), "node_modules", "@likego", "create", "package.json"),
        "utf8"
      )
    )
    const version = spawnSync(executable, ["--version"], { encoding: "utf8" })
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout, installedManifest.version + "\\n")

    const target = join(root, "billing-service")
    const generated = spawnSync(executable, [target], { encoding: "utf8" })
    assert.equal(generated.status, 0, generated.stderr)
    assert.match(generated.stdout, /Created billing-service/)
    assert.deepEqual((await readdir(target)).sort(), [
      ".gitignore",
      "README.md",
      "package.json",
      "src",
      "test",
      "tsconfig.json"
    ])
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"))
    assert.equal(manifest.packageManager, "bun@1.3.14")
    assert.deepEqual(manifest.dependencies, installedManifest.dependencies)
    assert.equal(installedManifest.engines.node, ">=24.18.0")
    assert.match(
      await readFile(join(target, "src", "contract.ts"), "utf8"),
      /@likego\\/transport\\/json/
    )
    const tarballs = await readdir(join(process.cwd(), "tarballs"))
    const localDependencies = {}
    const installedPackages = await readdir(join(process.cwd(), "node_modules", "@likego"))
    for (const directory of installedPackages.sort()) {
      const publishedManifest = JSON.parse(
        await readFile(
          join(process.cwd(), "node_modules", "@likego", directory, "package.json"),
          "utf8"
        )
      )
      if (publishedManifest.name === "@likego/create") continue
      const archive =
        publishedManifest.name.replace(/^@/, "").replace("/", "-") +
        "-" +
        publishedManifest.version +
        ".tgz"
      assert.ok(tarballs.includes(archive), "missing generated dependency tarball " + archive)
      localDependencies[publishedManifest.name] =
        "file:" + join(process.cwd(), "tarballs", archive)
    }
    manifest.dependencies = localDependencies
    await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\\n")
    const install = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--loglevel=error"
      ],
      { cwd: target, encoding: "utf8" }
    )
    assert.equal(install.status, 0, install.stderr)
    const unit = spawnSync("npm", ["run", "test"], {
      cwd: target,
      encoding: "utf8"
    })
    assert.equal(unit.status, 0, unit.stderr)
    const types = spawnSync("npm", ["run", "typecheck"], {
      cwd: target,
      encoding: "utf8"
    })
    assert.equal(types.status, 0, types.stderr)

    service = spawn(process.execPath, [join(target, "src", "main.ts")], {
      cwd: target,
      env: { ...process.env, LIKEGO_ADDRESS: "127.0.0.1:0" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    const endpoint = await readyEndpoint(service)
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Likego-Service": "billing-service.greeter",
        "Likego-Endpoint": "Greet"
      },
      body: JSON.stringify({ name: "Published" })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { message: "Hello, Published!" })

    const exited = once(service, "exit")
    assert.equal(service.kill("SIGTERM"), true)
    const [code, signal] = await exited
    assert.equal(code, 143)
    assert.equal(signal, null)
    await released(endpoint)

    await assert.rejects(createProject(target), /target directory already exists/)
    const programmaticTarget = join(root, "programmatic-service")
    assert.deepEqual(await createProject(programmaticTarget), {
      name: "programmatic-service",
      directory: programmaticTarget
    })
    await assert.rejects(
      createProject(join(root, "Not-Kebab")),
      /project name must use strict lower-kebab case/
    )
  } finally {
    if (service !== null && service.exitCode === null && service.signalCode === null) {
      service.kill("SIGKILL")
      await once(service, "exit")
    }
    await rm(root, { recursive: true, force: true })
  }
}
`,
    typeConsumer: `
import { createProject, type CreatedProject } from "@likego/create"

const created: Promise<CreatedProject> = createProject("catalog-service")
void created
`
  })

  registry.register({
    package: "@likego/croner",
    exports: ["."],
    runtimeModule: runtimeFixture(
      "../../../packages/croner/test/runtime/published-runtime.fixture.ts"
    ),
    typeConsumer: `
import { background, type Context } from "@likego/context"
import type { Server } from "@likego/core"
import { Cron } from "croner"
import {
  newCronerServer,
  type CronerFactory,
  type CronerServer,
} from "@likego/croner"

const factory: CronerFactory<Context> = (ctx) => new Cron<Context>(
  "0 * * * * *",
  { paused: true, context: ctx, catch: true },
  async (_job, callbackCtx) => { void callbackCtx }
)
const server: CronerServer = newCronerServer(factory)
const structural: Server = server
const running: Promise<void> = server.start(background())
const stopping: Promise<void> = server.stop(background())
void [structural, running, stopping]
`
  })

  registry.register({
    package: "@likego/bullmq",
    exports: ["."],
    runtimeModule: bullMqRuntimeModule(),
    typeConsumer: `
import type { Server } from "@likego/core"
import type { Processor, Worker } from "bullmq"
import {
  bullMqWorkerShutdownTimeout,
  newBullMqWorkerServer,
  type BullMqAlreadyStartedError,
  type BullMqUnexpectedExitError,
  type BullMqWorkerFactory,
  type BullMqWorkerShutdownTimeoutError,
  type BullMqWorkerServer
} from "@likego/bullmq"

interface Data { readonly id: string }
interface Result { readonly delivered: boolean }
type Name = "send"
declare const worker: Worker<Data, Result, Name>
const processor: Processor<Data, Result, Name> = async (job, token, signal) => {
  signal?.throwIfAborted()
  return { delivered: job.data.id.length > 0 && (token?.length ?? 0) > 0 }
}
const factory: BullMqWorkerFactory<Data, Result, Name> = () => worker
const server: BullMqWorkerServer = newBullMqWorkerServer(
  worker,
  bullMqWorkerShutdownTimeout(25_000)
)
const structural: Server = server
const lazy: Server = newBullMqWorkerServer(factory)
declare const started: BullMqAlreadyStartedError
declare const exited: BullMqUnexpectedExitError
declare const timeout: BullMqWorkerShutdownTimeoutError
void [
  structural,
  lazy,
  processor,
  started.status,
  exited.cause,
  timeout.timeoutMs
]
`
  })

  const natsCoreRuntime = authoritativeRuntimeModule(
    "../../../packages/nats/test/core-lifecycle.test.ts",
    "@likego/nats",
    NatsCorePublishedCoverage,
    stabilizeNatsTimerClearProof
  )
  const natsCoreTypes = `
import { background } from "@likego/context"
import type { Server } from "@likego/core"
import type { Subscription } from "@nats-io/transport-node"
import {
  natsCoreDrainTimeout,
  newNatsCoreServer,
  type NatsCoreAlreadyStartedError,
  type NatsCoreDrainTimeoutError,
  type NatsCoreSubscriptionFactory,
  type NatsCoreSubscriptionSource,
  type NatsCoreUnexpectedExitError
} from "@likego/nats"

declare const subscription: Subscription
const factory: NatsCoreSubscriptionFactory = async () => subscription
const directSource: NatsCoreSubscriptionSource = subscription
const factorySource: NatsCoreSubscriptionSource = factory
const invalidDirectSource = {}
const invalidFactorySource = async () => invalidDirectSource
// @ts-expect-error The source alias accepts only an official Subscription or its exact factory.
const rejectedDirectSource: NatsCoreSubscriptionSource = invalidDirectSource
// @ts-expect-error The factory alias must return an official Subscription.
const rejectedFactory: NatsCoreSubscriptionFactory = invalidFactorySource
// @ts-expect-error The source alias must reject a factory that returns a structural object.
const rejectedFactorySource: NatsCoreSubscriptionSource = invalidFactorySource
// @ts-expect-error The constructor rejects a structural object even if its declaration is weakened independently.
newNatsCoreServer(invalidDirectSource)
// @ts-expect-error The constructor rejects a factory that does not return an official Subscription.
newNatsCoreServer(invalidFactorySource)
const structural: Server = newNatsCoreServer(directSource)
const lazy: Server = newNatsCoreServer(factorySource, natsCoreDrainTimeout(25_000))
const accepted: Promise<void> = structural.start(background())
declare const started: NatsCoreAlreadyStartedError
declare const exited: NatsCoreUnexpectedExitError
declare const timeout: NatsCoreDrainTimeoutError
void [
  accepted,
  lazy,
  rejectedDirectSource,
  rejectedFactory,
  rejectedFactorySource,
  started.code,
  exited.cause,
  timeout.forced
]
`
  const natsJetStreamRuntime = authoritativeRuntimeModule(
    "../../../packages/nats/test/jetstream-lifecycle.test.ts",
    "@likego/nats/jetstream",
    NatsJetStreamPublishedCoverage,
    stabilizeNatsTimerClearProof,
    'from "../src/jetstream"'
  )
  const natsJetStreamTypes = `
import { background } from "@likego/context"
import type { Server } from "@likego/core"
import type { ConsumerMessages } from "@nats-io/jetstream"
import {
  natsJetStreamCloseTimeout,
  newNatsJetStreamServer,
  type NatsJetStreamAlreadyStartedError,
  type NatsJetStreamCloseTimeoutError,
  type NatsJetStreamMessagesFactory,
  type NatsJetStreamMessagesSource,
  type NatsJetStreamUnexpectedExitError
} from "@likego/nats/jetstream"

declare const messages: ConsumerMessages
const factory: NatsJetStreamMessagesFactory = async () => messages
const directSource: NatsJetStreamMessagesSource = messages
const factorySource: NatsJetStreamMessagesSource = factory
const invalidDirectSource = {}
const invalidFactorySource = async () => invalidDirectSource
// @ts-expect-error The source alias accepts only official ConsumerMessages or its exact factory.
const rejectedDirectSource: NatsJetStreamMessagesSource = invalidDirectSource
// @ts-expect-error The factory alias must return official ConsumerMessages.
const rejectedFactory: NatsJetStreamMessagesFactory = invalidFactorySource
// @ts-expect-error The source alias must reject a factory that returns a structural object.
const rejectedFactorySource: NatsJetStreamMessagesSource = invalidFactorySource
// @ts-expect-error The constructor rejects a structural object even if its declaration is weakened independently.
newNatsJetStreamServer(invalidDirectSource)
// @ts-expect-error The constructor rejects a factory that does not return official ConsumerMessages.
newNatsJetStreamServer(invalidFactorySource)
const structural: Server = newNatsJetStreamServer(directSource)
const lazy: Server = newNatsJetStreamServer(factorySource, natsJetStreamCloseTimeout(25_000))
const accepted: Promise<void> = structural.start(background())
declare const started: NatsJetStreamAlreadyStartedError
declare const exited: NatsJetStreamUnexpectedExitError
declare const timeout: NatsJetStreamCloseTimeoutError
void [
  accepted,
  lazy,
  rejectedDirectSource,
  rejectedFactory,
  rejectedFactorySource,
  started.code,
  exited.cause,
  timeout.forced
]
`

  registry.register({
    package: "@likego/nats",
    exports: [".", "./broker", "./jetstream", "./jetstream/broker"],
    runtimeModule: identityRuntimeModule("@likego/nats", [
      ".",
      "./broker",
      "./jetstream",
      "./jetstream/broker"
    ]),
    typeConsumer: identityTypeConsumer("@likego/nats", [
      ".",
      "./broker",
      "./jetstream",
      "./jetstream/broker"
    ]),
    runtimeModules: {
      ".": natsCoreRuntime,
      "./broker": natsBrokerRuntimeModule("core"),
      "./jetstream": natsJetStreamRuntime,
      "./jetstream/broker": natsBrokerRuntimeModule("jetstream")
    },
    typeConsumers: {
      ".": natsCoreTypes,
      "./broker": natsBrokerTypeConsumer("core"),
      "./jetstream": natsJetStreamTypes,
      "./jetstream/broker": natsBrokerTypeConsumer("jetstream")
    },
    natsExactOptionalPolicies: [
      { export: ".", directDependency: "@nats-io/transport-node" },
      { export: "./broker", directDependency: "@nats-io/transport-node" },
      { export: "./jetstream", directDependency: "@nats-io/jetstream" },
      { export: "./jetstream/broker", directDependency: "@nats-io/jetstream" }
    ]
  })
}
