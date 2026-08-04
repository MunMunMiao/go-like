import { newAuthenticationError, newOperationError } from "../src/errors"
import type { ServiceInstance } from "@go-like/registry"
import type {
  ZookeeperClient,
  ZookeeperClientFactory,
  ZookeeperClientFactoryOptions,
  ZookeeperClientState,
  ZookeeperMutation,
  ZookeeperOperation
} from "../src/index"

interface NodeState {
  readonly data: Uint8Array
  readonly owner: number | null
  readonly credential: string | null
}

interface ClientState {
  readonly id: number
  readonly listeners: Set<(state: ZookeeperClientState) => void>
  readonly options: ZookeeperClientFactoryOptions
  connected: boolean
  closed: boolean
}

interface WatchState {
  readonly session: ClientState
  readonly listener: () => void
}

/** Controls one deterministic shared ZooKeeper tree. */
export interface FakeZookeeper {
  readonly factory: ZookeeperClientFactory
  /** Returns all non-root znode paths in byte-stable order. */
  paths(): readonly string[]
  /** Returns the number of currently connected native sessions. */
  activeSessions(): number
  /** Returns the number of fake clients ever created. */
  sessionCount(): number
  /** Returns the number of native close invocations across every fake client. */
  closeCalls(): number
  /** Expires every active session and removes all ephemeral nodes. */
  expireSessions(): void
  /** Drops exactly the next child-watch notification. */
  dropNextWatch(): void
  /** Returns watch installation count for one path. */
  watchCount(path: string): number
  /** Makes future authenticated connections fail. */
  rejectAuthentication(): void
  /** Fails the next exact native operation before it mutates state. */
  failNext(operation: ZookeeperOperation, nativeCode: number): void
  /** Holds the next mutation result after its atomic tree commit. */
  holdMutationResult(): void
  /** Releases one held post-commit mutation result. */
  releaseMutationResult(): void
  /** Holds the next successful connect result after its session becomes observable. */
  holdConnectResult(): void
  /** Releases one held successful connect result. */
  releaseConnectResult(): void
  /** Corrupts one future fake commit to exercise provider readback defenses. */
  corruptNextMutation(kind: "omit-create" | "retain-delete"): void
  /** Returns the number of attached session-state listeners. */
  stateListenerCount(): number
  /** Holds the next close call for hard-drain deadline tests. */
  holdClose(): void
  /** Releases one held close call. */
  releaseClose(): void
  /** Emits authentication failure on every active session. */
  emitAuthenticationFailure(): void
  /** Emits a connected state on every active session. */
  emitConnected(): void
  /** Writes one raw ephemeral record through a new backend session. */
  putRaw(path: string, data: Uint8Array): Promise<ZookeeperClient>
}

/** Returns one path's parent. */
function parent(path: string): string {
  const index = path.lastIndexOf("/")
  return index <= 0 ? "/" : path.slice(0, index)
}

/** Converts secret bytes to a deterministic internal comparison key. */
function credential(options: ZookeeperClientFactoryOptions): string | null {
  if (options.auth === null) return null
  return `${options.auth.scheme}:${Array.from(options.auth.credential).join(".")}`
}

/** Creates one native-shaped operation failure for the fake boundary. */
function failure(operation: ZookeeperOperation, code: number): Error {
  return newOperationError(operation, code, code === -4 || code === -7 || code === -112)
}

/** Throws the exact signal reason before one fake operation mutates state. */
function checkSignal(signal: AbortSignal, operation: ZookeeperOperation): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : failure(operation, -7)
  }
}

