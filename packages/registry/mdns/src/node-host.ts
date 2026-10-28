/// <reference lib="es2024.promise" />

import { createSocket, type Socket, type SocketOptions } from "node:dgram"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"

import { canceled, cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"

import type {
  MDNSAddress,
  MDNSBindOptions,
  MDNSDatagram,
  MDNSDatagramSocket,
  MDNSFamily,
  MDNSHost,
  MDNSMembership,
  MDNSNetworkInterface
} from "./types"

/** Creates one unbound native Node datagram socket. */
export type NodeMDNSSocketFactory = (options: SocketOptions) => Socket

/** Describes the raw Node network-interface table consumed by the host. */
export interface NodeMDNSNetworkInterfaceTable {
  readonly [name: string]: readonly NetworkInterfaceInfo[] | undefined
}

/** Reads one raw Node network-interface snapshot. */
export type NodeMDNSNetworkInterfaceProvider = () => NodeMDNSNetworkInterfaceTable

interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the controlled Promise exactly once. */
  readonly resolve: (value: T) => void
  /** Rejects the controlled Promise exactly once. */
  readonly reject: (error: Error) => void
}

interface ReceiveWaiter extends Deferred<MDNSDatagram> {
  readonly ctx: Context
}

interface MembershipState {
  readonly group: string
  readonly nativeInterface: string
  active: boolean
}

type SocketMode = "binding" | "bound" | "closing" | "terminal"

interface SocketRuntime {
  readonly native: Socket
  readonly options: MDNSBindOptions
  readonly terminal: Deferred<void>
  readonly queue: MDNSDatagram[]
  readonly waiters: ReceiveWaiter[]
  readonly memberships: Set<MembershipState>
  readonly cleanupFailures: Error[]
  mode: SocketMode
  primaryFailure: Error | null
  closeStarted: boolean
  closeObserved: boolean
  settled: boolean
}

const closedReceiveError = new Error("Node mDNS socket is closed")

/** Creates one externally controlled Promise pair. */
function deferred<T>(): Deferred<T> {
  return Object.freeze(Promise.withResolvers<T>())
}

/** Marks one intentionally public terminal rejection as observed. */
function observe(operation: Promise<unknown>): void {
  void operation.catch(
    /** Retains the original Promise identity while preventing an unhandled rejection. */
    function observed(): void {}
  )
}

/** Converts one untrusted native rejection into an Error. */
function normalizeError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Throws the exact Context failure before one boundary mutation. */
function checkContext(ctx: Context): void {
  const failure = cause(ctx)
  if (failure !== null) throw failure
}

/** Creates an immutable ordered aggregate failure. */
function aggregateFailures(failures: readonly Error[]): AggregateError {
  const retained = Object.freeze(Array.from(failures))
  const failure = new AggregateError(retained, "Node mDNS socket lifecycle failed")
  Object.defineProperty(failure, "errors", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: retained
  })
  return Object.freeze(failure)
}

/** Reports whether the exact failure identity was already retained. */
function hasFailure(runtime: SocketRuntime, failure: Error): boolean {
  return runtime.primaryFailure === failure || runtime.cleanupFailures.includes(failure)
}

/** Retains the first passive or startup failure identity. */
function admitPrimary(runtime: SocketRuntime, failure: Error): void {
  if (runtime.primaryFailure === null && !hasFailure(runtime, failure))
    runtime.primaryFailure = failure
}

/** Retains one ordered native cleanup failure. */
function admitCleanup(runtime: SocketRuntime, value: unknown, message: string): void {
  if (runtime.settled) return
  const failure = normalizeError(value, message)
  if (!hasFailure(runtime, failure)) runtime.cleanupFailures.push(failure)
}

/** Selects the exact terminal failure or one immutable aggregate. */
function terminalFailure(runtime: SocketRuntime): Error | null {
  const failures: Error[] = []
  if (runtime.primaryFailure !== null) failures.push(runtime.primaryFailure)
  for (const failure of runtime.cleanupFailures) failures.push(failure)
  const first = failures[0]
  if (first === undefined) return null
  return failures.length === 1 ? first : aggregateFailures(failures)
}

