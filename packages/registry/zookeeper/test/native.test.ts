import { describe, expect, mock, test } from "bun:test"

import type { ZookeeperClientFactoryOptions, ZookeeperMutation } from "../src/types"

type NativeCallback = (error: unknown, value?: unknown) => void

interface ListenerRecord {
  readonly listener: () => void
  readonly once: boolean
}

interface NativeProbe {
  readonly listeners: Map<string, ListenerRecord[]>
  readonly held: Map<string, NativeCallback>
  readonly callbackErrors: Map<string, unknown>
  readonly synchronousErrors: Map<string, unknown>
  readonly transactionCalls: string[]
  readonly authCalls: string[]
  readonly mkdirpCalls: string[]
  readonly removeCalls: string[]
  readonly client: Record<string, unknown>
  connectEvent: "connected" | "authenticationFailed" | "hold"
  closeEvent: "disconnected" | "hold"
  children: string[]
  data: Buffer
  watchListener: NativeCallback | null
  closeCalls: number
  /** Emits one native client event. */
  emit(event: string): void
  /** Holds the next callback operation instead of completing it. */
  hold(operation: string): void
  /** Completes one previously held callback. */
  complete(operation: string, error?: unknown): void
}

const probes: NativeProbe[] = []
const openAcl = Object.freeze([{ id: "open" }])
const creatorAcl = Object.freeze([{ id: "creator" }])
const nativeAcl = {
  OPEN_ACL_UNSAFE: openAcl,
  CREATOR_ALL_ACL: creatorAcl
}

/** Creates one callback/event-shaped native client probe. */
function newProbe(): NativeProbe {
  const listeners = new Map<string, ListenerRecord[]>()
  const held = new Map<string, NativeCallback>()
  const callbackErrors = new Map<string, unknown>()
  const synchronousErrors = new Map<string, unknown>()
  const transactionCalls: string[] = []
  const authCalls: string[] = []
  const mkdirpCalls: string[] = []
  const removeCalls: string[] = []
  const heldOperations = new Set<string>()

  /** Takes one configured synchronous error. */
  function throwIfConfigured(operation: string): void {
    const value = synchronousErrors.get(operation)
    if (value === undefined) return
    synchronousErrors.delete(operation)
    throw value
  }

  /** Runs or retains one callback operation. */
  function callback(operation: string, done: NativeCallback, value?: unknown): void {
    throwIfConfigured(operation)
    if (heldOperations.delete(operation)) {
      held.set(operation, done)
      return
    }
    const error = callbackErrors.get(operation)
    callbackErrors.delete(operation)
    done(error ?? null, value)
  }

  const probe: NativeProbe = {
    listeners,
    held,
    callbackErrors,
    synchronousErrors,
    transactionCalls,
    authCalls,
    mkdirpCalls,
    removeCalls,
    client: {},
    connectEvent: "connected",
    closeEvent: "disconnected",
    children: ["z", "a"],
    data: Buffer.from([1, 2, 3]),
    watchListener: null,
    closeCalls: 0,
    emit(event: string): void {
      const records = Array.from(listeners.get(event) ?? [])
      for (const record of records) {
        if (record.once) {
          const current = listeners.get(event) ?? []
          listeners.set(
            event,
            current.filter(function retained(candidate): boolean {
              return candidate !== record
            })
          )
        }
        record.listener()
      }
    },
    hold(operation: string): void {
      heldOperations.add(operation)
    },
    complete(operation: string, error: unknown = null): void {
      const done = held.get(operation)
      if (done === undefined) throw new Error(`missing held ${operation}`)
      held.delete(operation)
      const value = operation === "data" ? probe.data : probe.children
      done(error, value)
    }
  }

  /** Adds one persistent or one-shot event listener. */
  function addListener(event: string, listener: () => void, once: boolean): void {
    const current = listeners.get(event) ?? []
    current.push({ listener, once })
    listeners.set(event, current)
  }

  /** Removes one exact event listener. */
  function removeListener(event: string, listener: () => void): void {
    const current = listeners.get(event) ?? []
    listeners.set(
      event,
      current.filter(function retained(record): boolean {
        return record.listener !== listener
      })
    )
  }

  Object.assign(probe.client, {
    addAuthInfo(scheme: string, credential: Buffer): void {
      authCalls.push(`${scheme}:${credential.toString("utf8")}`)
    },
    on(event: string, listener: () => void): void {
      addListener(event, listener, false)
    },
    once(event: string, listener: () => void): void {
      addListener(event, listener, true)
    },
    removeListener,
    connect(): void {
      throwIfConfigured("connect")
      if (probe.connectEvent !== "hold") probe.emit(probe.connectEvent)
    },
    close(): void {
      probe.closeCalls += 1
      throwIfConfigured("close")
      if (probe.closeEvent !== "hold") probe.emit(probe.closeEvent)
    },
    mkdirp(
      path: string,
      _data: Buffer,
      _acls: readonly unknown[],
      _mode: number,
      done: NativeCallback
    ): void {
      mkdirpCalls.push(path)
      callback("mkdirp", done)
    },
    getChildren(
      _path: string,
      watcherOrDone: (() => void) | NativeCallback,
      maybeDone?: NativeCallback
    ): void {
      if (maybeDone === undefined) callback("children", watcherOrDone, probe.children)
      else {
        probe.watchListener = watcherOrDone
        callback("watch-children", maybeDone, probe.children)
      }
    },
    getData(_path: string, done: NativeCallback): void {
      callback("data", done, probe.data)
    },
    transaction(): Record<string, unknown> {
      const transaction: Record<string, unknown> = {}
      Object.assign(transaction, {
        create(
          path: string,
          data: Buffer,
          _acls: readonly unknown[],
          mode: number
        ): Record<string, unknown> {
          transactionCalls.push(`create:${path}:${data.toString("utf8")}:${mode}`)
          return transaction
        },
        remove(path: string, version: number): Record<string, unknown> {
          transactionCalls.push(`remove:${path}:${version}`)
          return transaction
        },
        commit(done: NativeCallback): void {
          callback("mutate", done)
        }
      })
      return transaction
    },
    remove(path: string, version: number, done: NativeCallback): void {
      removeCalls.push(`${path}:${version}`)
      callback("remove", done)
    }
  })
  return probe
}

