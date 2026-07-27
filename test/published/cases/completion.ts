import { readFileSync } from "node:fs"

import type { PublishedBusinessCaseRegistry } from "../../../scripts/published/business-cases"
import { behaviorHarness, behaviorRunner, transpile, withoutImports } from "./integrations"

function source(path: string): string {
  return withoutImports(readFileSync(new URL(path, import.meta.url), "utf8"))
}

function suiteHarness(): string {
  const harness = behaviorHarness()
  const synchronous =
    '    toMatchObject(expected) { check(matches(actual, expected, true), "toMatchObject") },'
  const asynchronous =
    "    async toBe(expected) { synchronousMatchers(await settled()).toBe(expected) },"
  if (!harness.includes(synchronous) || !harness.includes(asynchronous)) {
    throw new Error("published completion assertion harness drifted")
  }
  return harness
    .replace(
      synchronous,
      `${synchronous}\n    toMatch(expected) { check(typeof actual === "string" && expected instanceof RegExp && expected.test(actual), "toMatch") },`
    )
    .replace(
      asynchronous,
      [
        asynchronous,
        "    async toEqual(expected) { synchronousMatchers(await settled()).toEqual(expected) },",
        "    async toBeNull() { synchronousMatchers(await settled()).toBeNull() },",
        "    async toBeInstanceOf(expected) { synchronousMatchers(await settled()).toBeInstanceOf(expected) },"
      ].join("\n")
    )
}

function reviewedSuite(
  imports: string,
  helpers: readonly string[],
  cases: readonly string[],
  replacements: readonly (readonly [string, string])[] = [],
  supplemental = ""
): string {
  const rewrite = (value: string): string => {
    let rewritten = value
    for (const [from, to] of replacements) rewritten = rewritten.replaceAll(from, to)
    return rewritten
  }
  const runtimeModule = [
    imports,
    suiteHarness(),
    ...helpers.map((path) => rewrite(source(path))),
    ...cases.map((path) => `{\n${rewrite(source(path))}\n}`),
    supplemental,
    behaviorRunner()
  ].join("\n")
  if (runtimeModule.includes("Bun.")) {
    throw new Error("published completion behavior must not depend on Bun globals")
  }
  return transpile(runtimeModule)
}

const runtimeNeutralTimerReplacements = [
  ["await Bun.sleep(0)", "await new Promise((resolve) => setTimeout(resolve, 0))"],
  ["await Bun.sleep(1)", "await new Promise((resolve) => setTimeout(resolve, 1))"],
  ["await Bun.sleep(5)", "await new Promise((resolve) => setTimeout(resolve, 5))"]
] as const

function typeFixture(path: string, replacements: readonly (readonly [string, string])[]): string {
  let fixture = readFileSync(new URL(path, import.meta.url), "utf8")
  for (const [from, to] of replacements) fixture = fixture.replaceAll(from, to)
  return fixture
}

function requiredReplacement(sourceText: string, from: string, to: string): string {
  if (!sourceText.includes(from)) throw new Error("published type fixture replacement drifted")
  return sourceText.replace(from, to)
}

function publishedBehaviorRuntimeModule(
  path: string,
  functionName: string,
  boundaryMarker = `\nawait ${functionName}()`
): string {
  const sourceText = readFileSync(new URL(path, import.meta.url), "utf8")
  const boundary = sourceText.lastIndexOf(boundaryMarker)
  if (boundary < 0) throw new Error(`${functionName} published behavior invocation is missing`)
  const rewritten = sourceText
    .slice(0, boundary)
    .replace(`export async function ${functionName}(`, "export async function run(")
  if (!rewritten.includes("export async function run(")) {
    throw new Error(`${functionName} published behavior runner is missing`)
  }
  return transpile(rewritten)
}

/** Wraps the ZooKeeper top-level published behavior as the shared runner contract. */
function zookeeperRuntimeModule(): string {
  const sourceText = readFileSync(
    new URL(
      "../../../packages/registry/zookeeper/test/integration/published-behavior.ts",
      import.meta.url
    ),
    "utf8"
  )
  return transpile(
    [
      'import { newZookeeperRegistry } from "@likego/registry-zookeeper"',
      "export async function run() {",
      withoutImports(sourceText),
      "}"
    ].join("\n")
  )
}