/** Settles all ownership barriers only after native close is observed. */
function finish(runtime: SocketRuntime): void {
  if (runtime.settled || !runtime.closeObserved) return
  runtime.settled = true
  runtime.mode = "terminal"
  const failure = terminalFailure(runtime)
  const receiveFailure = failure ?? closedReceiveError
  for (const waiter of runtime.waiters.splice(0)) waiter.reject(receiveFailure)
  runtime.queue.splice(0)
  for (const membership of runtime.memberships) membership.active = false
  runtime.memberships.clear()
  if (failure === null) runtime.terminal.resolve(undefined)
  else runtime.terminal.reject(failure)
}

/** Starts native socket close exactly once. */
function startClose(runtime: SocketRuntime): void {
  if (runtime.closeStarted) return
  runtime.closeStarted = true
  runtime.mode = "closing"
  try {
    runtime.native.close()
  } catch (error) {
    admitCleanup(runtime, error, "Node mDNS socket close failed")
    if (runtime.closeObserved) {
      finish(runtime)
      return
    }
    runtime.closeStarted = false
  }
}

/** Returns the native membership selector required by Node for this family. */
function nativeMembershipInterface(options: MDNSBindOptions): string {
  return options.family === "ipv4" ? options.interfaceAddress : `::%${String(options.interfaceId)}`
}

/** Returns the selected unicast address used to keep the outbound source stable. */
function nativeOutboundInterface(options: MDNSBindOptions): string {
  return options.interfaceAddress
}

/** Adds the bound scope to one link-local IPv6 multicast target. */
function scopedTarget(runtime: SocketRuntime, target: MDNSAddress): string {
  const address = target.address.toLowerCase()
  if (target.family !== "ipv6" || !address.startsWith("ff") || address.includes("%")) {
    return target.address
  }
  return `${target.address}%${String(runtime.options.interfaceId)}`
}

/** Validates one final portable bind contract before allocating a socket. */
function validateBindOptions(options: MDNSBindOptions): void {
  if (options.family !== "ipv4" && options.family !== "ipv6") {
    throw new TypeError("Node mDNS family must be ipv4 or ipv6")
  }
  const wildcard = options.family === "ipv4" ? "0.0.0.0" : "::"
  if (options.bindAddress !== wildcard) {
    throw new TypeError(`Node mDNS ${options.family} bindAddress must be ${wildcard}`)
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new RangeError("Node mDNS port must be an integer from 1 through 65535")
  }
  if (
    (typeof options.interfaceId !== "string" || options.interfaceId.length === 0) &&
    (typeof options.interfaceId !== "number" ||
      !Number.isSafeInteger(options.interfaceId) ||
      options.interfaceId < 0)
  )
    throw new TypeError(
      "Node mDNS interfaceId must be a non-empty string or non-negative safe integer"
    )
  if (typeof options.interfaceAddress !== "string" || options.interfaceAddress.length === 0) {
    throw new TypeError("Node mDNS interfaceAddress must be a non-empty string")
  }
  if (!options.reuseAddress) throw new TypeError("Node mDNS requires reuseAddress")
  if (options.multicastTTL !== 255) throw new RangeError("Node mDNS multicastTTL must be 255")
}

/** Creates the exact Node socket options without a reusePort dependency. */
function socketOptions(family: MDNSFamily): SocketOptions {
  return family === "ipv4"
    ? Object.freeze({ type: "udp4", reuseAddr: true })
    : Object.freeze({ type: "udp6", reuseAddr: true, ipv6Only: true })
}

/** Orders same-interface addresses by routability, then exact address text. */
function compareInterfaceEntries(left: NetworkInterfaceInfo, right: NetworkInterfaceInfo): number {
  const leftScoped = left.family === "IPv6" && left.scopeid !== 0
  const rightScoped = right.family === "IPv6" && right.scopeid !== 0
  if (leftScoped !== rightScoped) return leftScoped ? 1 : -1
  if (left.internal !== right.internal) return left.internal ? 1 : -1
  return left.address < right.address ? -1 : left.address > right.address ? 1 : 0
}

