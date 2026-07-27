/// <reference lib="es2024.promise" />

import { cause, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"

import type {
  MDNSAddress,
  MDNSBindOptions,
  MDNSDatagram,
  MDNSDatagramSocket,
  MDNSHost,
  MDNSMembership,
  MDNSNetworkInterface
} from "./types"

interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the deferred value exactly once. */
  readonly resolve: (value: T) => void
  /** Rejects the deferred value exactly once. */
  readonly reject: (reason?: unknown) => void
}

interface ReceiveWaiter extends Deferred<MDNSDatagram> {}

interface SocketState {
  readonly hostId: string
  readonly hostNumber: number
  readonly serial: number
  readonly options: MDNSBindOptions
  readonly terminal: Deferred<void>
  readonly groups: Set<string>
  readonly queue: MDNSDatagram[]
  readonly waiters: ReceiveWaiter[]
  loopback: boolean
  closed: boolean
  failure: Error | null
}

/** Creates one externally settleable Promise pair. */
function deferred<T>(): Deferred<T> {
  return Object.freeze(Promise.withResolvers<T>())
}

/** Observes one intentionally exposed terminal rejection. */
function observeTerminal(_value: unknown): void {}

/** Throws the exact caller Context failure before a fake boundary mutation. */
function checkContext(ctx: Context): void {
  const error = cause(ctx)
  if (error !== null) throw error
}

/** Returns one stable valid remote address for a fake host and family. */
function remoteAddress(hostNumber: number, family: "ipv4" | "ipv6", port: number): MDNSAddress {
  return Object.freeze({
    family,
    address: family === "ipv4" ? `192.0.2.${hostNumber}` : `2001:db8::${hostNumber}`,
    port
  })
}

/** Exposes one deterministic in-memory multicast host for provider tests. */
export interface MemoryMDNSHost extends MDNSHost {
  /** Simulates a process crash without graceful socket cleanup. */
  crash(error: Error): void
}

/** Exposes one deterministic shared multicast network. */
export interface MemoryMDNSNetwork {
  /** Creates one independently owned host attached to this network. */
  host(id: string): MemoryMDNSHost
  /** Returns the current number of live bound sockets. */
  activeSockets(): number
}