const ZookeeperNativeModule = String.raw`
const controlSymbol = Symbol.for("likego.published.registry-zookeeper.native")
const nodes = new Map()
const sessions = []
const watches = new Map()
const callbackFailures = new Map()
const synchronousFailures = new Map()
const heldOperations = new Set()
const heldCallbacks = new Map()
const connectEvents = []
const closeEvents = []
const authCalls = []
let nextSession = 1

function parent(path) {
  const index = path.lastIndexOf("/")
  return index <= 0 ? "/" : path.slice(0, index)
}

function nativeError(code) {
  return Object.freeze({ getCode() { return code } })
}

function take(queue, operation) {
  const values = queue.get(operation)
  if (values === undefined || values.length === 0) return Object.freeze({ found: false })
  const value = values.shift()
  if (values.length === 0) queue.delete(operation)
  return Object.freeze({ found: true, value })
}

function enqueue(queue, operation, value) {
  let values = queue.get(operation)
  if (values === undefined) {
    values = []
    queue.set(operation, values)
  }
  values.push(value)
}

function children(path) {
  if (!nodes.has(path)) throw nativeError(-101)
  const prefix = path === "/" ? "/" : path + "/"
  const names = new Set()
  for (const candidate of nodes.keys()) {
    if (!candidate.startsWith(prefix) || candidate === path) continue
    const suffix = candidate.slice(prefix.length)
    if (!suffix.includes("/")) names.add(suffix)
  }
  return Array.from(names).sort()
}

function changed(path) {
  const current = watches.get(path)
  if (current === undefined) return
  watches.delete(path)
  for (const watch of current) {
    if (watch.session.connected && !watch.session.closed) queueMicrotask(watch.listener)
  }
}

function removeOwned(session) {
  const removed = []
  for (const [path, node] of nodes) {
    if (node.owner !== session.id) continue
    nodes.delete(path)
    removed.push(path)
  }
  for (const path of removed) changed(parent(path))
}

function emitRecord(session, event) {
  const records = Array.from(session.listeners.get(event) || [])
  for (const record of records) {
    if (record.once) {
      const current = session.listeners.get(event) || []
      session.listeners.set(event, current.filter(function retained(candidate) {
        return candidate !== record
      }))
    }
    record.listener()
  }
}

function emit(session, event) {
  if (event === "expired") {
    session.connected = false
    removeOwned(session)
  }
  if (event === "disconnected") session.connected = false
  emitRecord(session, event)
}

function invoke(operation, done, success) {
  const synchronous = take(synchronousFailures, operation)
  if (synchronous.found) throw synchronous.value
  if (heldOperations.delete(operation)) {
    heldCallbacks.set(operation, Object.freeze({ done, success }))
    return
  }
  const callback = take(callbackFailures, operation)
  if (callback.found) {
    done(callback.value)
    return
  }
  try {
    done(null, success())
  } catch (error) {
    done(error)
  }
}

function complete(operation, error) {
  const held = heldCallbacks.get(operation)
  if (held === undefined) throw new Error("missing held native operation " + operation)
  heldCallbacks.delete(operation)
  if (error !== undefined && error !== null) {
    held.done(error)
    return
  }
  try {
    held.done(null, held.success())
  } catch (value) {
    held.done(value)
  }
}

function reset() {
  nodes.clear()
  nodes.set("/", Object.freeze({ data: new Uint8Array(), owner: null }))
  sessions.length = 0
  watches.clear()
  callbackFailures.clear()
  synchronousFailures.clear()
  heldOperations.clear()
  heldCallbacks.clear()
  connectEvents.length = 0
  closeEvents.length = 0
  authCalls.length = 0
  nextSession = 1
}

reset()

export const ACL = {
  OPEN_ACL_UNSAFE: Object.freeze([Object.freeze({ id: "open" })]),
  CREATOR_ALL_ACL: Object.freeze([Object.freeze({ id: "creator" })])
}

export const CreateMode = Object.freeze({ PERSISTENT: 11, EPHEMERAL: 22 })
export const Exception = Object.freeze({ NO_NODE: -101 })

export function createClient() {
  const session = {
    id: nextSession,
    listeners: new Map(),
    connected: false,
    closed: false
  }
  nextSession += 1
  sessions.push(session)

  function addListener(event, listener, once) {
    const current = session.listeners.get(event) || []
    current.push(Object.freeze({ listener, once }))
    session.listeners.set(event, current)
  }

  function removeListener(event, listener) {
    const current = session.listeners.get(event) || []
    session.listeners.set(event, current.filter(function retained(record) {
      return record.listener !== listener
    }))
  }

  const client = {
    addAuthInfo(scheme, credential) {
      authCalls.push(Object.freeze({ scheme, bytes: Uint8Array.from(credential).length }))
    },
    on(event, listener) {
      addListener(event, listener, false)
    },
    once(event, listener) {
      addListener(event, listener, true)
    },
    removeListener,
    connect() {
      const synchronous = take(synchronousFailures, "connect")
      if (synchronous.found) throw synchronous.value
      const event = connectEvents.shift() || "connected"
      if (event === "hold") return
      session.connected = event === "connected"
      emitRecord(session, event)
    },
    close() {
      const synchronous = take(synchronousFailures, "close")
      if (synchronous.found) throw synchronous.value
      const event = closeEvents.shift() || "disconnected"
      if (event === "hold") return
      session.connected = false
      removeOwned(session)
      session.closed = true
      emitRecord(session, event)
    },
    mkdirp(path, _data, _acls, _mode, done) {
      invoke("mkdirp", done, function createParents() {
        let current = ""
        for (const segment of path.slice(1).split("/")) {
          current += "/" + segment
          if (nodes.has(current)) continue
          if (!nodes.has(parent(current))) throw nativeError(-101)
          nodes.set(current, Object.freeze({ data: new Uint8Array(), owner: null }))
          changed(parent(current))
        }
      })
    },
    getChildren(path, watcherOrDone, maybeDone) {
      const watcher = maybeDone === undefined ? null : watcherOrDone
      const done = maybeDone === undefined ? watcherOrDone : maybeDone
      invoke(maybeDone === undefined ? "children" : "watch-children", done, function readChildren() {
        const names = children(path)
        if (watcher !== null) {
          let current = watches.get(path)
          if (current === undefined) {
            current = new Set()
            watches.set(path, current)
          }
          current.add(Object.freeze({ session, listener: watcher }))
        }
        return names
      })
    },
    getData(path, done) {
      invoke("data", done, function readData() {
        const node = nodes.get(path)
        if (node === undefined) throw nativeError(-101)
        return Buffer.from(node.data)
      })
    },
    transaction() {
      const mutations = []
      const transaction = {
        create(path, data, _acls, _mode) {
          mutations.push(Object.freeze({ kind: "create", path, data: Uint8Array.from(data) }))
          return transaction
        },
        remove(path, _version) {
          mutations.push(Object.freeze({ kind: "delete", path }))
          return transaction
        },
        commit(done) {
          invoke("mutate", done, function commitMutation() {
            const projected = new Map(nodes)
            for (const mutation of mutations) {
              if (mutation.kind === "create") {
                if (projected.has(mutation.path)) throw nativeError(-110)
                if (!projected.has(parent(mutation.path))) throw nativeError(-101)
                projected.set(
                  mutation.path,
                  Object.freeze({ data: mutation.data.slice(), owner: session.id })
                )
              } else {
                if (!projected.has(mutation.path)) throw nativeError(-101)
                projected.delete(mutation.path)
              }
            }
            nodes.clear()
            for (const [path, node] of projected) nodes.set(path, node)
            for (const mutation of mutations) changed(parent(mutation.path))
          })
        }
      }
      return transaction
    },
    remove(path, _version, done) {
      invoke("remove", done, function removeNode() {
        if (!nodes.has(path)) throw nativeError(-101)
        const prefix = path + "/"
        for (const candidate of nodes.keys()) {
          if (candidate.startsWith(prefix)) throw nativeError(-111)
        }
        nodes.delete(path)
        changed(parent(path))
      })
    }
  }
  return client
}

const controls = Object.freeze({
  reset,
  failNext(operation, code) {
    enqueue(callbackFailures, operation, nativeError(code))
  },
  throwNext(operation, code) {
    enqueue(synchronousFailures, operation, code === null ? new Error("native failure") : nativeError(code))
  },
  holdNext(operation) {
    heldOperations.add(operation)
  },
  held(operation) {
    return heldCallbacks.has(operation)
  },
  complete,
  connectEvent(event) {
    connectEvents.push(event)
  },
  closeEvent(event) {
    closeEvents.push(event)
  },
  emit(event) {
    for (const session of sessions) {
      if (session.closed) continue
      emit(session, event)
    }
  },
  sessionCount() {
    return sessions.length
  },
  activeSessions() {
    return sessions.filter(function active(session) {
      return session.connected && !session.closed
    }).length
  },
  ephemeralNodes() {
    let count = 0
    for (const node of nodes.values()) if (node.owner !== null) count += 1
    return count
  },
  authCalls() {
    return authCalls.slice()
  }
})

Object.defineProperty(globalThis, controlSymbol, {
  value: controls,
  configurable: true,
  enumerable: false,
  writable: false
})
`