/** Converts one raw Node interface table into the portable immutable shape. */
function snapshotInterfaces(table: NodeMDNSNetworkInterfaceTable): readonly MDNSNetworkInterface[] {
  if (typeof table !== "object" || table === null) {
    throw new TypeError("Node mDNS interface provider must return an object")
  }
  const output: MDNSNetworkInterface[] = []
  const names = Object.keys(table).sort()
  for (const name of names) {
    if (name.length === 0) throw new TypeError("Node mDNS interface name must be non-empty")
    const entries = table[name]
    if (entries === undefined) continue
    const selected = new Map<"IPv4" | "IPv6", NetworkInterfaceInfo>()
    for (const entry of entries) {
      if (
        (entry.family !== "IPv4" && entry.family !== "IPv6") ||
        typeof entry.address !== "string" ||
        entry.address.length === 0 ||
        typeof entry.internal !== "boolean"
      )
        throw new TypeError(`Node mDNS interface ${name} is invalid`)
      const retained = selected.get(entry.family)
      if (retained === undefined || compareInterfaceEntries(entry, retained) < 0)
        selected.set(entry.family, entry)
    }
    const families: readonly ("IPv4" | "IPv6")[] = ["IPv4", "IPv6"]
    for (const family of families) {
      const entry = selected.get(family)
      if (entry === undefined) continue
      output.push(
        Object.freeze({
          id: name,
          name,
          family: entry.family === "IPv4" ? "ipv4" : "ipv6",
          address: entry.address,
          internal: entry.internal
        })
      )
    }
  }
  return Object.freeze(output)
}

/** Creates one Context-aware receive waiter. */
function receiveWaiter(ctx: Context): ReceiveWaiter {
  const controlled = deferred<MDNSDatagram>()
  return Object.freeze({
    ctx,
    promise: controlled.promise,
    resolve: controlled.resolve,
    reject: controlled.reject
  })
}

/** Delivers one datagram without consuming it for an already canceled waiter. */
function deliver(runtime: SocketRuntime, datagram: MDNSDatagram): void {
  while (runtime.waiters.length > 0) {
    for (const waiter of runtime.waiters.splice(0, 1)) {
      let failure: Error | null
      try {
        failure = cause(waiter.ctx)
      } catch (error) {
        failure = normalizeError(error, "Node mDNS receive Context inspection failed")
      }
      if (failure !== null) {
        waiter.reject(failure)
        continue
      }
      waiter.resolve(datagram)
      return
    }
  }
  runtime.queue.push(datagram)
}

/** Installs native terminal and datagram observers before bind begins. */
function observeRuntime(runtime: SocketRuntime): void {
  runtime.native.on(
    "message",
    /** Copies one native Buffer and attributes it to this per-interface socket. */
    function received(message, remote): void {
      if (runtime.mode !== "bound") return
      const datagram: MDNSDatagram = Object.freeze({
        data: new Uint8Array(message),
        remote: Object.freeze({
          family: remote.family === "IPv4" ? "ipv4" : "ipv6",
          address: remote.address,
          port: remote.port
        }),
        interfaceId: runtime.options.interfaceId
      })
      deliver(runtime, datagram)
    }
  )
  runtime.native.on(
    "error",
    /** Claims one passive error and actively converges native ownership. */
    function failed(error: Error): void {
      admitPrimary(runtime, error)
      startClose(runtime)
    }
  )
  runtime.native.once(
    "close",
    /** Records the real native terminal barrier. */
    function closed(): void {
      runtime.closeStarted = true
      runtime.closeObserved = true
      finish(runtime)
    }
  )
}