/** Creates one deterministic in-memory ZooKeeper ensemble. */
export function fakeZookeeper(): FakeZookeeper {
  const nodes = new Map<string, NodeState>()
  nodes.set("/", { data: new Uint8Array(), owner: null, credential: null })
  const sessions = new Set<ClientState>()
  const watches = new Map<string, Set<WatchState>>()
  const watchCalls = new Map<string, number>()
  let nextSession = 1
  let dropWatch = false
  let rejectAuth = false
  let connectGate: PromiseWithResolvers<void> | null = null
  let mutationGate: PromiseWithResolvers<void> | null = null
  let mutationCorruption: "omit-create" | "retain-delete" | null = null
  let closeGate: PromiseWithResolvers<void> | null = null
  let closes = 0
  const failures = new Map<ZookeeperOperation, number[]>()

  /** Throws one configured exact operation failure. */
  function maybeFail(operation: ZookeeperOperation): void {
    const queued = failures.get(operation)
    const code = queued?.shift()
    if (code !== undefined) throw failure(operation, code)
  }

  /** Requires one usable connected session. */
  function checkClient(session: ClientState, operation: ZookeeperOperation): void {
    if (!session.connected || session.closed) throw failure(operation, -4)
  }

  /** Requires the caller to satisfy one node's creator ACL. */
  function authorize(session: ClientState, node: NodeState, operation: ZookeeperOperation): void {
    if (node.credential !== null && node.credential !== credential(session.options)) {
      throw failure(operation, -102)
    }
  }

  /** Emits one state transition to a stable listener snapshot. */
  function emitState(session: ClientState, state: ZookeeperClientState): void {
    for (const listener of Array.from(session.listeners)) listener(state)
  }

  /** Fires and removes one-shot child watchers on a parent path. */
  function notify(path: string): void {
    const listeners = watches.get(path)
    if (listeners === undefined) return
    watches.delete(path)
    if (dropWatch) {
      dropWatch = false
      return
    }
    for (const watch of listeners) {
      if (watch.session.connected && !watch.session.closed) queueMicrotask(watch.listener)
    }
  }

  /** Returns exact direct child names. */
  function childNames(path: string): readonly string[] {
    const prefix = path === "/" ? "/" : `${path}/`
    const result = new Set<string>()
    for (const candidate of nodes.keys()) {
      if (!candidate.startsWith(prefix) || candidate === path) continue
      const tail = candidate.slice(prefix.length)
      if (!tail.includes("/")) result.add(tail)
    }
    return Object.freeze(Array.from(result).sort())
  }

  /** Removes every ephemeral node owned by one exact session. */
  function removeEphemeral(session: ClientState): void {
    const removed: string[] = []
    for (const [path, node] of nodes) {
      if (node.owner === session.id) {
        nodes.delete(path)
        removed.push(path)
      }
    }
    for (const path of removed) notify(parent(path))
  }

  /** Creates one disconnected client over this shared tree. */
  const factory: ZookeeperClientFactory = function create(
    options: ZookeeperClientFactoryOptions
  ): ZookeeperClient {
    const session: ClientState = {
      id: nextSession++,
      listeners: new Set(),
      options,
      connected: false,
      closed: false
    }
    sessions.add(session)

    return Object.freeze({
      /** Opens one fake session. */
      async connect(signal: AbortSignal): Promise<void> {
        checkSignal(signal, "connect")
        maybeFail("connect")
        if (rejectAuth && options.auth !== null) {
          emitState(session, "authentication-failed")
          throw newAuthenticationError()
        }
        session.connected = true
        emitState(session, "connected")
        const gate = connectGate
        if (gate !== null) {
          await gate.promise
          if (connectGate === gate) connectGate = null
        }
      },
      /** Closes and expires all owned ephemeral nodes. */
      async close(signal: AbortSignal): Promise<void> {
        closes += 1
        checkSignal(signal, "close")
        maybeFail("close")
        const gate = closeGate
        if (gate !== null) {
          await gate.promise
          if (closeGate === gate) closeGate = null
        }
        if (session.closed) return
        removeEphemeral(session)
        session.connected = false
        session.closed = true
        emitState(session, "disconnected")
      },
      /** Attaches one state listener. */
      onState(listener: (state: ZookeeperClientState) => void): () => void {
        session.listeners.add(listener)
        /** Detaches exactly this state listener. */
        function unsubscribe(): void {
          session.listeners.delete(listener)
        }
        return unsubscribe
      },
      /** Creates each missing persistent path component. */
      async mkdirp(path: string, signal: AbortSignal): Promise<void> {
        checkSignal(signal, "mkdirp")
        checkClient(session, "mkdirp")
        maybeFail("mkdirp")
        let current = ""
        for (const segment of path.slice(1).split("/")) {
          current += `/${segment}`
          const existing = nodes.get(current)
          if (existing !== undefined) {
            authorize(session, existing, "mkdirp")
            continue
          }
          const parentNode = nodes.get(parent(current))
          if (parentNode === undefined) throw failure("mkdirp", -101)
          authorize(session, parentNode, "mkdirp")
          nodes.set(current, {
            data: new Uint8Array(),
            owner: null,
            credential: options.acl === "creator" ? credential(options) : null
          })
          notify(parent(current))
        }
      },
      /** Reads direct children. */
      async children(path: string, signal: AbortSignal) {
        checkSignal(signal, "children")
        checkClient(session, "children")
        maybeFail("children")
        const node = nodes.get(path)
        if (node === undefined) throw failure("children", -101)
        authorize(session, node, "children")
        return Object.freeze({ names: childNames(path) })
      },
      /** Reads direct children and installs a one-shot watch. */
      async watchChildren(path: string, listener: () => void, signal: AbortSignal) {
        checkSignal(signal, "watch-children")
        checkClient(session, "watch-children")
        maybeFail("watch-children")
        const node = nodes.get(path)
        if (node === undefined) throw failure("watch-children", -101)
        authorize(session, node, "watch-children")
        let listeners = watches.get(path)
        if (listeners === undefined) {
          listeners = new Set<WatchState>()
          watches.set(path, listeners)
        }
        listeners.add({ session, listener })
        watchCalls.set(path, (watchCalls.get(path) ?? 0) + 1)
        return Object.freeze({ names: childNames(path) })
      },
      /** Reads one exact payload. */
      async data(path: string, signal: AbortSignal): Promise<Uint8Array> {
        checkSignal(signal, "data")
        checkClient(session, "data")
        maybeFail("data")
        const node = nodes.get(path)
        if (node === undefined) throw failure("data", -101)
        authorize(session, node, "data")
        return node.data.slice()
      },
      /** Atomically validates and applies one mutation group. */
      async mutate(mutations: readonly ZookeeperMutation[], signal: AbortSignal): Promise<void> {
        checkSignal(signal, "mutate")
        checkClient(session, "mutate")
        maybeFail("mutate")
        const projected = new Map(nodes)
        for (const mutation of mutations) {
          if (mutation.kind === "create-ephemeral") {
            if (projected.has(mutation.path)) throw failure("mutate", -110)
            const parentNode = projected.get(parent(mutation.path))
            if (parentNode === undefined) throw failure("mutate", -101)
            authorize(session, parentNode, "mutate")
            projected.set(mutation.path, {
              data: mutation.data.slice(),
              owner: session.id,
              credential: options.acl === "creator" ? credential(options) : null
            })
          } else {
            const target = projected.get(mutation.path)
            if (target === undefined) throw failure("mutate", -101)
            authorize(session, target, "mutate")
            const prefix = `${mutation.path}/`
            for (const candidate of projected.keys()) {
              if (candidate.startsWith(prefix)) throw failure("mutate", -111)
            }
            projected.delete(mutation.path)
          }
        }
        const corruption = mutationCorruption
        mutationCorruption = null
        if (corruption === "omit-create") {
          const created = mutations.find(function created(mutation): boolean {
            return mutation.kind === "create-ephemeral"
          })
          if (created?.kind === "create-ephemeral") projected.delete(created.path)
        } else if (corruption === "retain-delete") {
          const deleted = mutations.find(function deleted(mutation): boolean {
            return mutation.kind === "delete"
          })
          if (deleted?.kind === "delete") {
            const retained = nodes.get(deleted.path)
            if (retained !== undefined) projected.set(deleted.path, retained)
          }
        }
        const changed = new Set<string>()
        for (const mutation of mutations) changed.add(parent(mutation.path))
        nodes.clear()
        for (const [path, node] of projected) nodes.set(path, node)
        for (const path of changed) notify(path)
        const gate = mutationGate
        if (gate !== null) {
          await gate.promise
          if (mutationGate === gate) mutationGate = null
        }
      },
      /** Removes one empty exact node. */
      async remove(path: string, signal: AbortSignal): Promise<boolean> {
        checkSignal(signal, "remove")
        checkClient(session, "remove")
        maybeFail("remove")
        const node = nodes.get(path)
        if (node === undefined) return false
        authorize(session, node, "remove")
        const prefix = `${path}/`
        for (const candidate of nodes.keys()) {
          if (candidate.startsWith(prefix)) throw failure("remove", -111)
        }
        nodes.delete(path)
        notify(parent(path))
        return true
      }
    })
  }

  return Object.freeze({
    factory,
    /** Lists all exact non-root paths. */
    paths(): readonly string[] {
      return Object.freeze(
        Array.from(nodes.keys())
          .filter(function nonRoot(path): boolean {
            return path !== "/"
          })
          .sort()
      )
    },
    /** Counts currently connected sessions. */
    activeSessions(): number {
      let count = 0
      for (const session of sessions) if (session.connected && !session.closed) count += 1
      return count
    },
    /** Counts all clients so recovery admission can be observed deterministically. */
    sessionCount(): number {
      return sessions.size
    },
    /** Counts every attempted native close call. */
    closeCalls(): number {
      return closes
    },
    /** Expires every current session. */
    expireSessions(): void {
      for (const session of Array.from(sessions)) {
        if (!session.connected || session.closed) continue
        removeEphemeral(session)
        session.connected = false
        emitState(session, "expired")
      }
    },
    /** Suppresses one one-shot notification. */
    dropNextWatch(): void {
      dropWatch = true
    },
    /** Returns exact watch installation count. */
    watchCount(path: string): number {
      return watchCalls.get(path) ?? 0
    },
    /** Rejects future authenticated connection attempts. */
    rejectAuthentication(): void {
      rejectAuth = true
    },
    /** Queues one exact native operation failure. */
    failNext(operation: ZookeeperOperation, nativeCode: number): void {
      let queued = failures.get(operation)
      if (queued === undefined) {
        queued = []
        failures.set(operation, queued)
      }
      queued.push(nativeCode)
    },
    /** Delays one mutation Promise only after the atomic tree update is observable. */
    holdMutationResult(): void {
      if (mutationGate !== null) throw new Error("a fake mutation result is already held")
      mutationGate = Promise.withResolvers<void>()
    },
    /** Allows one delayed mutation Promise to report its committed outcome. */
    releaseMutationResult(): void {
      if (mutationGate === null) throw new Error("no fake mutation result is held")
      mutationGate.resolve()
    },
    /** Delays the next successful connect callback after opening its session. */
    holdConnectResult(): void {
      if (connectGate !== null) throw new Error("a fake connect result is already held")
      connectGate = Promise.withResolvers<void>()
    },
    /** Allows one delayed successful connect callback to return. */
    releaseConnectResult(): void {
      if (connectGate === null) throw new Error("no fake connect result is held")
      connectGate.resolve()
    },
    /** Configures one deliberately non-conforming commit result for readback tests. */
    corruptNextMutation(kind: "omit-create" | "retain-delete"): void {
      mutationCorruption = kind
    },
    /** Counts exact live state subscriptions across every fake client. */
    stateListenerCount(): number {
      let count = 0
      for (const session of sessions) count += session.listeners.size
      return count
    },
    /** Delays one fake close until the test explicitly releases it. */
    holdClose(): void {
      if (closeGate !== null) throw new Error("a fake close is already held")
      closeGate = Promise.withResolvers<void>()
    },
    /** Releases one delayed fake close. */
    releaseClose(): void {
      if (closeGate === null) throw new Error("no fake close is held")
      closeGate.resolve()
    },
    /** Emits one secret-safe authentication terminal to every active owner. */
    emitAuthenticationFailure(): void {
      for (const session of sessions) {
        if (session.connected && !session.closed) emitState(session, "authentication-failed")
      }
    },
    /** Replays a connected state for deterministic reconciliation tests. */
    emitConnected(): void {
      for (const session of sessions) {
        if (session.connected && !session.closed) emitState(session, "connected")
      }
    },
    /** Creates one raw ephemeral record for protocol-corruption tests. */
    async putRaw(path: string, data: Uint8Array): Promise<ZookeeperClient> {
      const client = factory({
        connectionString: "fake:2181",
        sessionTimeoutMs: 30_000,
        spinDelayMs: 1,
        retries: 0,
        auth: null,
        acl: "open"
      })
      const controller = new AbortController()
      await client.connect(controller.signal)
      await client.mkdirp(parent(path), controller.signal)
      await client.mutate([{ kind: "create-ephemeral", path, data }], controller.signal)
      return client
    }
  })
}

/** Creates one complete single-node Registry fixture. */
export function fixture(revision: "initial" | "updated", name = "目录/服务-猫"): ServiceInstance {
  return {
    id: "node-一号/东京",
    name,
    version: "v1",
    metadata: { generation: revision === "updated" ? "two" : "one" },
    endpoints: [revision === "updated" ? "http://127.0.0.1:8081/" : "http://127.0.0.1:8080/"]
  }
}