export const zookeeperNodePreloadModule = [
  'import { registerHooks } from "node:module"',
  `const nativeSource = ${JSON.stringify(ZookeeperNativeModule)}`,
  'const nativeUrl = `data:text/javascript;base64,${Buffer.from(nativeSource).toString("base64")}`',
  "registerHooks({ resolve(specifier, context, nextResolve) {",
  '  if (specifier === "node-zookeeper-client") return { url: nativeUrl, shortCircuit: true }',
  "  return nextResolve(specifier, context)",
  "} })",
  ""
].join("\n")

function brokerRuntimeModule(): string {
  return reviewedSuite(
    `import { background, withCancelCause } from "@likego/context"
import { newBrokerServer } from "@likego/broker"
import * as BrokerPackage from "@likego/broker"
import { registerSubscriberTerminal } from "@likego/broker/provider"
import * as BrokerProvider from "@likego/broker/provider"`,
    [],
    [
      "../../../packages/broker/test/broker.test.ts",
      "../../../packages/broker/test/public-api.test.ts"
    ]
  )
}

function brokerMemoryRuntimeModule(): string {
  return reviewedSuite(
    `import { newBrokerServer } from "@likego/broker"
import { background, cause, withCancel, withCancelCause } from "@likego/context"
import * as MemoryBroker from "@likego/broker-memory"
import { newMemoryBroker } from "@likego/broker-memory"`,
    [],
    [
      "../../../packages/broker/memory/test/broker.test.ts",
      "../../../packages/broker/memory/test/public-api.test.ts"
    ]
  )
}

function eventRuntimeModule(): string {
  return reviewedSuite(
    `import { background } from "@likego/context"
import { eventBroker } from "@likego/event"`,
    [],
    ["../../../packages/event/test/event.test.ts"]
  )
}

function configEtcdRuntimeModule(): string {
  return reviewedSuite(
    `import { newConfig, onReloadError, source as configSource } from "@likego/config"
import { background, withCancelCause } from "@likego/context"
import * as EtcdConfig from "@likego/config-etcd"
import { etcdSource, jsonEtcdDecoder } from "@likego/config-etcd"`,
    ["../../../packages/config/etcd/test/helpers.ts"],
    [
      "../../../packages/config/etcd/test/etcd.test.ts",
      "../../../packages/config/etcd/test/boundary.test.ts",
      "../../../packages/config/etcd/test/public-api.test.ts"
    ]
  )
}

const RegistryEtcdCodec = String.raw`
function encodeBytes(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function decodeBytes(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}
`

const RegistryEtcdPublishedCoverage = String.raw`
test("published public paths cover ServiceInstance discovery and deterministic ordering", async () => {
  const etcd = fakeEtcd()
  const registry = newEtcdRegistry({ fetch: etcd.fetch, address: "https://etcd.example" })
  function service(name, version, id) {
    return {
      id,
      name,
      version,
      metadata: {},
      endpoints: ["opaque://" + id]
    }
  }
  const later = service("orders", "v2", "zeta-1")
  const earlier = service("orders", "v1", "alpha-1")
  await registry.register(background(), later)
  await registry.register(background(), earlier)
  expect((await registry.getService(background(), "orders")).map((value) => value.id)).toEqual([
    "alpha-1",
    "zeta-1"
  ])
  await registry.deregister(background(), earlier)
  await registry.deregister(background(), later)
})

test("published operation links caller cancellation into its request lease", async () => {
  const failure = new Error("published caller canceled")
  const [ctx, cancel] = withCancelCause(background())
  const fetch = async function canceledFetch() {
    cancel(failure)
    throw failure
  }
  const registry = newEtcdRegistry({ fetch, address: "https://etcd.example" })
  await expect(registry.getService(ctx, "orders")).rejects.toBe(failure)
})

test("published operation timeout aborts a pending request", async () => {
  let timedOut = false
  const fetch = async function pendingFetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init)
    return new Promise(function wait(_resolve, reject) {
      let settled = false
      function aborted() {
        if (settled) return
        settled = true
        clearTimeout(guard)
        request.signal.removeEventListener("abort", aborted)
        timedOut = true
        reject(request.signal.reason)
      }
      function verifyAbort() {
        if (request.signal.aborted) {
          aborted()
          return
        }
        settled = true
        request.signal.removeEventListener("abort", aborted)
        reject(new Error("published timeout did not abort the request"))
      }
      const guard = setTimeout(verifyAbort, 250)
      request.signal.addEventListener("abort", aborted, { once: true })
      if (request.signal.aborted) aborted()
    })
  }
  const registry = newEtcdRegistry({
    fetch,
    address: "https://etcd.example",
    timeoutMs: 5
  })
  await expect(registry.getService(background(), "orders")).rejects.toBe(deadlineExceeded)
  expect(timedOut).toBe(true)
})

`