mock.module("node-zookeeper-client", function nativeModule() {
  return {
    ACL: nativeAcl,
    CreateMode: {
      PERSISTENT: 11,
      EPHEMERAL: 22
    },
    Exception: {
      NO_NODE: -101
    },
    createClient(): Record<string, unknown> {
      const probe = newProbe()
      probes.push(probe)
      return probe.client
    }
  }
})

const { newNativeZookeeperClient } = await import("../src/native")

/** Creates one valid native-client option fixture. */
function options(
  acl: "open" | "creator" = "open",
  auth: ZookeeperClientFactoryOptions["auth"] = null
): ZookeeperClientFactoryOptions {
  return {
    connectionString: "127.0.0.1:2181",
    sessionTimeoutMs: 4_000,
    spinDelayMs: 10,
    retries: 0,
    auth,
    acl
  }
}

/** Returns the latest native probe created by the module mock. */
function latest(): NativeProbe {
  const probe = probes.at(-1)
  if (probe === undefined) throw new Error("native probe was not created")
  return probe
}

/** Creates one native-shaped coded exception without retaining a message. */
function coded(code: number): { getCode(): number } {
  return {
    getCode(): number {
      return code
    }
  }
}

describe("native ZooKeeper adapter", function nativeAdapter(): void {
  test("fails closed when the installed native client omits an ACL constant", function missingAcl() {
    const original = Object.getOwnPropertyDescriptor(nativeAcl, "OPEN_ACL_UNSAFE")
    Reflect.deleteProperty(nativeAcl, "OPEN_ACL_UNSAFE")
    try {
      expect(function construct(): void {
        newNativeZookeeperClient(options())
      }).toThrow("omitted OPEN_ACL_UNSAFE")
    } finally {
      if (original !== undefined) Object.defineProperty(nativeAcl, "OPEN_ACL_UNSAFE", original)
    }
  })

  test("constructs ACL/auth snapshots and maps every state event", async function constructorAndState() {
    const credential = new TextEncoder().encode("user:secret")
    const client = newNativeZookeeperClient(options("creator", { scheme: "digest", credential }))
    const probe = latest()
    expect(probe.authCalls).toEqual(["digest:user:secret"])

    const states: string[] = []
    const unsubscribe = client.onState(function observed(state): void {
      states.push(state)
    })
    probe.emit("connected")
    probe.emit("disconnected")
    probe.emit("expired")
    probe.emit("authenticationFailed")
    expect(states).toEqual(["connected", "disconnected", "expired", "authentication-failed"])
    unsubscribe()
    probe.emit("connected")
    expect(states).toHaveLength(4)

    await client.connect(new AbortController().signal)
    await client.close(new AbortController().signal)
    expect(probe.closeCalls).toBe(1)
  })

  test("connect rejects authentication, aborts, and synchronous coded failures exactly", async function connectFailures() {
    const authenticationClient = newNativeZookeeperClient(options())
    latest().connectEvent = "authenticationFailed"
    await expect(authenticationClient.connect(new AbortController().signal)).rejects.toMatchObject({
      code: "LIKEGO_ZOOKEEPER_AUTHENTICATION"
    })

    const preAborted = newNativeZookeeperClient(options())
    const exact = new Error("exact connect cancellation")
    const canceled = new AbortController()
    canceled.abort(exact)
    await expect(preAborted.connect(canceled.signal)).rejects.toBe(exact)

    const nonErrorAbort = newNativeZookeeperClient(options())
    const nonError = new AbortController()
    nonError.abort("hidden")
    await expect(nonErrorAbort.connect(nonError.signal)).rejects.toMatchObject({
      operation: "connect",
      nativeCode: null
    })

    const inFlight = newNativeZookeeperClient(options())
    const inFlightProbe = latest()
    inFlightProbe.connectEvent = "hold"
    const controller = new AbortController()
    const promise = inFlight.connect(controller.signal)
    controller.abort(exact)
    await expect(promise).rejects.toBe(exact)
    expect(inFlightProbe.closeCalls).toBe(1)

    const throwing = newNativeZookeeperClient(options())
    latest().synchronousErrors.set("connect", coded(-4))
    await expect(throwing.connect(new AbortController().signal)).rejects.toMatchObject({
      operation: "connect",
      nativeCode: -4,
      retryable: true
    })
  })

  test("close rejects pre-abort, in-flight abort, and synchronous failures", async function closeFailures() {
    const preAborted = newNativeZookeeperClient(options())
    const exact = new Error("exact close cancellation")
    const canceled = new AbortController()
    canceled.abort(exact)
    await expect(preAborted.close(canceled.signal)).rejects.toBe(exact)

    const inFlight = newNativeZookeeperClient(options())
    const inFlightProbe = latest()
    inFlightProbe.closeEvent = "hold"
    const controller = new AbortController()
    const promise = inFlight.close(controller.signal)
    controller.abort(exact)
    await expect(promise).rejects.toBe(exact)
    inFlightProbe.emit("disconnected")

    const throwing = newNativeZookeeperClient(options())
    latest().synchronousErrors.set("close", new Error("native close text"))
    await expect(throwing.close(new AbortController().signal)).rejects.toMatchObject({
      operation: "close",
      nativeCode: null,
      retryable: false
    })
  })

  test("adapts successful child, watch, data, mutation, and remove operations", async function operations() {
    const client = newNativeZookeeperClient(options())
    const probe = latest()
    const signal = new AbortController().signal

    await client.mkdirp("/likego", signal)
    expect(probe.mkdirpCalls).toEqual(["/likego"])
    expect(await client.children("/likego", signal)).toEqual({ names: ["a", "z"] })

    let watchCalls = 0
    expect(
      await client.watchChildren(
        "/likego",
        function watched(): void {
          watchCalls += 1
        },
        signal
      )
    ).toEqual({ names: ["a", "z"] })
    probe.watchListener?.(null)
    expect(watchCalls).toBe(1)

    const firstData = await client.data("/likego/a", signal)
    firstData[0] = 99
    expect(probe.data[0]).toBe(1)

    await client.mutate([], signal)
    const mutations: readonly ZookeeperMutation[] = [
      { kind: "create-ephemeral", path: "/likego/a", data: new TextEncoder().encode("wire") },
      { kind: "delete", path: "/likego/b" }
    ]
    await client.mutate(mutations, signal)
    expect(probe.transactionCalls).toEqual(["create:/likego/a:wire:22", "remove:/likego/b:-1"])
    expect(await client.remove("/likego/a", signal)).toBe(true)
    expect(probe.removeCalls).toEqual(["/likego/a:-1"])
  })

  test("callback operations preserve aborts and sanitize every native failure shape", async function callbackFailures() {
    const operations = ["mkdirp", "children", "watch-children", "data", "mutate", "remove"] as const
    for (const operation of operations) {
      const client = newNativeZookeeperClient(options())
      const probe = latest()
      probe.callbackErrors.set(operation, coded(operation === "remove" ? -102 : -7))
      const signal = new AbortController().signal
      const promise =
        operation === "mkdirp"
          ? client.mkdirp("/x", signal)
          : operation === "children"
            ? client.children("/x", signal)
            : operation === "watch-children"
              ? client.watchChildren("/x", function watched(): void {}, signal)
              : operation === "data"
                ? client.data("/x", signal)
                : operation === "mutate"
                  ? client.mutate([{ kind: "delete", path: "/x" }], signal)
                  : client.remove("/x", signal)
      await expect(promise).rejects.toMatchObject({
        operation,
        nativeCode: operation === "remove" ? -102 : -7
      })
    }

    const missing = newNativeZookeeperClient(options())
    latest().callbackErrors.set("remove", coded(-101))
    expect(await missing.remove("/missing", new AbortController().signal)).toBe(false)

    const throwing = newNativeZookeeperClient(options())
    latest().synchronousErrors.set("children", new Error("native text"))
    await expect(throwing.children("/x", new AbortController().signal)).rejects.toMatchObject({
      operation: "children",
      nativeCode: null
    })

    const throwingMutation = newNativeZookeeperClient(options())
    latest().synchronousErrors.set("mutate", new Error("native commit text"))
    await expect(
      throwingMutation.mutate([{ kind: "delete", path: "/x" }], new AbortController().signal)
    ).rejects.toMatchObject({ operation: "mutate", nativeCode: null })

    const exact = new Error("exact callback cancellation")
    const held = newNativeZookeeperClient(options())
    const heldProbe = latest()
    heldProbe.hold("data")
    const controller = new AbortController()
    const promise = held.data("/x", controller.signal)
    controller.abort(exact)
    await expect(promise).rejects.toBe(exact)
    heldProbe.complete("data")

    const preAborted = newNativeZookeeperClient(options())
    const canceled = new AbortController()
    canceled.abort(exact)
    await expect(preAborted.mkdirp("/x", canceled.signal)).rejects.toBe(exact)
  })

  test("submitted multi reports its real callback outcome after caller cancellation", async function committedCancellation() {
    const client = newNativeZookeeperClient(options())
    const probe = latest()
    probe.hold("mutate")
    const controller = new AbortController()
    const exact = new Error("caller stopped waiting for committed multi")
    const pending = client.mutate([{ kind: "delete", path: "/x" }], controller.signal)
    let settled = false
    void pending.finally(function observed(): void {
      settled = true
    })

    controller.abort(exact)
    await Promise.resolve()
    expect(settled).toBe(false)
    probe.complete("mutate")
    await expect(pending).resolves.toBeUndefined()
    expect(settled).toBe(true)

    const canceled = new AbortController()
    canceled.abort(exact)
    await expect(client.mutate([{ kind: "delete", path: "/x" }], canceled.signal)).rejects.toBe(
      exact
    )
  })
})