/** Creates one isolated deterministic multicast network. */
export function newMemoryMDNSNetwork(): MemoryMDNSNetwork {
  const sockets = new Set<SocketState>()
  const hostSockets = new Map<string, Set<SocketState>>()
  const hostNumbers = new Map<string, number>()
  let nextHostNumber = 1
  let nextSocketSerial = 1

  /** Removes one socket from every network owner table. */
  function detach(state: SocketState): void {
    sockets.delete(state)
    const owned = hostSockets.get(state.hostId)
    owned?.delete(state)
    if (owned?.size === 0) hostSockets.delete(state.hostId)
  }

  /** Settles one socket and all pending receives exactly once. */
  function terminate(state: SocketState, failure: Error | null): void {
    if (state.closed) return
    state.closed = true
    state.failure = failure
    detach(state)
    const terminal = failure ?? new Error("memory mDNS socket closed")
    for (const waiter of state.waiters.splice(0)) waiter.reject(terminal)
    state.queue.splice(0)
    if (failure === null) state.terminal.resolve(undefined)
    else state.terminal.reject(failure)
  }

  /** Delivers one immutable datagram to one live receiver queue or waiter. */
  function deliver(target: SocketState, datagram: MDNSDatagram): void {
    const waiter = target.waiters.shift()
    if (waiter !== undefined) waiter.resolve(datagram)
    else target.queue.push(datagram)
  }

  /** Creates one structural socket around a private fake state. */
  function socket(state: SocketState): MDNSDatagramSocket {
    return Object.freeze({
      /** Returns the stable terminal Promise for this fake socket. */
      settled(): Promise<void> {
        return state.terminal.promise
      },
      /** Joins one fake multicast group for the bound interface. */
      async joinMulticast(
        ctx: Context,
        group: string,
        interfaceId: string | number
      ): Promise<MDNSMembership> {
        checkContext(ctx)
        if (state.closed) throw state.failure ?? new Error("memory mDNS socket is closed")
        if (interfaceId !== state.options.interfaceId)
          throw new TypeError("memory membership interface mismatch")
        if (typeof group !== "string" || group.length === 0)
          throw new TypeError("memory multicast group is invalid")
        state.groups.add(group)
        let active = true
        return Object.freeze({
          /** Leaves the fake multicast group idempotently. */
          async leave(leaveContext: Context): Promise<void> {
            checkContext(leaveContext)
            if (!active) return
            active = false
            state.groups.delete(group)
          }
        })
      },
      /** Configures deterministic sender loopback behavior. */
      async setMulticastLoopback(ctx: Context, enabled: boolean): Promise<void> {
        checkContext(ctx)
        if (state.closed) throw state.failure ?? new Error("memory mDNS socket is closed")
        if (typeof enabled !== "boolean")
          throw new TypeError("memory multicast loopback must be boolean")
        state.loopback = enabled
      },
      /** Validates the selected fake outbound interface. */
      async setMulticastInterface(ctx: Context, interfaceId: string | number): Promise<void> {
        checkContext(ctx)
        if (state.closed) throw state.failure ?? new Error("memory mDNS socket is closed")
        if (interfaceId !== state.options.interfaceId)
          throw new TypeError("memory multicast interface mismatch")
      },
      /** Delivers one immutable datagram to matching fake multicast receivers. */
      async send(ctx: Context, data: Uint8Array, target: MDNSAddress): Promise<void> {
        checkContext(ctx)
        if (state.closed) throw state.failure ?? new Error("memory mDNS socket is closed")
        if (!(data instanceof Uint8Array))
          throw new TypeError("memory datagram data must be Uint8Array")
        if (target.family !== state.options.family || target.port !== state.options.port) {
          throw new TypeError("memory datagram target does not match socket family or port")
        }
        for (const receiver of sockets) {
          if (
            receiver.closed ||
            receiver.options.family !== target.family ||
            receiver.options.port !== target.port
          )
            continue
          if (!receiver.groups.has(target.address)) continue
          if (receiver === state && !state.loopback) continue
          deliver(
            receiver,
            Object.freeze({
              data: data.slice(),
              remote: remoteAddress(state.hostNumber, target.family, target.port),
              interfaceId: receiver.options.interfaceId
            })
          )
        }
      },
      /** Receives one queued datagram or waits under the caller Context. */
      receive(ctx: Context): Promise<MDNSDatagram> {
        try {
          checkContext(ctx)
          if (state.closed)
            return Promise.reject(state.failure ?? new Error("memory mDNS socket is closed"))
        } catch (error) {
          return Promise.reject(error)
        }
        const queued = state.queue.shift()
        if (queued !== undefined) return Promise.resolve(queued)
        const waiter = deferred<MDNSDatagram>()
        state.waiters.push(waiter)
        return waitForContext(ctx, waiter.promise).finally(
          /** Removes one canceled receive without retaining a hidden future consumer. */
          function removeWaiter(): void {
            const index = state.waiters.indexOf(waiter)
            if (index >= 0) state.waiters.splice(index, 1)
          }
        )
      },
      /** Closes the fake socket and waits for its stable terminal. */
      close(ctx: Context): Promise<void> {
        terminate(state, null)
        return waitForContext(ctx, state.terminal.promise)
      }
    })
  }

  /** Returns the stable numeric identity assigned to one fake host id. */
  function hostNumber(id: string): number {
    const found = hostNumbers.get(id)
    if (found !== undefined) return found
    const created = nextHostNumber
    nextHostNumber += 1
    hostNumbers.set(id, created)
    return created
  }

  const network: MemoryMDNSNetwork = Object.freeze({
    /** Creates one borrowed fake host identity on this network. */
    host(id: string): MemoryMDNSHost {
      if (typeof id !== "string" || id.length === 0)
        throw new TypeError("memory mDNS host id must be non-empty")
      hostNumber(id)
      return Object.freeze({
        /** Returns deterministic IPv4 and IPv6 fake interfaces. */
        networkInterfaces(ctx: Context): Promise<readonly MDNSNetworkInterface[]> {
          try {
            checkContext(ctx)
            return Promise.resolve(
              Object.freeze([
                Object.freeze({
                  id: `${id}-ipv4`,
                  name: `${id}-ipv4`,
                  family: "ipv4",
                  address: "127.0.0.1",
                  internal: false
                }),
                Object.freeze({
                  id: `${id}-ipv6`,
                  name: `${id}-ipv6`,
                  family: "ipv6",
                  address: "::1",
                  internal: false
                })
              ])
            )
          } catch (error) {
            return Promise.reject(error)
          }
        },
        /** Binds one independently owned fake datagram socket. */
        bindDatagram(ctx: Context, options: MDNSBindOptions): Promise<MDNSDatagramSocket> {
          try {
            checkContext(ctx)
            const terminal = deferred<void>()
            void terminal.promise.catch(observeTerminal)
            const state: SocketState = {
              hostId: id,
              hostNumber: hostNumber(id),
              serial: nextSocketSerial,
              options: Object.freeze({
                family: options.family,
                bindAddress: options.bindAddress,
                port: options.port,
                interfaceId: options.interfaceId,
                interfaceAddress: options.interfaceAddress,
                reuseAddress: options.reuseAddress,
                multicastTTL: options.multicastTTL
              }),
              terminal,
              groups: new Set(),
              queue: [],
              waiters: [],
              loopback: false,
              closed: false,
              failure: null
            }
            nextSocketSerial += 1
            sockets.add(state)
            const owned = hostSockets.get(id) ?? new Set<SocketState>()
            owned.add(state)
            hostSockets.set(id, owned)
            return Promise.resolve(socket(state))
          } catch (error) {
            return Promise.reject(error)
          }
        },
        /** Terminates every socket owned by this fake host with one passive failure. */
        crash(error: Error): void {
          if (!(error instanceof Error))
            throw new TypeError("memory mDNS crash reason must be an Error")
          const owned = hostSockets.get(id)
          if (owned === undefined) return
          for (const state of Array.from(owned)) terminate(state, error)
        }
      })
    },
    /** Returns the exact count of currently live fake sockets. */
    activeSockets(): number {
      return sockets.size
    }
  })
  return network
}