function registryEtcdRuntimeModule(): string {
  return reviewedSuite(
    `import { background, deadlineExceeded, withCancelCause } from "@likego/context"
import * as api from "@likego/registry-etcd"
import { newEtcdRegistry } from "@likego/registry-etcd"
${RegistryEtcdCodec}`,
    ["../../../packages/registry/etcd/test/helpers.ts"],
    [
      "../../../packages/registry/etcd/test/construction.test.ts",
      "../../../packages/registry/etcd/test/registry.test.ts",
      "../../../packages/registry/etcd/test/discovery-boundaries.test.ts",
      "../../../packages/registry/etcd/test/registration-boundaries.test.ts",
      "../../../packages/registry/etcd/test/public-api.test.ts"
    ],
    [
      ["await Bun.sleep(5)", "await new Promise((resolve) => setTimeout(resolve, 5))"],
      ["await Bun.sleep(20)", "await new Promise((resolve) => setTimeout(resolve, 20))"],
      [
        `return new Promise<Response>(function wait(_resolve, reject): void {
      request.signal.addEventListener(
        "abort",
        function aborted(): void {
          timedOut = true
          reject(request.signal.reason)
        },
        { once: true }
      )
    })`,
        `return new Promise<Response>(function wait(_resolve, reject): void {
      function aborted(): void {
        timedOut = true
        reject(request.signal.reason)
      }
      request.signal.addEventListener("abort", aborted, { once: true })
      if (request.signal.aborted) aborted()
    })`
      ]
    ],
    RegistryEtcdPublishedCoverage
  )
}

const StoreImports = String.raw`
import { cause } from "@likego/context"
import * as Store from "@likego/store"
import * as StoreProvider from "@likego/store/provider"
import {
  cursor,
  expiresIn,
  ifRevision,
  limit,
  prefix
} from "@likego/store"
import {
  compareStoreKeys,
  deleteOptions,
  listOptions,
  newStoreConflictError,
  snapshotStorePage,
  snapshotStoreRecord,
  snapshotStoreRecordInput,
  writeOptions
} from "@likego/store/provider"
`

function storeRootRuntimeModule(): string {
  return reviewedSuite(
    StoreImports,
    [],
    [
      "../../../packages/store/test/errors.test.ts",
      "../../../packages/store/test/options.test.ts",
      "../../../packages/store/test/snapshot.test.ts"
    ]
  )
}

function cacheRootRuntimeModule(): string {
  return reviewedSuite(
    `import * as Cache from "@likego/cache"
import * as CacheProvider from "@likego/cache/provider"
import { expiresIn } from "@likego/cache"
import { putOptions } from "@likego/cache/provider"`,
    [],
    ["../../../packages/cache/test/options-errors.test.ts"],
    [],
    `test("published Cache root keeps its exact runtime surface", () => {
      expect(Object.keys(Cache)).toEqual(["expiresIn"])
      expect(Object.keys(CacheProvider)).toEqual(["putOptions"])
    })`
  )
}

function cacheMemoryRuntimeModule(): string {
  return reviewedSuite(
    `import { expiresIn } from "@likego/cache"
import { background, cause, withCancel } from "@likego/context"
import * as MemoryCache from "@likego/cache-memory"
import { clock, newMemoryCache } from "@likego/cache-memory"`,
    [],
    [
      "../../../packages/cache/memory/test/cache.test.ts",
      "../../../packages/cache/memory/test/public-api.test.ts"
    ],
    [["await Bun.sleep(5)", "await new Promise((resolve) => setTimeout(resolve, 5))"]]
  )
}

function storeMemoryRuntimeModule(): string {
  return reviewedSuite(
    `import { cursor, expiresIn, ifRevision, limit, prefix } from "@likego/store"
import { background, cause, withCancel } from "@likego/context"
import * as MemoryStore from "@likego/store-memory"
import { clock, newMemoryStore } from "@likego/store-memory"`,
    [],
    [
      "../../../packages/store/memory/test/store.test.ts",
      "../../../packages/store/memory/test/public-api.test.ts"
    ]
  )
}