/** Creates one live structural socket around its private native runtime. */
function runtimeSocket(runtime: SocketRuntime): MDNSDatagramSocket {
  return Object.freeze({
    /** Returns the stable true native terminal Promise. */
    settled(): Promise<void> {
      return runtime.terminal.promise
    },
    /** Joins one multicast group on the explicitly selected interface. */
    async joinMulticast(
      ctx: Context,
      group: string,
      interfaceId: string | number
    ): Promise<MDNSMembership> {
      checkContext(ctx)
      if (runtime.mode !== "bound") throw terminalFailure(runtime) ?? closedReceiveError
      if (interfaceId !== runtime.options.interfaceId) {
        throw new TypeError("Node mDNS membership interface does not match the bound socket")
      }
      if (typeof group !== "string" || group.length === 0) {
        throw new TypeError("Node mDNS multicast group must be a non-empty string")
      }
      const selector = nativeMembershipInterface(runtime.options)
      runtime.native.addMembership(group, selector)
      const state: MembershipState = { group, nativeInterface: selector, active: true }
      runtime.memberships.add(state)
      return Object.freeze({
        /** Leaves this exact native membership idempotently. */
        async leave(leaveContext: Context): Promise<void> {
          checkContext(leaveContext)
          if (!state.active) return
          runtime.native.dropMembership(state.group, state.nativeInterface)
          state.active = false
          runtime.memberships.delete(state)
        }
      })
    },
    /** Configures native multicast loopback on this bound socket. */
    async setMulticastLoopback(ctx: Context, enabled: boolean): Promise<void> {
      checkContext(ctx)
      if (runtime.mode !== "bound") throw terminalFailure(runtime) ?? closedReceiveError
      if (typeof enabled !== "boolean")
        throw new TypeError("Node mDNS multicast loopback must be boolean")
      runtime.native.setMulticastLoopback(enabled)
    },
    /** Selects the outbound native interface captured by the bind contract. */
    async setMulticastInterface(ctx: Context, interfaceId: string | number): Promise<void> {
      checkContext(ctx)
      if (runtime.mode !== "bound") throw terminalFailure(runtime) ?? closedReceiveError
      if (interfaceId !== runtime.options.interfaceId) {
        throw new TypeError("Node mDNS outbound interface does not match the bound socket")
      }
      runtime.native.setMulticastInterface(nativeOutboundInterface(runtime.options))
    },
    /** Sends one copied datagram and scopes IPv6 multicast to the bound interface. */
    send(ctx: Context, data: Uint8Array, target: MDNSAddress): Promise<void> {
      try {
        checkContext(ctx)
        if (runtime.mode !== "bound") throw terminalFailure(runtime) ?? closedReceiveError
        if (!(data instanceof Uint8Array))
          throw new TypeError("Node mDNS datagram data must be Uint8Array")
        if (target.family !== runtime.options.family) {
          throw new TypeError("Node mDNS datagram target family does not match the bound socket")
        }
        if (typeof target.address !== "string" || target.address.length === 0) {
          throw new TypeError("Node mDNS datagram target address must be non-empty")
        }
        if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
          throw new RangeError(
            "Node mDNS datagram target port must be an integer from 1 through 65535"
          )
        }
        const payload = data.slice()
        const operation = new Promise<void>(
          /** Resolves from the native send completion callback. */
          function send(resolve, reject): void {
            runtime.native.send(
              payload,
              target.port,
              scopedTarget(runtime, target),
              /** Preserves the exact native send error identity. */
              function sent(error): void {
                if (error === null) resolve()
                else reject(error)
              }
            )
          }
        )
        return waitForContext(ctx, operation)
      } catch (error) {
        return Promise.reject(normalizeError(error, "Node mDNS datagram send failed"))
      }
    },
    /** Receives one queued datagram or waits under the caller Context. */
    receive(ctx: Context): Promise<MDNSDatagram> {
      try {
        checkContext(ctx)
        if (runtime.mode !== "bound")
          return Promise.reject(terminalFailure(runtime) ?? closedReceiveError)
      } catch (error) {
        return Promise.reject(normalizeError(error, "Node mDNS receive failed"))
      }
      const queued = runtime.queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      const waiter = receiveWaiter(ctx)
      runtime.waiters.push(waiter)
      return waitForContext(ctx, waiter.promise).finally(
        /** Removes one abandoned waiter without retaining a hidden consumer. */
        function removeWaiter(): void {
          const index = runtime.waiters.indexOf(waiter)
          if (index >= 0) runtime.waiters.splice(index, 1)
        }
      )
    },
    /** Starts native close once while Context bounds only this caller wait. */
    close(ctx: Context): Promise<void> {
      startClose(runtime)
      return waitForContext(ctx, runtime.terminal.promise)
    }
  })
}

