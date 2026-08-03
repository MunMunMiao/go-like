import { createSocket, type Socket, type SocketOptions } from "node:dgram"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"

import { describe, expect, test } from "bun:test"

import {
  background,
  deadlineExceeded,
  withCancelCause,
  withTimeout,
  type Context
} from "@likego/context"

import { newNodeMDNSHostWithFactory, type NodeMDNSNetworkInterfaceTable } from "../src/node-host"
import { newNodeMDNSHost } from "../src/node"
import type {
  MDNSAddress,
  MDNSBindOptions,
  MDNSDatagramSocket,
  MDNSHost,
  MDNSNetworkInterface
} from "../src/types"

interface NativeCapture {
  options: SocketOptions | null
  socket: Socket | null
  multicastTTL: number | null
}

interface InterfaceSelectors {
  outbound: string | null
  joined: string | null
  left: string | null
  target: string | null
}

/** Returns one deterministic raw Node interface fixture. */
function fixtureInterfaces(): NodeMDNSNetworkInterfaceTable {
  const ipv4: NetworkInterfaceInfo = Object.freeze({
    address: "192.0.2.10",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:01",
    internal: false,
    cidr: "192.0.2.10/24"
  })
  const loopback: NetworkInterfaceInfo = Object.freeze({
    address: "::1",
    netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: true,
    cidr: "::1/128",
    scopeid: 0
  })
  const ipv6: NetworkInterfaceInfo = Object.freeze({
    address: "2001:db8::2",
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:02",
    internal: false,
    cidr: "2001:db8::2/64",
    scopeid: 0
  })
  const linkLocal: NetworkInterfaceInfo = Object.freeze({
    address: "fe80::2",
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:02",
    internal: false,
    cidr: "fe80::2/64",
    scopeid: 2
  })
  return Object.freeze({
    zed: Object.freeze([ipv6, linkLocal]),
    alpha: Object.freeze([ipv4, loopback])
  })
}

/** Creates one final Node bind contract for a selected interface. */
function bindOptions(networkInterface: MDNSNetworkInterface, port: number): MDNSBindOptions {
  return Object.freeze({
    family: networkInterface.family,
    bindAddress: networkInterface.family === "ipv4" ? "0.0.0.0" : "::",
    port,
    interfaceId: networkInterface.id,
    interfaceAddress: networkInterface.address,
    reuseAddress: true,
    multicastTTL: 255
  })
}

/** Creates one raw IPv4 interface entry for ordering and validation boundaries. */
function rawIPv4(address: string, internal: boolean): NetworkInterfaceInfo {
  return Object.freeze({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:03",
    internal,
    cidr: `${address}/24`
  })
}

/** Creates one raw IPv6 interface entry for scoped-address ordering boundaries. */
function rawIPv6(address: string, scopeid: number): NetworkInterfaceInfo {
  return Object.freeze({
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:04",
    internal: false,
    cidr: `${address}/64`,
    scopeid
  })
}

/** Replaces one bind option without relying on object spread or type assertions. */
function invalidBindOption(
  options: MDNSBindOptions,
  name: string,
  value: unknown
): Readonly<Record<string, unknown>> {
  const invalid: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(options)) invalid[key] = item
  invalid[name] = value
  return Object.freeze(invalid)
}

/** Invokes the structural host boundary with deliberately untyped invalid input. */
function bindUnknown(host: MDNSHost, options: unknown): Promise<unknown> {
  const operation: unknown = Reflect.apply(host.bindDatagram, host, [background(), options])
  if (!(operation instanceof Promise))
    throw new Error("Node mDNS bind boundary did not return a Promise")
  return operation
}

/** Creates a Context whose third error inspection throws for receive-delivery coverage. */
function throwingReceiveContext(failure: Error): Context {
  let inspections = 0
  return Object.freeze({
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    done(): AbortSignal | null {
      return null
    },
    err(): Error | null {
      inspections += 1
      if (inspections < 3) return null
      throw failure
    },
    value(_key: unknown): unknown {
      return null
    }
  })
}

/** Creates a Context that becomes canceled during receive delivery instead of throwing. */
function cancelingReceiveContext(failure: Error): Context {
  let inspections = 0
  return Object.freeze({
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    done(): AbortSignal | null {
      return null
    },
    err(): Error | null {
      inspections += 1
      return inspections < 3 ? null : failure
    },
    value(_key: unknown): unknown {
      return null
    }
  })
}

/** Creates a Context whose done inspection fails before native allocation. */
function throwingDoneContext(failure: Error): Context {
  return Object.freeze({
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    done(): AbortSignal | null {
      throw failure
    },
    err(): Error | null {
      return null
    },
    value(_key: unknown): unknown {
      return null
    }
  })
}

/** Creates a Context whose post-bind error recheck fails. */
function throwingLateBindContext(failure: Error): Context {
  let inspections = 0
  return Object.freeze({
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    done(): AbortSignal | null {
      return null
    },
    err(): Error | null {
      inspections += 1
      if (inspections > 2) throw failure
      return null
    },
    value(_key: unknown): unknown {
      return null
    }
  })
}

/** Finds one actual non-internal IPv4 interface for multicast conformance. */
async function actualIPv4(host: MDNSHost): Promise<MDNSNetworkInterface> {
  const interfaces = await host.networkInterfaces(background())
  const selected = interfaces.find(function usable(value): boolean {
    return value.family === "ipv4" && !value.internal
  })
  if (selected === undefined)
    throw new Error("Node mDNS test requires one non-internal IPv4 interface")
  return selected
}