const RedisCacheRuntime = String.raw`
import { createServer } from "node:net"
import { expiresIn } from "@likego/cache"
import { background, withCancelCause } from "@likego/context"
import * as RedisCachePackage from "@likego/cache-redis"
import {
  newRedisCache,
  newRedisCacheOperationError,
  newRedisCacheProtocolError
} from "@likego/cache-redis"

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

function line(source, offset) {
  const end = source.indexOf("\r\n", offset)
  return end < 0 ? null : [source.slice(offset, end), end + 2]
}

function command(source) {
  if (!source.startsWith("*")) return null
  const header = line(source, 1)
  if (header === null) return null
  const count = Number(header[0])
  let offset = header[1]
  const parts = []
  for (let index = 0; index < count; index += 1) {
    if (source[offset] !== "$") throw new Error("published Redis received a non-bulk command")
    const lengthLine = line(source, offset + 1)
    if (lengthLine === null) return null
    const length = Number(lengthLine[0])
    const end = lengthLine[1] + length
    if (source.length < end + 2) return null
    parts.push(source.slice(lengthLine[1], end))
    offset = end + 2
  }
  return [parts, offset]
}

async function redisServer() {
  const values = new Map()
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding("utf8")
    let pending = ""
    socket.on("close", () => sockets.delete(socket))
    socket.on("data", (chunk) => {
      pending += chunk
      while (pending.length > 0) {
        const decoded = command(pending)
        if (decoded === null) return
        pending = pending.slice(decoded[1])
        const parts = decoded[0]
        const name = parts[0]?.toUpperCase()
        if (name === "HELLO") {
          socket.write("%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$5\r\n8.8.1\r\n$5\r\nproto\r\n:3\r\n$2\r\nid\r\n:1\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n")
        } else if (name === "CLIENT" || name === "SELECT" || name === "QUIT") {
          socket.write("+OK\r\n")
        } else if (name === "GET") {
          const value = values.get(parts[1])
          socket.write(value === undefined ? "$-1\r\n" : "$" + value.length + "\r\n" + value + "\r\n")
        } else if (name === "SET") {
          values.set(parts[1], parts[2])
          socket.write("+OK\r\n")
        } else if (name === "DEL") {
          socket.write(":" + (values.delete(parts[1]) ? 1 : 0) + "\r\n")
        } else if (name === "PING") {
          socket.write("+PONG\r\n")
        } else {
          socket.write("-ERR unsupported published command\r\n")
        }
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("published Redis address missing")
  return {
    url: "redis://127.0.0.1:" + address.port,
    foreign(key, value) { values.set(key, value) },
    drop() { for (const socket of sockets) socket.destroy() },
    async stop() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
    }
  }
}

async function waitUntil(condition) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("published Redis condition timed out")
}

export async function run() {
  requireValue(JSON.stringify(Object.keys(RedisCachePackage).sort()) === JSON.stringify([
    "newRedisCache",
    "newRedisCacheOperationError",
    "newRedisCacheProtocolError"
  ]), "Redis Cache public surface drifted")
  const operation = newRedisCacheOperationError("get", new Error("published"))
  const protocol = newRedisCacheProtocolError()
  requireValue(operation.code === "LIKEGO_CACHE_REDIS_OPERATION" && protocol.code === "LIKEGO_CACHE_REDIS_PROTOCOL", "Redis Cache errors drifted")
  for (const value of [null, { url: "" }, { url: "https://redis.test" }, { url: "redis://127.0.0.1", prefix: "\ud800" }, { url: "redis://127.0.0.1", connectTimeoutMs: 0 }]) {
    let rejected = false
    try { newRedisCache(value) } catch { rejected = true }
    requireValue(rejected, "invalid Redis Cache options were accepted")
  }

  const server = await redisServer()
  try {
    const connectCause = new Error("published connect canceled")
    const connectContext = withCancelCause(background())
    const connecting = newRedisCache({ url: server.url }).start(connectContext[0])
    connectContext[1](connectCause)
    let connectFailure = null
    try { await connecting } catch (error) { connectFailure = error }
    requireValue(connectFailure === connectCause, "Redis Cache connect cancellation changed")

    const backgroundErrors = []
    const cache = newRedisCache({
      url: server.url,
      prefix: "published:",
      onError(error) {
        backgroundErrors.push(error)
        return Promise.reject(new Error("published callback rejection"))
      }
    })
	    requireValue(cache.string() === "redis", "Redis Cache identity drifted")
    let idleRejected = false
    try { await cache.get(background(), "idle") } catch { idleRejected = true }
    requireValue(idleRejected, "idle Redis Cache operation was admitted")
    const running = cache.start(background())
    void running.catch(() => {})
    await waitUntil(async () => {
      try {
        await cache.get(background(), "readiness")
        return true
      } catch {
        return false
      }
    })
    const [operationContext] = withCancelCause(background())
    await cache.put(operationContext, "key", new Uint8Array([0, 127, 255]), expiresIn(50))
    const value = await cache.get(background(), "key")
    requireValue(value?.[0] === 0 && value[2] === 255, "Redis Cache bytes drifted")
    await cache.put(background(), "forever", new Uint8Array([1]))
    await cache.delete(background(), "key")
    requireValue((await cache.get(background(), "key")) === null, "Redis Cache delete missed")
    await cache.delete(background(), "key")
    server.foreign("published:foreign", "foreign")
    let foreignCode = ""
    try { await cache.get(background(), "foreign") } catch (error) { foreignCode = error?.code ?? "" }
    requireValue(foreignCode === "LIKEGO_CACHE_REDIS_PROTOCOL", "Redis Cache foreign carrier was accepted")
    server.drop()
    await waitUntil(() => backgroundErrors.length > 0)
    await waitUntil(async () => {
      try { return (await cache.get(background(), "forever"))?.[0] === 1 } catch { return false }
    })
    await cache.stop(background())
    await running
  } finally {
    await server.stop()
  }
}
`

function configVaultRuntimeModule(): string {
  return reviewedSuite(
    `import { newConfig, onReloadError, source as configSource } from "@likego/config"
import { background, withCancelCause } from "@likego/context"
import * as VaultConfig from "@likego/config-vault"
import { vaultSource } from "@likego/config-vault"`,
    ["../../../packages/config/vault/test/helpers.ts"],
    [
      "../../../packages/config/vault/test/vault.test.ts",
      "../../../packages/config/vault/test/public-api.test.ts"
    ],
    runtimeNeutralTimerReplacements
  )
}

function storeVaultRuntimeModule(): string {
  return reviewedSuite(
    `import { background, cause, withCancel } from "@likego/context"
import { cursor, expiresIn, ifRevision, limit, prefix } from "@likego/store"
import * as vault from "@likego/store-vault"
import { newVaultStore } from "@likego/store-vault"
function physicalKey(value) {
  let binary = ""
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}`,
    ["../../../packages/store/vault/test/helpers.ts"],
    [
      "../../../packages/store/vault/test/store.test.ts",
      "../../../packages/store/vault/test/public-api.test.ts"
    ],
    runtimeNeutralTimerReplacements
  )
}

const FileStoreSharedFailureRuntime = String.raw`
async function startPublishedStore(store) {
  const running = store.start(background())
  void running.catch(() => {})
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      await store.read(background(), "__likego_published_readiness__")
      return Object.freeze({ running })
    } catch (error) {
      if (error?.code !== "LIKEGO_FILE_STORE_STATE" || error?.state !== "starting") throw error
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  throw new Error("published File Store did not become ready")
}

async function stopPublishedStore(store, started) {
  await store.stop(background())
  await started.running
}

async function runSharedFileStoreFailure() {
  const closeFailure = new Error("published native directory close failure")
  let failClose = false
  const host = Object.freeze({
    async acquire() {
      return Object.freeze({
        async close() {
          if (failClose) throw closeFailure
        },
        async read() { return null },
        async write() {},
        async rename() {},
        async remove() { return false }
      })
    }
  })
  const store = newFileStore(host, "published-failure")
  const started = await startPublishedStore(store)
  failClose = true
  let stopFailure = null
  try { await store.stop(background()) } catch (error) { stopFailure = error }
  let terminalFailure = null
  try { await started.running } catch (error) { terminalFailure = error }
  if (stopFailure !== closeFailure || terminalFailure !== closeFailure) {
    throw new Error("directory close failure did not terminate File Store")
  }
}
`