/** Creates the complete per-bind runtime before any native side effect. */
function makeRuntime(native: Socket, options: MDNSBindOptions): SocketRuntime {
  const terminal = deferred<void>()
  const runtime: SocketRuntime = {
    native,
    options,
    terminal,
    queue: [],
    waiters: [],
    memberships: new Set(),
    cleanupFailures: [],
    mode: "binding",
    primaryFailure: null,
    closeStarted: false,
    closeObserved: false,
    settled: false
  }
  observe(terminal.promise)
  observeRuntime(runtime)
  return runtime
}

/** Binds one native socket and rejects startup only after cleanup converges. */
function bindRuntime(
  socketFactory: NodeMDNSSocketFactory,
  ctx: Context,
  options: MDNSBindOptions
): Promise<MDNSDatagramSocket> {
  let signal: AbortSignal | null = null
  let addAbortListener: AbortSignal["addEventListener"] | null = null
  let removeAbortListener: AbortSignal["removeEventListener"] | null = null
  try {
    checkContext(ctx)
    validateBindOptions(options)
    signal = ctx.done()
    if (signal !== null) {
      addAbortListener = signal.addEventListener
      removeAbortListener = signal.removeEventListener
      if (typeof addAbortListener !== "function" || typeof removeAbortListener !== "function") {
        throw new TypeError("Node mDNS bind Context signal must implement event listeners")
      }
    }
  } catch (error) {
    return Promise.reject(normalizeError(error, "Node mDNS bind options are invalid"))
  }

  return new Promise<MDNSDatagramSocket>(
    /** Owns Context observation, native allocation, and bind admission through one arbiter. */
    function bind(resolve, reject): void {
      let phase: "observing" | "binding" | "failing" | "admitted" | "settled" = "observing"
      let listenerRegistered = false
      let pendingCancellation: Error | null = null
      let runtime: SocketRuntime | null = null

      /** Returns a stable exact or immutable aggregate admission failure. */
      function admissionFailure(primary: Error, failures: readonly Error[]): Error {
        return failures.length === 1 ? primary : aggregateFailures(failures)
      }

      /** Inspects cancellation without allowing Context cause/err exceptions to escape. */
      function inspectCancellation(): Error | null {
        try {
          return cause(ctx)
        } catch (error) {
          return normalizeError(error, "Node mDNS bind Context inspection failed")
        }
      }

      /** Detaches the startup observer once and returns any exact boundary failure. */
      function detachContext(): Error | null {
        if (!listenerRegistered || signal === null || removeAbortListener === null) return null
        listenerRegistered = false
        try {
          removeAbortListener.call(signal, "abort", canceledBind)
          return null
        } catch (error) {
          return normalizeError(error, "Node mDNS bind Context listener cleanup failed")
        }
      }

      /** Rejects a pre-allocation failure after deterministic listener rollback. */
      function rejectBeforeAllocation(primary: Error): void {
        phase = "settled"
        const failures: Error[] = [primary]
        const cleanupFailure = detachContext()
        if (cleanupFailure !== null && !failures.includes(cleanupFailure))
          failures.push(cleanupFailure)
        reject(admissionFailure(primary, failures))
      }

      /** Converts an allocated admission failure into close-and-terminal ownership. */
      function failAllocated(
        owned: SocketRuntime,
        primary: Error,
        contextDetachAttempted = false
      ): void {
        if (phase !== "binding") return
        phase = "failing"
        admitPrimary(owned, primary)
        if (!contextDetachAttempted) {
          const cleanupFailure = detachContext()
          if (cleanupFailure !== null)
            admitCleanup(owned, cleanupFailure, "Node mDNS bind Context listener cleanup failed")
        }
        startClose(owned)
      }

      /** Converts startup cancellation or Context inspection failure into arbiter input. */
      function canceledBind(): void {
        const failure = inspectCancellation() ?? canceled
        const owned = runtime
        if (owned === null) {
          if (pendingCancellation === null) pendingCancellation = failure
          return
        }
        failAllocated(owned, failure)
      }

      if (signal !== null && addAbortListener !== null) {
        listenerRegistered = true
        try {
          addAbortListener.call(signal, "abort", canceledBind, { once: true })
        } catch (error) {
          rejectBeforeAllocation(
            normalizeError(error, "Node mDNS bind Context listener registration failed")
          )
          return
        }
      }
      const observedCancellation = pendingCancellation ?? inspectCancellation()
      if (observedCancellation !== null) {
        rejectBeforeAllocation(observedCancellation)
        return
      }

      try {
        runtime = makeRuntime(socketFactory(socketOptions(options.family)), options)
      } catch (error) {
        rejectBeforeAllocation(normalizeError(error, "Node mDNS socket construction failed"))
        return
      }
      const owned = runtime
      phase = "binding"
      owned.terminal.promise.then(
        /** Rejects a clean native terminal that won before listening admission. */
        function cleanTerminal(): void {
          if (phase !== "binding" && phase !== "failing") return
          phase = "settled"
          const cleanupFailure = detachContext()
          reject(cleanupFailure ?? new Error("Node mDNS socket closed before bind admission"))
        },
        /** Rejects only after the allocated native owner reaches its stable terminal. */
        function failedTerminal(error: Error): void {
          if (phase !== "binding" && phase !== "failing") return
          phase = "settled"
          const cleanupFailure = detachContext()
          if (cleanupFailure === null || error === cleanupFailure) reject(error)
          else reject(aggregateFailures([error, cleanupFailure]))
        }
      )
      owned.native.once(
        "listening",
        /** Applies TTL, detaches Context, and rechecks cancellation before admission. */
        function listening(): void {
          if (phase !== "binding") return
          try {
            owned.native.setMulticastTTL(options.multicastTTL)
          } catch (error) {
            failAllocated(owned, normalizeError(error, "Node mDNS multicast TTL setup failed"))
            return
          }
          const detachFailure = detachContext()
          if (detachFailure !== null) {
            failAllocated(owned, detachFailure, true)
            return
          }
          if (phase !== "binding") return
          const cancellation = inspectCancellation()
          if (cancellation !== null) {
            failAllocated(owned, cancellation, true)
            return
          }
          phase = "admitted"
          owned.mode = "bound"
          resolve(runtimeSocket(owned))
        }
      )
      try {
        owned.native.bind(
          Object.freeze({
            address: options.bindAddress,
            port: options.port,
            exclusive: false
          })
        )
      } catch (error) {
        failAllocated(owned, normalizeError(error, "Node mDNS bind failed"))
      }
      if (phase === "binding") {
        const cancellation = inspectCancellation()
        if (cancellation !== null) failAllocated(owned, cancellation)
      }
    }
  )
}