/** Reserves and releases one kernel-assigned IPv4 UDP port. */
async function unusedIPv4Port(): Promise<number> {
  const socket = createSocket("udp4")
  await new Promise<void>(function bind(resolve, reject): void {
    socket.once("error", reject)
    socket.bind(Object.freeze({ address: "127.0.0.1", port: 0 }), resolve)
  })
  const port = socket.address().port
  await new Promise<void>(function close(resolve): void {
    socket.close(resolve)
  })
  return port
}

/** Reserves and releases one kernel-assigned IPv6 UDP port. */
async function unusedIPv6Port(): Promise<number> {
  const socket = createSocket("udp6")
  await new Promise<void>(function bind(resolve, reject): void {
    socket.once("error", reject)
    socket.bind(Object.freeze({ address: "::1", port: 0, ipv6Only: true }), resolve)
  })
  const port = socket.address().port
  await new Promise<void>(function close(resolve): void {
    socket.close(resolve)
  })
  return port
}

/** Closes one partially exercised socket without masking the original test failure. */
async function cleanup(socket: MDNSDatagramSocket | null): Promise<void> {
  if (socket === null) return
  try {
    await socket.close(background())
  } catch {}
  try {
    await socket.settled()
  } catch {}
}

describe("Node mDNS host", () => {
  test("enumerates a frozen deterministic interface snapshot and preserves caller cancellation", async () => {
    const host = newNodeMDNSHostWithFactory(createSocket, fixtureInterfaces)
    const values = await host.networkInterfaces(background())

    expect(values).toEqual([
      { id: "alpha", name: "alpha", family: "ipv4", address: "192.0.2.10", internal: false },
      { id: "alpha", name: "alpha", family: "ipv6", address: "::1", internal: true },
      { id: "zed", name: "zed", family: "ipv6", address: "2001:db8::2", internal: false }
    ])
    expect(Object.isFrozen(values)).toBeTrue()
    expect(values.every(Object.isFrozen)).toBeTrue()

    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("interface caller canceled")
    cancel(failure)
    await expect(host.networkInterfaces(ctx)).rejects.toBe(failure)
  })

  test("creates reuseAddr-only wildcard sockets and applies the mandated IP TTL", async () => {
    const captured: NativeCapture = { options: null, socket: null, multicastTTL: null }
    const host = newNodeMDNSHostWithFactory(function capture(options): Socket {
      captured.options = options
      const created = createSocket(options)
      captured.socket = created
      const setTTL = created.setMulticastTTL.bind(created)
      created.setMulticastTTL = function captureTTL(value: number): number {
        captured.multicastTTL = value
        return setTTL(value)
      }
      return created
    }, networkInterfaces)
    let socket: MDNSDatagramSocket | null = null
    try {
      const networkInterface = await actualIPv4(host)
      socket = await host.bindDatagram(
        background(),
        bindOptions(networkInterface, await unusedIPv4Port())
      )
      expect(captured.options).toEqual({ type: "udp4", reuseAddr: true })
      expect(captured.multicastTTL).toBe(255)
      const active = captured.socket
      if (active === null) throw new Error("Node mDNS native socket was not captured")
      expect(active.address().address).toBe("0.0.0.0")
      expect(socket.settled()).toBe(socket.settled())
    } finally {
      await cleanup(socket)
    }
  })

  test("uses the IPv6 address for stable outbound source selection and the interface id for membership", async () => {
    const selectors: InterfaceSelectors = { outbound: null, joined: null, left: null, target: null }
    const host = newNodeMDNSHostWithFactory(function capture(options): Socket {
      const created = createSocket(options)
      created.setMulticastInterface = function captureOutbound(value: string): void {
        selectors.outbound = value
      }
      created.addMembership = function captureJoin(_group: string, value?: string): void {
        selectors.joined = value ?? null
      }
      created.dropMembership = function captureLeave(_group: string, value?: string): void {
        selectors.left = value ?? null
      }
      Reflect.set(
        created,
        "send",
        function captureSend(
          _data: Uint8Array,
          _port: number,
          address: string,
          callback: (error: Error | null) => void
        ): void {
          selectors.target = address
          callback(null)
        }
      )
      return created
    }, fixtureInterfaces)
    const networkInterface = (await host.networkInterfaces(background())).find(
      function ipv6(value): boolean {
        return value.name === "zed" && value.family === "ipv6"
      }
    )
    if (networkInterface === undefined) throw new Error("IPv6 fixture interface is missing")
    let socket: MDNSDatagramSocket | null = null
    try {
      socket = await host.bindDatagram(
        background(),
        bindOptions(networkInterface, await unusedIPv6Port())
      )
      await socket.setMulticastInterface(background(), networkInterface.id)
      const membership = await socket.joinMulticast(background(), "ff02::fb", networkInterface.id)
      expect(selectors.outbound).toBe("2001:db8::2")
      expect(selectors.joined).toBe("::%zed")
      await socket.send(background(), new Uint8Array([1]), {
        family: "ipv6",
        address: "ff02::fb",
        port: 5_353
      })
      expect(selectors.target).toBe("ff02::fb%zed")
      await membership.leave(background())
      expect(selectors.left).toBe("::%zed")
    } finally {
      await cleanup(socket)
    }
  })

  test("exchanges a real IPv4 multicast datagram and owns membership cleanup", async () => {
    const host = newNodeMDNSHost()
    const networkInterface = await actualIPv4(host)
    const port = await unusedIPv4Port()
    let receiver: MDNSDatagramSocket | null = null
    let sender: MDNSDatagramSocket | null = null
    try {
      receiver = await host.bindDatagram(background(), bindOptions(networkInterface, port))
      sender = await host.bindDatagram(background(), bindOptions(networkInterface, port))
      await receiver.setMulticastLoopback(background(), true)
      await sender.setMulticastLoopback(background(), true)
      await sender.setMulticastInterface(background(), networkInterface.id)
      const membership = await receiver.joinMulticast(
        background(),
        "224.0.0.251",
        networkInterface.id
      )
      const [ctx, cancel] = withTimeout(background(), 2_000)
      try {
        const pending = receiver.receive(ctx)
        await sender.send(background(), new Uint8Array([76, 105, 107, 101, 103, 111]), {
          family: "ipv4",
          address: "224.0.0.251",
          port
        })
        const datagram = await pending
        expect(Array.from(datagram.data)).toEqual([76, 105, 107, 101, 103, 111])
        expect(datagram.remote.family).toBe("ipv4")
        expect(datagram.interfaceId).toBe(networkInterface.id)
      } finally {
        cancel()
      }
      await membership.leave(background())
      await membership.leave(background())
    } finally {
      await cleanup(sender)
      await cleanup(receiver)
    }
  })

  test("actively cleans a synchronously canceled bind and releases the UDP port", async () => {
    const host = newNodeMDNSHost()
    const networkInterface = await actualIPv4(host)
    const port = await unusedIPv4Port()
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("bind caller canceled")
    const binding = host.bindDatagram(ctx, bindOptions(networkInterface, port))
    cancel(failure)
    await expect(binding).rejects.toBe(failure)

    let rebound: MDNSDatagramSocket | null = null
    try {
      rebound = await host.bindDatagram(background(), bindOptions(networkInterface, port))
    } finally {
      await cleanup(rebound)
    }
  })

  test("Context inspection failures never allocate or leak a native bind", async () => {
    const networkInterface = await actualIPv4(newNodeMDNSHost())
    const options = bindOptions(networkInterface, await unusedIPv4Port())
    let allocations = 0
    const earlyFailure = new Error("bind done inspection failed")
    const earlyHost = newNodeMDNSHostWithFactory(function countAllocation(socketOptions): Socket {
      allocations += 1
      return createSocket(socketOptions)
    }, networkInterfaces)
    await expect(earlyHost.bindDatagram(throwingDoneContext(earlyFailure), options)).rejects.toBe(
      earlyFailure
    )
    expect(allocations).toBe(0)

    let active: Socket | null = null
    let closed = false
    const lateFailure = new Error("bind error recheck failed")
    const lateHost = newNodeMDNSHostWithFactory(function capture(socketOptions): Socket {
      const created = createSocket(socketOptions)
      active = created
      created.once("close", function observedClose(): void {
        closed = true
      })
      return created
    }, networkInterfaces)
    try {
      await expect(
        lateHost.bindDatagram(throwingLateBindContext(lateFailure), options)
      ).rejects.toBe(lateFailure)
      await new Promise<void>(function settle(resolve): void {
        setTimeout(resolve, 10)
      })
      expect(closed).toBeTrue()
      let rebound: MDNSDatagramSocket | null = null
      try {
        rebound = await newNodeMDNSHost().bindDatagram(background(), options)
      } finally {
        await cleanup(rebound)
      }
    } finally {
      if (!closed && active !== null) {
        await new Promise<void>(function close(resolve): void {
          active?.close(resolve)
        })
      }
    }
  })

  test("rejects a signal-listener registration failure before native socket allocation", async () => {
    const failure = new Error("bind signal registration failed")
    const controller = new AbortController()
    Reflect.set(controller.signal, "addEventListener", function rejectRegistration(): void {
      throw failure
    })
    const ctx: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return controller.signal
      },
      err(): Error | null {
        return null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    let allocations = 0
    const host = newNodeMDNSHostWithFactory(function count(socketOptions): Socket {
      allocations += 1
      return createSocket(socketOptions)
    }, networkInterfaces)
    const networkInterface = await actualIPv4(newNodeMDNSHost())
    const options = bindOptions(networkInterface, await unusedIPv4Port())

    await expect(host.bindDatagram(ctx, options)).rejects.toBe(failure)
    expect(allocations).toBe(0)

    const invalidSignal = new AbortController().signal
    Reflect.set(invalidSignal, "addEventListener", null)
    const invalidContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return invalidSignal
      },
      err(): Error | null {
        return null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    await expect(host.bindDatagram(invalidContext, options)).rejects.toBeInstanceOf(TypeError)
    expect(allocations).toBe(0)
  })

  test("closes and releases a bound socket when signal-listener removal fails", async () => {
    const failure = new Error("bind signal removal failed")
    const controller = new AbortController()
    Reflect.set(controller.signal, "removeEventListener", function rejectRemoval(): void {
      throw failure
    })
    const ctx: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return controller.signal
      },
      err(): Error | null {
        return null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    let nativeClosed = false
    const host = newNodeMDNSHostWithFactory(function observeClose(socketOptions): Socket {
      const socket = createSocket(socketOptions)
      socket.once("close", function closed(): void {
        nativeClosed = true
      })
      return socket
    }, networkInterfaces)
    const networkInterface = await actualIPv4(newNodeMDNSHost())
    const options = bindOptions(networkInterface, await unusedIPv4Port())

    await expect(host.bindDatagram(ctx, options)).rejects.toBe(failure)
    expect(nativeClosed).toBe(true)
    let rebound: MDNSDatagramSocket | null = null
    try {
      rebound = await newNodeMDNSHost().bindDatagram(background(), options)
    } finally {
      await cleanup(rebound)
    }
  })

  test("settles synchronous signal reentry and Context err or cause exceptions before allocation", async () => {
    const networkInterface = await actualIPv4(newNodeMDNSHost())
    const options = bindOptions(networkInterface, await unusedIPv4Port())
    let allocations = 0
    const host = newNodeMDNSHostWithFactory(function count(socketOptions): Socket {
      allocations += 1
      return createSocket(socketOptions)
    }, networkInterfaces)

    /** Creates a real signal whose listener registration synchronously reenters bind admission. */
    function synchronousSignal(): AbortSignal {
      const signal = new AbortController().signal
      Reflect.set(
        signal,
        "addEventListener",
        function reenter(_type: string, listener: EventListenerOrEventListenerObject): void {
          if (typeof listener === "function") listener(new Event("abort"))
          else listener.handleEvent(new Event("abort"))
        }
      )
      return signal
    }

    const cancellation = new Error("synchronous bind cancellation")
    let cancellationInspections = 0
    const canceledContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return synchronousSignal()
      },
      err(): Error | null {
        cancellationInspections += 1
        return cancellationInspections === 1 ? null : cancellation
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    await expect(host.bindDatagram(canceledContext, options)).rejects.toBe(cancellation)

    const errFailure = new Error("bind Context err failed")
    let errInspections = 0
    const errContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return synchronousSignal()
      },
      err(): Error | null {
        errInspections += 1
        if (errInspections > 1) throw errFailure
        return null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    await expect(host.bindDatagram(errContext, options)).rejects.toBe(errFailure)

    const causeFailure = new Error("bind Context cause failed")
    const canceledError = new Error("bind Context canceled")
    let causeInspections = 0
    const causeContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return synchronousSignal()
      },
      err(): Error | null {
        causeInspections += 1
        return causeInspections === 1 ? null : canceledError
      },
      value(_key: unknown): unknown {
        throw causeFailure
      }
    })
    await expect(host.bindDatagram(causeContext, options)).rejects.toBe(causeFailure)
    expect(allocations).toBe(0)
  })

  test("normalizes non-Error interface-provider failures", async () => {
    const host = newNodeMDNSHostWithFactory(
      createSocket,
      function rejectInterfaces(): NodeMDNSNetworkInterfaceTable {
        throw "invalid interface provider failure"
      }
    )

    await expect(host.networkInterfaces(background())).rejects.toThrow(
      "Node mDNS interface enumeration failed"
    )
  })

  test("aggregates distinct pre-allocation listener failures and deduplicates one identity", async () => {
    const networkInterface = await actualIPv4(newNodeMDNSHost())
    const options = bindOptions(networkInterface, await unusedIPv4Port())
    let allocations = 0
    const host = newNodeMDNSHostWithFactory(function count(socketOptions): Socket {
      allocations += 1
      return createSocket(socketOptions)
    }, networkInterfaces)

    /** Creates one signal whose registration and rollback fail with selected identities. */
    function failingSignal(registrationFailure: Error, removalFailure: Error): AbortSignal {
      const signal = new AbortController().signal
      Reflect.set(signal, "addEventListener", function rejectRegistration(): void {
        throw registrationFailure
      })
      Reflect.set(signal, "removeEventListener", function rejectRemoval(): void {
        throw removalFailure
      })
      return signal
    }

    /** Creates one active Context around the selected failing signal. */
    function signalContext(signal: AbortSignal): Context {
      return Object.freeze({
        deadline(): readonly [Date, boolean] {
          return [new Date(0), false]
        },
        done(): AbortSignal {
          return signal
        },
        err(): Error | null {
          return null
        },
        value(_key: unknown): unknown {
          return null
        }
      })
    }

    const registrationFailure = new Error("bind listener registration failed")
    const removalFailure = new Error("bind listener rollback failed")
    await expect(
      host.bindDatagram(signalContext(failingSignal(registrationFailure, removalFailure)), options)
    ).rejects.toMatchObject({ errors: [registrationFailure, removalFailure] })

    const sharedFailure = new Error("shared bind listener failure")
    await expect(
      host.bindDatagram(signalContext(failingSignal(sharedFailure, sharedFailure)), options)
    ).rejects.toBe(sharedFailure)
    expect(allocations).toBe(0)
  })

  test("keeps the first allocated failure when bind synchronously reenters failure arbitration", async () => {
    const controller = new AbortController()
    const cancellation = new Error("allocated bind cancellation")
    const secondary = new Error("secondary native bind failure")
    const ctx: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return controller.signal
      },
      err(): Error | null {
        return controller.signal.aborted ? cancellation : null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    const host = newNodeMDNSHostWithFactory(function reentrantBind(options): Socket {
      const socket = createSocket(options)
      Reflect.set(socket, "close", function closeSynchronously(): void {
        socket.emit("close")
      })
      Reflect.set(socket, "bind", function cancelThenThrow(): void {
        controller.abort()
        throw secondary
      })
      return socket
    }, fixtureInterfaces)
    const networkInterface = (await host.networkInterfaces(background()))[0]
    if (networkInterface === undefined)
      throw new Error("reentrant bind fixture interface is missing")

    await expect(host.bindDatagram(ctx, bindOptions(networkInterface, 5_353))).rejects.toBe(
      cancellation
    )
  })

  test("uses canceled for synchronous abort reentry without a visible Context error", async () => {
    const signal = new AbortController().signal
    Reflect.set(
      signal,
      "addEventListener",
      function reenter(_type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") listener(new Event("abort"))
        else listener.handleEvent(new Event("abort"))
      }
    )
    const ctx: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return signal
      },
      err(): Error | null {
        return null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    const [expectedContext, cancelExpected] = withCancelCause(background())
    cancelExpected(null)
    const expected = expectedContext.err()
    if (expected === null) throw new Error("canceled Context fixture did not settle")
    let allocations = 0
    const host = newNodeMDNSHostWithFactory(function count(options): Socket {
      allocations += 1
      return createSocket(options)
    }, fixtureInterfaces)
    const networkInterface = (await host.networkInterfaces(background()))[0]
    if (networkInterface === undefined)
      throw new Error("synchronous abort fixture interface is missing")

    await expect(host.bindDatagram(ctx, bindOptions(networkInterface, 5_353))).rejects.toBe(
      expected
    )
    expect(allocations).toBe(0)
  })

  test("aggregates a native pre-admission failure with listener cleanup and ignores late listening", async () => {
    const nativeFailure = new Error("native socket failed before admission")
    const removalFailure = new Error("pre-admission listener cleanup failed")
    const controller = new AbortController()
    Reflect.set(controller.signal, "removeEventListener", function rejectRemoval(): void {
      throw removalFailure
    })
    const ctx: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return controller.signal
      },
      err(): Error | null {
        return null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    const captured: NativeCapture = { options: null, socket: null, multicastTTL: null }
    const host = newNodeMDNSHostWithFactory(function failBeforeAdmission(options): Socket {
      const socket = createSocket(options)
      captured.socket = socket
      Reflect.set(socket, "close", function closeSynchronously(): void {
        socket.emit("close")
      })
      Reflect.set(socket, "bind", function emitFailure(): void {
        socket.emit("error", nativeFailure)
      })
      return socket
    }, fixtureInterfaces)
    const networkInterface = (await host.networkInterfaces(background()))[0]
    if (networkInterface === undefined)
      throw new Error("pre-admission failure fixture interface is missing")

    await expect(
      host.bindDatagram(ctx, bindOptions(networkInterface, 5_353))
    ).rejects.toMatchObject({
      errors: [nativeFailure, removalFailure]
    })
    const active = captured.socket
    if (active === null) throw new Error("pre-admission native socket was not captured")
    active.emit("listening")
  })

  test("honors cancellation that reenters while the listening observer detaches", async () => {
    let listener: EventListenerOrEventListenerObject | null = null
    const signal = new AbortController().signal
    Reflect.set(
      signal,
      "addEventListener",
      function capture(_type: string, value: EventListenerOrEventListenerObject): void {
        listener = value
      }
    )
    Reflect.set(signal, "removeEventListener", function reenter(): void {
      const retained = listener
      if (typeof retained === "function") retained(new Event("abort"))
      else retained?.handleEvent(new Event("abort"))
    })
    const ctx: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return signal
      },
      err(): Error | null {
        return null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    const [expectedContext, cancelExpected] = withCancelCause(background())
    cancelExpected(null)
    const expected = expectedContext.err()
    if (expected === null) throw new Error("canceled Context fixture did not settle")
    const host = newNodeMDNSHostWithFactory(createSocket, fixtureInterfaces)
    const networkInterface = (await host.networkInterfaces(background()))[0]
    if (networkInterface === undefined)
      throw new Error("listening reentry fixture interface is missing")

    await expect(
      host.bindDatagram(ctx, bindOptions(networkInterface, await unusedIPv4Port()))
    ).rejects.toBe(expected)
  })

  test("aggregates cancellation with listener cleanup and rechecks Context after listening", async () => {
    const networkInterface = await actualIPv4(newNodeMDNSHost())
    const cancellation = new Error("bind canceled during native admission")
    const removeFailure = new Error("bind cancellation listener removal failed")
    const controller = new AbortController()
    Reflect.set(controller.signal, "removeEventListener", function rejectRemoval(): void {
      throw removeFailure
    })
    const canceledContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal {
        return controller.signal
      },
      err(): Error | null {
        return controller.signal.aborted ? cancellation : null
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    const canceledOptions = bindOptions(networkInterface, await unusedIPv4Port())
    const pending = newNodeMDNSHost().bindDatagram(canceledContext, canceledOptions)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ errors: [cancellation, removeFailure] })

    const finalCancellation = new Error("bind canceled after listening")
    let inspections = 0
    const lateContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal | null {
        return null
      },
      err(): Error | null {
        inspections += 1
        return inspections < 4 ? null : finalCancellation
      },
      value(_key: unknown): unknown {
        return null
      }
    })
    const lateOptions = bindOptions(networkInterface, await unusedIPv4Port())
    await expect(newNodeMDNSHost().bindDatagram(lateContext, lateOptions)).rejects.toBe(
      finalCancellation
    )
    let rebound: MDNSDatagramSocket | null = null
    try {
      rebound = await newNodeMDNSHost().bindDatagram(background(), lateOptions)
    } finally {
      await cleanup(rebound)
    }
  })

  test("close is idempotent, starts despite caller cancellation, and keeps a stable true terminal", async () => {
    const host = newNodeMDNSHost()
    const networkInterface = await actualIPv4(host)
    const socket = await host.bindDatagram(
      background(),
      bindOptions(networkInterface, await unusedIPv4Port())
    )
    const terminal = socket.settled()
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("close caller stopped waiting")
    cancel(failure)

    await expect(socket.close(ctx)).rejects.toBe(failure)
    await terminal
    await socket.close(background())
    expect(socket.settled()).toBe(terminal)
  })

  test("a passive native error rejects pending receive and settled with the exact failure", async () => {
    const captured: NativeCapture = { options: null, socket: null, multicastTTL: null }
    const host = newNodeMDNSHostWithFactory(function capture(options): Socket {
      const created = createSocket(options)
      captured.socket = created
      return created
    }, networkInterfaces)
    const networkInterface = await actualIPv4(host)
    let socket: MDNSDatagramSocket | null = null
    try {
      socket = await host.bindDatagram(
        background(),
        bindOptions(networkInterface, await unusedIPv4Port())
      )
      const pending = socket.receive(background())
      const failure = new Error("native datagram failed")
      const active = captured.socket
      if (active === null) throw new Error("Node mDNS native socket was not captured")
      active.emit("error", failure)

      await expect(pending).rejects.toBe(failure)
      await expect(socket.settled()).rejects.toBe(failure)
      socket = null
    } finally {
      await cleanup(socket)
    }
  })

  test("a synchronous native close failure remains nonterminal until a later close is observed", async () => {
    const captured: NativeCapture = { options: null, socket: null, multicastTTL: null }
    let nativeClose: (() => void) | null = null
    const host = newNodeMDNSHostWithFactory(function capture(options): Socket {
      const created = createSocket(options)
      captured.socket = created
      nativeClose = created.close.bind(created)
      return created
    }, networkInterfaces)
    const networkInterface = await actualIPv4(host)
    let socket: MDNSDatagramSocket | null = null
    try {
      socket = await host.bindDatagram(
        background(),
        bindOptions(networkInterface, await unusedIPv4Port())
      )
      const active = captured.socket
      if (active === null || nativeClose === null)
        throw new Error("Node mDNS native close seam was not captured")
      const closeFailure = new Error("native close rejected before terminal")
      Reflect.set(active, "close", function rejectClose(): void {
        throw closeFailure
      })
      const [ctx, cancel] = withTimeout(background(), 10)
      try {
        await expect(socket.close(ctx)).rejects.toBe(deadlineExceeded)
      } finally {
        cancel()
      }
      const postCloseOperation = await socket.setMulticastLoopback(background(), true).then(
        function resolved(): unknown {
          return "resolved"
        },
        function rejected(error: unknown): unknown {
          return error
        }
      )
      Reflect.set(active, "close", nativeClose)
      expect(postCloseOperation).toBe(closeFailure)
      const passiveFailure = new Error("passive failure after close retry")
      active.emit("error", passiveFailure)
      const terminal = socket.settled()
      await expect(terminal).rejects.toBeInstanceOf(AggregateError)
      await expect(terminal).rejects.toMatchObject({ errors: [passiveFailure, closeFailure] })
      socket = null
    } finally {
      await cleanup(socket)
    }
  })

  test("rejects malformed host, interface, bind, construction, and native admission boundaries", async () => {
    const nullTable = newNodeMDNSHostWithFactory(
      createSocket,
      function invalidTable(): NodeMDNSNetworkInterfaceTable {
        return JSON.parse("null")
      }
    )
    await expect(nullTable.networkInterfaces(background())).rejects.toThrow("must return an object")

    const emptyName = newNodeMDNSHostWithFactory(createSocket, function emptyNameTable() {
      return Object.freeze({ "": Object.freeze([rawIPv4("192.0.2.1", false)]) })
    })
    await expect(emptyName.networkInterfaces(background())).rejects.toThrow(
      "name must be non-empty"
    )

    const invalidEntry = newNodeMDNSHostWithFactory(createSocket, function invalidEntryTable() {
      return JSON.parse('{"eth0":[{"family":"IPX","address":"x","internal":false}]}')
    })
    await expect(invalidEntry.networkInterfaces(background())).rejects.toThrow(
      "interface eth0 is invalid"
    )

    const ordered = newNodeMDNSHostWithFactory(createSocket, function orderedTable() {
      return Object.freeze({
        skipped: undefined,
        eth0: Object.freeze([
          rawIPv4("192.0.2.5", true),
          rawIPv4("192.0.2.20", false),
          rawIPv4("192.0.2.10", false)
        ])
      })
    })
    expect(await ordered.networkInterfaces(background())).toEqual([
      {
        id: "eth0",
        name: "eth0",
        family: "ipv4",
        address: "192.0.2.10",
        internal: false
      }
    ])

    const orderingEdges = newNodeMDNSHostWithFactory(createSocket, function orderingEdgeTable() {
      return Object.freeze({
        eth0: Object.freeze([
          rawIPv4("192.0.2.10", false),
          rawIPv4("192.0.2.5", true),
          rawIPv4("192.0.2.10", false),
          rawIPv4("192.0.2.20", false)
        ])
      })
    })
    expect(await orderingEdges.networkInterfaces(background())).toEqual([
      {
        id: "eth0",
        name: "eth0",
        family: "ipv4",
        address: "192.0.2.10",
        internal: false
      }
    ])

    const scopedOrdering = newNodeMDNSHostWithFactory(createSocket, function scopedOrderingTable() {
      return Object.freeze({
        forward: Object.freeze([rawIPv6("2001:db8::10", 0), rawIPv6("fe80::10", 2)]),
        reverse: Object.freeze([rawIPv6("fe80::20", 2), rawIPv6("2001:db8::20", 0)])
      })
    })
    expect(await scopedOrdering.networkInterfaces(background())).toEqual([
      {
        id: "forward",
        name: "forward",
        family: "ipv6",
        address: "2001:db8::10",
        internal: false
      },
      {
        id: "reverse",
        name: "reverse",
        family: "ipv6",
        address: "2001:db8::20",
        internal: false
      }
    ])

    const networkInterface = (await ordered.networkInterfaces(background()))[0]
    if (networkInterface === undefined) throw new Error("ordered interface fixture is missing")
    const valid = bindOptions(networkInterface, 5_353)
    const invalidOptions: readonly (readonly [string, unknown])[] = [
      ["family", "ipx"],
      ["bindAddress", "127.0.0.1"],
      ["port", 0],
      ["interfaceId", ""],
      ["interfaceId", 1.5],
      ["interfaceId", -1],
      ["interfaceAddress", ""],
      ["reuseAddress", false],
      ["multicastTTL", 1]
    ]
    for (const [name, value] of invalidOptions) {
      await expect(
        bindUnknown(ordered, invalidBindOption(valid, name, value))
      ).rejects.toBeInstanceOf(Error)
    }

    const constructionFailure = new Error("socket construction failed")
    const constructionHost = newNodeMDNSHostWithFactory(function rejectConstruction(): Socket {
      throw constructionFailure
    }, fixtureInterfaces)
    await expect(constructionHost.bindDatagram(background(), valid)).rejects.toBe(
      constructionFailure
    )

    const bindFailure = new Error("native bind failed")
    const bindHost = newNodeMDNSHostWithFactory(function rejectBind(options): Socket {
      const created = createSocket(options)
      Reflect.set(created, "bind", function throwBind(): void {
        throw bindFailure
      })
      return created
    }, fixtureInterfaces)
    const bindResult = await Promise.race([
      bindHost.bindDatagram(background(), valid).then(
        function unexpected(): unknown {
          return new Error("native bind unexpectedly succeeded")
        },
        function rejected(error: unknown): unknown {
          return error
        }
      ),
      new Promise<unknown>(function timeout(resolve): void {
        setTimeout(function expired(): void {
          resolve("timeout")
        }, 50)
      })
    ])
    expect(bindResult).toBe(bindFailure)

    const ttlFailure = new Error("native TTL setup failed")
    const ttlHost = newNodeMDNSHostWithFactory(function rejectTTL(options): Socket {
      const created = createSocket(options)
      Reflect.set(created, "setMulticastTTL", function throwTTL(): void {
        throw ttlFailure
      })
      return created
    }, fixtureInterfaces)
    await expect(
      ttlHost.bindDatagram(background(), bindOptions(networkInterface, await unusedIPv4Port()))
    ).rejects.toBe(ttlFailure)
  })

  test("validates live socket operations and preserves queued datagrams after a canceled waiter", async () => {
    const captured: NativeCapture = { options: null, socket: null, multicastTTL: null }
    const host = newNodeMDNSHostWithFactory(function capture(options): Socket {
      const created = createSocket(options)
      captured.socket = created
      return created
    }, networkInterfaces)
    const networkInterface = await actualIPv4(host)
    let socket: MDNSDatagramSocket | null = null
    try {
      socket = await host.bindDatagram(
        background(),
        bindOptions(networkInterface, await unusedIPv4Port())
      )
      await expect(
        socket.joinMulticast(background(), "224.0.0.251", "other-interface")
      ).rejects.toThrow(TypeError)
      await expect(socket.joinMulticast(background(), "", networkInterface.id)).rejects.toThrow(
        TypeError
      )
      await expect(socket.setMulticastInterface(background(), "other-interface")).rejects.toThrow(
        TypeError
      )

      const target: MDNSAddress = { family: "ipv4", address: "224.0.0.251", port: 5_353 }
      await expect(
        Reflect.apply(socket.send, socket, [background(), "invalid", target])
      ).rejects.toThrow(TypeError)
      await expect(
        socket.send(background(), new Uint8Array([1]), {
          family: "ipv6",
          address: "ff02::fb",
          port: 5_353
        })
      ).rejects.toThrow(TypeError)
      await expect(
        socket.send(background(), new Uint8Array([1]), {
          family: "ipv4",
          address: "",
          port: 5_353
        })
      ).rejects.toThrow(TypeError)
      await expect(
        socket.send(background(), new Uint8Array([1]), {
          family: "ipv4",
          address: "224.0.0.251",
          port: 0
        })
      ).rejects.toThrow(RangeError)

      const active = captured.socket
      if (active === null) throw new Error("Node mDNS native socket was not captured")
      const sendFailure = new Error("native send callback failed")
      Reflect.set(
        active,
        "send",
        function rejectSend(
          _data: Uint8Array,
          _port: number,
          _address: string,
          callback: (error: Error | null) => void
        ): void {
          callback(sendFailure)
        }
      )
      await expect(socket.send(background(), new Uint8Array([1]), target)).rejects.toBe(sendFailure)
      const synchronousSendFailure = new Error("native send threw")
      Reflect.set(active, "send", function throwSend(): void {
        throw synchronousSendFailure
      })
      await expect(socket.send(background(), new Uint8Array([1]), target)).rejects.toBe(
        synchronousSendFailure
      )

      const receiveFailure = new Error("receive Context inspection failed")
      const waiting = socket.receive(throwingReceiveContext(receiveFailure))
      active.emit("message", new Uint8Array([9]), {
        address: "2001:db8::9",
        family: "IPv6",
        port: 5_353,
        size: 1
      })
      await expect(waiting).rejects.toBe(receiveFailure)
      const queued = await socket.receive(background())
      expect(Array.from(queued.data)).toEqual([9])
      expect(queued.remote.family).toBe("ipv6")

      const deliveryCancellation = new Error("receive canceled during delivery")
      const canceledDuringDelivery = socket.receive(cancelingReceiveContext(deliveryCancellation))
      active.emit("message", new Uint8Array([8]), {
        address: "192.0.2.8",
        family: "IPv4",
        port: 5_353,
        size: 1
      })
      await expect(canceledDuringDelivery).rejects.toBe(deliveryCancellation)
      expect(Array.from((await socket.receive(background())).data)).toEqual([8])

      const [ctx, cancel] = withCancelCause(background())
      const canceledReceive = new Error("receive canceled before admission")
      cancel(canceledReceive)
      await expect(socket.receive(ctx)).rejects.toBe(canceledReceive)
    } finally {
      await cleanup(socket)
    }
  })

  test("removes an abandoned waiter, owns active membership cleanup, and rejects clean closed operations", async () => {
    const captured: NativeCapture = { options: null, socket: null, multicastTTL: null }
    let droppedMemberships = 0
    const host = newNodeMDNSHostWithFactory(function capture(options): Socket {
      const created = createSocket(options)
      captured.socket = created
      created.addMembership = function acceptMembership(): void {}
      created.dropMembership = function countDrop(): void {
        droppedMemberships += 1
      }
      return created
    }, networkInterfaces)
    const networkInterface = await actualIPv4(host)
    let socket: MDNSDatagramSocket | null = null
    try {
      socket = await host.bindDatagram(
        background(),
        bindOptions(networkInterface, await unusedIPv4Port())
      )
      await expect(
        Reflect.apply(socket.setMulticastLoopback, socket, [background(), "enabled"])
      ).rejects.toThrow(TypeError)

      const [receiveContext, cancelReceive] = withCancelCause(background())
      const receiveFailure = new Error("pending receive abandoned")
      const abandoned = socket.receive(receiveContext)
      cancelReceive(receiveFailure)
      await expect(abandoned).rejects.toBe(receiveFailure)

      const active = captured.socket
      if (active === null) throw new Error("Node mDNS native socket was not captured")
      active.emit("message", new Uint8Array([7]), {
        address: "192.0.2.7",
        family: "IPv4",
        port: 5_353,
        size: 1
      })
      expect(Array.from((await socket.receive(background())).data)).toEqual([7])

      const membership = await socket.joinMulticast(
        background(),
        "224.0.0.251",
        networkInterface.id
      )
      await socket.close(background())
      await socket.settled()
      active.emit("message", new Uint8Array([8]), {
        address: "192.0.2.8",
        family: "IPv4",
        port: 5_353,
        size: 1
      })
      await membership.leave(background())
      expect(droppedMemberships).toBe(0)

      const target: MDNSAddress = { family: "ipv4", address: "224.0.0.251", port: 5_353 }
      await expect(
        socket.joinMulticast(background(), target.address, networkInterface.id)
      ).rejects.toThrow("closed")
      await expect(socket.setMulticastLoopback(background(), true)).rejects.toThrow("closed")
      await expect(socket.setMulticastInterface(background(), networkInterface.id)).rejects.toThrow(
        "closed"
      )
      await expect(socket.send(background(), new Uint8Array([1]), target)).rejects.toThrow("closed")
      await expect(socket.receive(background())).rejects.toThrow("closed")
      socket = null
    } finally {
      await cleanup(socket)
    }
  })

  test("a synchronous close event wins over a later native close throw", async () => {
    const captured: NativeCapture = { options: null, socket: null, multicastTTL: null }
    let nativeClose: (() => void) | null = null
    const host = newNodeMDNSHostWithFactory(function capture(options): Socket {
      const created = createSocket(options)
      captured.socket = created
      nativeClose = created.close.bind(created)
      return created
    }, networkInterfaces)
    const networkInterface = await actualIPv4(host)
    const socket = await host.bindDatagram(
      background(),
      bindOptions(networkInterface, await unusedIPv4Port())
    )
    const active = captured.socket
    if (active === null || nativeClose === null)
      throw new Error("Node mDNS native close seam was not captured")
    Reflect.set(active, "close", function closeThenThrow(): void {
      active.emit("close")
      if (nativeClose !== null) nativeClose()
      throw new Error("late close throw")
    })
    await socket.close(background())
    await socket.settled()
  })

  test("rejects a clean native terminal that wins before listening admission", async () => {
    const host = newNodeMDNSHostWithFactory(function closeDuringBind(options): Socket {
      const socket = createSocket(options)
      Reflect.set(socket, "bind", function closeBeforeListening(): void {
        socket.emit("close")
      })
      return socket
    }, networkInterfaces)
    const networkInterface = await actualIPv4(newNodeMDNSHost())
    await expect(
      host.bindDatagram(background(), bindOptions(networkInterface, await unusedIPv4Port()))
    ).rejects.toThrow("closed before bind admission")
  })
})