const FileStoreRuntime = String.raw`
import { background, cause } from "@likego/context"
import {
  newFileStore,
  newFileStoreCorruptionError,
  newFileStoreLockedError
} from "@likego/store-file"

${FileStoreSharedFailureRuntime}

function memoryHost() {
  const files = new Map()
  return Object.freeze({
    async acquire(ctx) {
      const admissionFailure = ctx.err()
      if (admissionFailure !== null) throw cause(ctx) ?? admissionFailure
      let stopped = false
      function admit(operationCtx) {
        const failure = operationCtx.err()
        if (failure !== null) throw cause(operationCtx) ?? failure
        if (stopped) throw new Error("memory directory stopped")
      }
      return Object.freeze({
        async close(stopCtx) {
          const failure = stopCtx.err()
          if (failure !== null) throw cause(stopCtx) ?? failure
          stopped = true
        },
        async read(operationCtx, name) {
          admit(operationCtx)
          const value = files.get(name)
          return value === undefined ? null : new Uint8Array(value)
        },
        async write(operationCtx, name, bytes) {
          admit(operationCtx)
          files.set(name, new Uint8Array(bytes))
        },
        async rename(operationCtx, source, target) {
          admit(operationCtx)
          const value = files.get(source)
          if (value === undefined) throw new Error("memory source is missing")
          files.set(target, value)
          files.delete(source)
        },
        async remove(operationCtx, name) {
          admit(operationCtx)
          return files.delete(name)
        }
      })
    }
  })
}

export async function run() {
  for (const reason of ["encoding", "json", "schema", "checksum", "record"]) {
    const failure = newFileStoreCorruptionError(reason)
    if (failure.reason !== reason || !Object.isFrozen(failure)) throw new Error("corruption error changed")
  }
  if (newFileStoreLockedError().code !== "LIKEGO_FILE_STORE_LOCKED") throw new Error("lock error changed")
  let rejected = false
  try { newFileStore(null, "directory") } catch { rejected = true }
  if (!rejected) throw new Error("invalid File Store host was accepted")

  const persistentHost = memoryHost()
  const first = newFileStore(persistentHost, "persistent")
  const firstStarted = await startPublishedStore(first)
  await first.write(background(), {
    key: "persisted",
    value: new Uint8Array([1, 2, 3]),
    metadata: { source: "published" }
  })
  await stopPublishedStore(first, firstStarted)
  const reopened = newFileStore(persistentHost, "persistent")
  const reopenedStarted = await startPublishedStore(reopened)
  const record = await reopened.read(background(), "persisted")
  if (record === null || record.metadata.source !== "published") {
    throw new Error("persisted File Store snapshot did not reopen")
  }
  await stopPublishedStore(reopened, reopenedStarted)
  await runSharedFileStoreFailure()
}
`

const FileStoreNodeRuntime = String.raw`
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { background } from "@likego/context"
import {
  newFileStore,
  newFileStoreCorruptionError,
  newFileStoreLockedError
} from "@likego/store-file"
import { newNodeFileStoreHost } from "@likego/store-file/node"

${FileStoreSharedFailureRuntime}

export async function run() {
  newFileStoreCorruptionError("checksum")
  newFileStoreLockedError()

  const persistentDirectory = await mkdtemp(join(tmpdir(), "likego-published-store-file-"))
  try {
    const first = newFileStore(newNodeFileStoreHost(), persistentDirectory)
    const firstStarted = await startPublishedStore(first)
    await first.write(background(), {
      key: "persisted",
      value: new Uint8Array([1, 2, 3]),
      metadata: { source: "published" }
    })
    await stopPublishedStore(first, firstStarted)
    const reopened = newFileStore(newNodeFileStoreHost(), persistentDirectory)
    const reopenedStarted = await startPublishedStore(reopened)
    const record = await reopened.read(background(), "persisted")
    if (record === null || record.metadata.source !== "published") {
      throw new Error("persisted Node File Store snapshot did not reopen")
    }
    await stopPublishedStore(reopened, reopenedStarted)
  } finally {
    await rm(persistentDirectory, { recursive: true, force: true })
  }

  const operationDirectory = await mkdtemp(join(tmpdir(), "likego-published-store-file-"))
  try {
    const directory = await newNodeFileStoreHost().acquire(background(), operationDirectory)
    let renameRejected = false
    try { await directory.rename(background(), "missing", "target") } catch { renameRejected = true }
    if (!renameRejected) throw new Error("missing Node rename unexpectedly succeeded")
    await directory.close(background())
  } finally {
    await rm(operationDirectory, { recursive: true, force: true })
  }

  const provisionalDirectory = await mkdtemp(join(tmpdir(), "likego-published-store-file-"))
  try {
    let admissions = 0
    const admissionFailure = new Error("published provisional admission canceled")
    const admissionContext = {
      deadline() { return null },
      done() { return null },
      err() { admissions += 1; return admissions >= 3 ? admissionFailure : null },
      value() { return null }
    }
    let observedFailure = null
    try { await newNodeFileStoreHost().acquire(admissionContext, provisionalDirectory) } catch (error) {
      observedFailure = error
    }
    if (observedFailure !== admissionFailure) throw new Error("provisional lock failure identity changed")
    const directory = await newNodeFileStoreHost().acquire(background(), provisionalDirectory)
    await directory.close(background())
  } finally {
    await rm(provisionalDirectory, { recursive: true, force: true })
  }

  const terminalDirectory = await mkdtemp(join(tmpdir(), "likego-published-store-file-"))
  try {
    const directory = await newNodeFileStoreHost().acquire(background(), terminalDirectory)
    const lockPath = join(terminalDirectory, ".likego-store.lock")
    await unlink(lockPath)
    await mkdir(lockPath)
    let stopRejected = false
    try { await directory.close(background()) } catch { stopRejected = true }
    if (!stopRejected) throw new Error("Node lock cleanup unexpectedly succeeded")
  } finally {
    await rm(terminalDirectory, { recursive: true, force: true })
  }

  await runSharedFileStoreFailure()
}
`

const ConsulStoreCodec = String.raw`
function encodeBase64(value) {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function encodeRecordPayload(value, operation, expiresAt) {
  return JSON.stringify({
    version: 1,
    operation,
    value: encodeBase64(value.value),
    metadata: value.metadata ?? {},
    expiresAt
  })
}
`

const ConsulStorePublishedCoverage = String.raw`
test("published Consul Store observes a rejected response-body discard", async () => {
  let canceled = false
  let rejectRequest = false
  const consul = fakeConsul()
  const fetch = async function controlledResponse(request) {
    if (!rejectRequest) return consul.fetch(request)
    return new Response(
      new ReadableStream({
        cancel() {
          canceled = true
          throw new Error("published discard failed")
        }
      }),
      { status: 503 }
    )
  }
  const store = newConsulStore({ fetch, address: "http://consul.test:8500" })
  rejectRequest = true
  await expect(store.read(background(), "discard/key")).rejects.toMatchObject({
    code: "LIKEGO_CONSUL_STORE_HTTP",
    status: 503
  })
  await Promise.resolve()
  expect(canceled).toBe(true)
  consul.reset()
})
`