/** Creates a Node host with explicit native seams for lifecycle conformance tests. */
export function newNodeMDNSHostWithFactory(
  socketFactory: NodeMDNSSocketFactory,
  interfaceProvider: NodeMDNSNetworkInterfaceProvider
): MDNSHost {
  return Object.freeze({
    /** Returns one immutable Node network-interface snapshot. */
    networkInterfaces(ctx: Context): Promise<readonly MDNSNetworkInterface[]> {
      try {
        checkContext(ctx)
        const snapshot = snapshotInterfaces(interfaceProvider())
        checkContext(ctx)
        return Promise.resolve(snapshot)
      } catch (error) {
        return Promise.reject(normalizeError(error, "Node mDNS interface enumeration failed"))
      }
    },
    /** Binds one independently owned native datagram socket. */
    bindDatagram(ctx: Context, options: MDNSBindOptions): Promise<MDNSDatagramSocket> {
      return bindRuntime(socketFactory, ctx, options)
    }
  })
}

/** Creates one native Node datagram socket. */
function defaultSocketFactory(options: SocketOptions): Socket {
  return createSocket(options)
}

/** Creates the Node.js UDP multicast host without allocating a socket. */
export function newNodeMDNSHost(): MDNSHost {
  return newNodeMDNSHostWithFactory(defaultSocketFactory, networkInterfaces)
}