function storeConsulRuntimeModule(): string {
  return reviewedSuite(
    `import { background, withCancelCause } from "@likego/context"
import { cursor, expiresIn, ifRevision, limit, prefix } from "@likego/store"
import * as api from "@likego/store-consul"
import { newConsulStore } from "@likego/store-consul"
${ConsulStoreCodec}`,
    ["../../../packages/store/consul/test/helpers.ts"],
    [
      "../../../packages/store/consul/test/store.test.ts",
      "../../../packages/store/consul/test/public-api.test.ts"
    ],
    runtimeNeutralTimerReplacements,
    ConsulStorePublishedCoverage
  )
}

const EtcdStoreCodec = String.raw`
function encodeBase64(value) {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function decodeBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
function encodeText(value) { return encodeBase64(new TextEncoder().encode(value)) }
function encodeRecordPayload(value, operation, expiresAt) {
  return JSON.stringify({
    version: 1,
    operation,
    value: encodeBase64(value.value),
    metadata: value.metadata ?? {},
    expiresAt
  })
}
`

const EtcdStorePublishedCoverage = String.raw`
test("published Etcd Store observes a rejected response-body discard", async () => {
  let canceled = false
  let rejectRequest = false
  const etcd = fakeEtcd()
  const fetch = async function controlledResponse(request) {
    if (!rejectRequest) return etcd.fetch(request)
    const response = new Response("{}", { status: 503 })
    return new Proxy(response, {
      get(target, property) {
        if (property === "text") {
          return function failingBodyRead() {
            return Promise.reject(new Error("published body read failed"))
          }
        }
        if (property === "body") {
          return {
            cancel() {
              canceled = true
              return Promise.reject(new Error("published discard failed"))
            }
          }
        }
        return Reflect.get(target, property, target)
      }
    })
  }
  const store = newEtcdStore({ fetch, address: "http://etcd.test:2379" })
  rejectRequest = true
  await expect(store.read(background(), "discard/key")).rejects.toMatchObject({
    code: "LIKEGO_ETCD_STORE_HTTP",
    status: 503
  })
  await Promise.resolve()
  expect(canceled).toBe(true)
  etcd.reset()
})
`

function storeEtcdRuntimeModule(): string {
  return reviewedSuite(
    `import { background, cause, withCancel } from "@likego/context"
import { cursor, expiresIn, ifRevision, limit, prefix } from "@likego/store"
import * as api from "@likego/store-etcd"
import { newEtcdStore } from "@likego/store-etcd"
${EtcdStoreCodec}`,
    ["../../../packages/store/etcd/test/helpers.ts"],
    [
      "../../../packages/store/etcd/test/store.test.ts",
      "../../../packages/store/etcd/test/construction.test.ts",
      "../../../packages/store/etcd/test/public-api.test.ts"
    ],
    runtimeNeutralTimerReplacements,
    EtcdStorePublishedCoverage
  )
}

const ConfigEtcdTypes = String.raw`
import type { ConfigObject, ConfigSource } from "@likego/config"
import {
  etcdSource,
  jsonEtcdDecoder,
  type EtcdDecoder,
  type EtcdFetch,
  type EtcdHttpError,
  type EtcdProtocolError,
  type EtcdSourceOptions,
  type EtcdTransportError
} from "@likego/config-etcd"
const fetch: EtcdFetch = async (_request) => new Response(null)
const decoder: EtcdDecoder = (text, _key) => ({ text })
const options: EtcdSourceOptions = { fetch, address: "https://etcd.example", key: "app", decode: decoder }
const source: ConfigSource = etcdSource(options)
const decoded: ConfigObject = jsonEtcdDecoder('{"enabled":true}', "app")
declare const http: EtcdHttpError
declare const protocol: EtcdProtocolError
declare const transport: EtcdTransportError
void [source, decoded, http, protocol, transport]
`

const RegistryKubernetesTypes = String.raw`
import type { Registry } from "@likego/registry"
import {
  newKubernetesRegistry,
  type KubernetesFetch,
  type KubernetesHttpError,
  type KubernetesOperation,
  type KubernetesRegistry,
  type KubernetesRegistryOptions,
  type KubernetesTransportError
} from "@likego/registry-kubernetes"
const fetch: KubernetesFetch = async (_input, _init) => new Response(null)
const options: KubernetesRegistryOptions = { fetch, address: "https://kubernetes.example", namespace: "default" }
const common: Registry = newKubernetesRegistry(options)
const concrete: KubernetesRegistry = newKubernetesRegistry(options)
declare const operation: KubernetesOperation
declare const http: KubernetesHttpError
declare const transport: KubernetesTransportError
void [common, concrete, operation, http, transport]
`

const RegistryZookeeperTypes = String.raw`
import type { Registry } from "@likego/registry"
import {
  newZookeeperRegistry,
  type ZookeeperAcl,
  type ZookeeperAuthenticationError,
  type ZookeeperClient,
  type ZookeeperClientFactory,
  type ZookeeperClientFactoryOptions,
  type ZookeeperOperation,
  type ZookeeperOperationError,
  type ZookeeperRegistry,
  type ZookeeperRegistryOptions
} from "@likego/registry-zookeeper"
declare const client: ZookeeperClient
const factory: ZookeeperClientFactory = (_options: ZookeeperClientFactoryOptions) => client
const acl: ZookeeperAcl = "open"
const options: ZookeeperRegistryOptions = { address: "zookeeper:2181", acl, clientFactory: factory }
const common: Registry = newZookeeperRegistry(options)
const concrete: ZookeeperRegistry = newZookeeperRegistry(options)
declare const operation: ZookeeperOperation
declare const native: ZookeeperOperationError
declare const auth: ZookeeperAuthenticationError
void [common, concrete, operation, native, auth]
`

function storeRootTypeConsumer(): string {
  return typeFixture("../../../packages/store/test/public-types.ts", [
    ['"../src/index"', '"@likego/store"'],
    ['"../src/provider"', '"@likego/store/provider"']
  ])
}

function fileStoreRootTypeConsumer(): string {
  let fixture = typeFixture("../../../packages/store/file/test/public-types.ts", [
    ['"../../src/index"', '"@likego/store"'],
    ['"../src/index"', '"@likego/store-file"']
  ])
  fixture = requiredReplacement(fixture, 'import { newNodeFileStoreHost } from "../src/node"\n', "")
  return requiredReplacement(
    fixture,
    "const host: FileStoreHost = newNodeFileStoreHost()",
    "declare const host: FileStoreHost"
  )
}

const FileStoreNodeTypes = String.raw`
import type { FileStoreHost } from "@likego/store-file"
import { newNodeFileStoreHost } from "@likego/store-file/node"
const host: FileStoreHost = newNodeFileStoreHost()
void host
`

/** Registers the framework-completion packages against installed tarball behavior. */
export function registerCompletionCases(registry: PublishedBusinessCaseRegistry): void {
  const cacheTypes = typeFixture("../../../packages/cache/test/public-types.ts", [
    ['"../src/index"', '"@likego/cache"'],
    ['"../src/provider"', '"@likego/cache/provider"']
  ])
  registry.register({
    package: "@likego/cache",
    exports: [".", "./provider"],
    runtimeModule: cacheRootRuntimeModule(),
    typeConsumer: cacheTypes
  })
  registry.register({
    package: "@likego/cache-memory",
    exports: ["."],
    runtimeModule: cacheMemoryRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/cache/memory/test/public-types.ts", [
      ['"../src/index"', '"@likego/cache-memory"']
    ])
  })
  registry.register({
    package: "@likego/cache-redis",
    exports: ["."],
    runtimeModule: RedisCacheRuntime,
    typeConsumer: typeFixture("../../../packages/cache/redis/test/public-types.ts", [
      ['"../src/index"', '"@likego/cache-redis"']
    ])
  })
  registry.register({
    package: "@likego/config-vault",
    exports: ["."],
    runtimeModule: configVaultRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/config/vault/test/public-types.ts", [
      ['"../src/index"', '"@likego/config-vault"']
    ])
  })
  registry.register({
    package: "@likego/store-vault",
    exports: ["."],
    runtimeModule: storeVaultRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/store/vault/test/public-types.ts", [
      ['"../src/index"', '"@likego/store-vault"']
    ])
  })
  registry.register({
    package: "@likego/broker",
    exports: [".", "./provider"],
    runtimeModule: brokerRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/broker/test/public-types.ts", [
      ['"../src/index"', '"@likego/broker"'],
      ['"../src/provider"', '"@likego/broker/provider"']
    ])
  })
  registry.register({
    package: "@likego/broker-memory",
    exports: ["."],
    runtimeModule: brokerMemoryRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/broker/memory/test/public-types.ts", [
      ['"../src/index"', '"@likego/broker-memory"']
    ])
  })
  registry.register({
    package: "@likego/broker-rabbitmq",
    exports: ["."],
    runtimeModule: readFileSync(
      new URL(
        "../../../packages/broker/rabbitmq/test/runtime/published-runtime.fixture",
        import.meta.url
      ),
      "utf8"
    ),
    typeConsumer: typeFixture("../../../packages/broker/rabbitmq/test/public-types.ts", [
      ['"../src/index"', '"@likego/broker-rabbitmq"']
    ])
  })
  registry.register({
    package: "@likego/event",
    exports: ["."],
    runtimeModule: eventRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/event/test/public-types.ts", [
      ['"../src/index"', '"@likego/event"']
    ])
  })
  registry.register({
    package: "@likego/config-etcd",
    exports: ["."],
    runtimeModule: configEtcdRuntimeModule(),
    typeConsumer: ConfigEtcdTypes
  })
  registry.register({
    package: "@likego/config-kubernetes",
    exports: ["."],
    runtimeModule: readFileSync(
      new URL(
        "../../../packages/config/kubernetes/test/runtime/published-runtime.fixture",
        import.meta.url
      ),
      "utf8"
    ),
    typeConsumer: typeFixture("../../../packages/config/kubernetes/test/public-types.ts", [
      ['"../src/index"', '"@likego/config-kubernetes"']
    ])
  })
  registry.register({
    package: "@likego/registry-etcd",
    exports: ["."],
    runtimeModule: registryEtcdRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/registry/etcd/test/public-types.ts", [
      ['"../src/index"', '"@likego/registry-etcd"']
    ])
  })
  registry.register({
    package: "@likego/registry-kubernetes",
    exports: ["."],
    runtimeModule: publishedBehaviorRuntimeModule(
      "../../../packages/registry/kubernetes/test/integration/published-behavior.ts",
      "runKubernetesPublishedBehavior"
    ),
    typeConsumer: RegistryKubernetesTypes
  })
  registry.register({
    package: "@likego/registry-zookeeper",
    exports: ["."],
    nodePreloadModule: zookeeperNodePreloadModule,
    runtimeModule: zookeeperRuntimeModule(),
    typeConsumer: RegistryZookeeperTypes
  })
  registry.register({
    package: "@likego/store",
    exports: [".", "./provider"],
    runtimeModule: storeRootRuntimeModule(),
    typeConsumer: storeRootTypeConsumer()
  })
  registry.register({
    package: "@likego/store-memory",
    exports: ["."],
    runtimeModule: storeMemoryRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/store/memory/test/public-types.ts", [
      ['"../../src/index"', '"@likego/store"'],
      ['"../src/index"', '"@likego/store-memory"']
    ])
  })
  registry.register({
    package: "@likego/store-file",
    exports: [".", "./node"],
    runtimeModule: FileStoreRuntime,
    typeConsumer: typeFixture("../../../packages/store/file/test/public-types.ts", [
      ['"../../src/index"', '"@likego/store"'],
      ['"../src/index"', '"@likego/store-file"'],
      ['"../src/node"', '"@likego/store-file/node"']
    ]),
    runtimeModules: { ".": FileStoreRuntime, "./node": FileStoreNodeRuntime },
    typeConsumers: {
      ".": fileStoreRootTypeConsumer(),
      "./node": FileStoreNodeTypes
    }
  })
  registry.register({
    package: "@likego/store-consul",
    exports: ["."],
    runtimeModule: storeConsulRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/store/consul/test/public-types.ts", [
      ['"../src/index"', '"@likego/store-consul"']
    ])
  })
  registry.register({
    package: "@likego/store-etcd",
    exports: ["."],
    runtimeModule: storeEtcdRuntimeModule(),
    typeConsumer: typeFixture("../../../packages/store/etcd/test/public-types.ts", [
      ['"../src/index"', '"@likego/store-etcd"']
    ])
  })
}
