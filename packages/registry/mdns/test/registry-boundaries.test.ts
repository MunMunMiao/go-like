import { describe, expect, test } from "bun:test"

import { background, withCancelCause, withTimeout, type Context } from "@go-like/context"
import { type ServiceInstance, type Watcher } from "@go-like/registry"

import { decodeDNSPacket, encodeDNSPacket, type DNSRecord, type DNSSRVData } from "../src/dns"
import {
  families,
  interfaces,
  maxPacketBytes,
  onRegistrationError,
  queryTimeout,
  ttl,
  watchBufferSize
} from "../src/options"
import { instanceRecords } from "../src/registration"
import { newMDNSRegistry as createMDNSRegistry } from "../src/registry"
import { newMemoryMDNSNetwork, type MemoryMDNSNetwork } from "../src/testing"
import type {
  MDNSAddress,
  MDNSBindOptions,
  MDNSDatagram,
  MDNSDatagramSocket,
  MDNSHost,
  MDNSMembership,
  MDNSNetworkInterface,
  MDNSOption,
  MDNSRegistry
} from "../src/types"

/** Creates a short-lived provider for deterministic boundary tests. */
function newMDNSRegistry(host: MDNSHost, ...options: readonly MDNSOption[]): MDNSRegistry {
  return createMDNSRegistry(host, ...options, ttl(2_000))
}

interface SocketHooks {
  readonly settled?: () => Promise<void>
  readonly joinMulticast?: (
    ctx: Context,
    group: string,
    interfaceId: string | number
  ) => Promise<MDNSMembership>
  readonly setMulticastLoopback?: (ctx: Context, enabled: boolean) => Promise<void>
  readonly setMulticastInterface?: (ctx: Context, interfaceId: string | number) => Promise<void>
  readonly send?: (ctx: Context, data: Uint8Array, target: MDNSAddress) => Promise<void>
  readonly receive?: (ctx: Context) => Promise<MDNSDatagram>
  readonly close?: (ctx: Context) => Promise<void>
}

/** Creates one deterministic Registry instance fixture. */
function instance(
  endpoint = "http://127.0.0.1:8080/",
  id = "node-1",
  revision = "one"
): ServiceInstance {
  return {
    id,
    name: "boundary-service",
    version: "v1",
    metadata: { revision },
    endpoints: [endpoint]
  }
}

/** Creates one complete datagram-socket delegate with selected fault hooks. */
function wrapSocket(inner: MDNSDatagramSocket, hooks: SocketHooks): MDNSDatagramSocket {
  return Object.freeze({
    settled(): Promise<void> {
      return hooks.settled === undefined ? inner.settled() : hooks.settled()
    },
    joinMulticast(
      ctx: Context,
      group: string,
      interfaceId: string | number
    ): Promise<MDNSMembership> {
      return hooks.joinMulticast === undefined
        ? inner.joinMulticast(ctx, group, interfaceId)
        : hooks.joinMulticast(ctx, group, interfaceId)
    },
    setMulticastLoopback(ctx: Context, enabled: boolean): Promise<void> {
      return hooks.setMulticastLoopback === undefined
        ? inner.setMulticastLoopback(ctx, enabled)
        : hooks.setMulticastLoopback(ctx, enabled)
    },
    setMulticastInterface(ctx: Context, interfaceId: string | number): Promise<void> {
      return hooks.setMulticastInterface === undefined
        ? inner.setMulticastInterface(ctx, interfaceId)
        : hooks.setMulticastInterface(ctx, interfaceId)
    },
    send(ctx: Context, data: Uint8Array, target: MDNSAddress): Promise<void> {
      return hooks.send === undefined
        ? inner.send(ctx, data, target)
        : hooks.send(ctx, data, target)
    },
    receive(ctx: Context): Promise<MDNSDatagram> {
      return hooks.receive === undefined ? inner.receive(ctx) : hooks.receive(ctx)
    },
    close(ctx: Context): Promise<void> {
      return hooks.close === undefined ? inner.close(ctx) : hooks.close(ctx)
    }
  })
}

/** Decorates every socket created by one borrowed host. */
function decorateHost(
  base: MDNSHost,
  decorate: (socket: MDNSDatagramSocket, index: number) => MDNSDatagramSocket
): MDNSHost {
  let index = 0
  return Object.freeze({
    networkInterfaces(ctx: Context): Promise<readonly MDNSNetworkInterface[]> {
      return base.networkInterfaces(ctx)
    },
    async bindDatagram(ctx: Context, options: MDNSBindOptions): Promise<MDNSDatagramSocket> {
      const socket = await base.bindDatagram(ctx, options)
      index += 1
      return decorate(socket, index)
    }
  })
}

/** Waits for one watcher snapshot under a bounded Context. */
async function next(watcher: Watcher): Promise<readonly ServiceInstance[]> {
  const [ctx, cancel] = withTimeout(background(), 3_000)
  try {
    return await watcher.next(ctx)
  } finally {
    cancel()
  }
}

/** Sends one raw datagram from a temporary deterministic host. */
async function sendRaw(
  network: MemoryMDNSNetwork,
  id: string,
  data: Uint8Array,
  family: MDNSAddress["family"] = "ipv4"
): Promise<void> {
  const ipv6 = family === "ipv6"
  const host = network.host(id)
  const socket = await host.bindDatagram(background(), {
    family,
    bindAddress: ipv6 ? "::" : "0.0.0.0",
    port: 5_353,
    interfaceId: `${id}-${family}`,
    interfaceAddress: ipv6 ? "::1" : "127.0.0.1",
    reuseAddress: true,
    multicastTTL: 255
  })
  try {
    await socket.send(background(), data, {
      family,
      address: ipv6 ? "ff02::fb" : "224.0.0.251",
      port: 5_353
    })
  } finally {
    await socket.close(background())
    await socket.settled()
  }
}

/** Sends several packets from one stable fake publisher identity. */
async function sendPackets(
  network: MemoryMDNSNetwork,
  id: string,
  packets: readonly Uint8Array[]
): Promise<void> {
  const host = network.host(id)
  const socket = await host.bindDatagram(background(), {
    family: "ipv4",
    bindAddress: "0.0.0.0",
    port: 5_353,
    interfaceId: `${id}-ipv4`,
    interfaceAddress: "127.0.0.1",
    reuseAddress: true,
    multicastTTL: 255
  })
  try {
    for (const data of packets) {
      await socket.send(background(), data, {
        family: "ipv4",
        address: "224.0.0.251",
        port: 5_353
      })
    }
  } finally {
    await socket.close(background())
    await socket.settled()
  }
}

/** Encodes one mDNS response from an exact record set. */
function response(records: readonly DNSRecord[]): Uint8Array {
  return encodeDNSPacket(
    {
      id: 0,
      response: true,
      questions: [],
      answers: records,
      authorities: [],
      additionals: []
    },
    1_200
  )
}

/** Waits one short turn for asynchronous receiver loops to consume a packet. */
function receiverTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

describe("mDNS Registry boundaries", () => {
  test("validates construction and exposes only Registrar and Discovery operations", () => {
    expect(() => newMDNSRegistry(null as never)).toThrow(TypeError)
    expect(() => newMDNSRegistry({} as never)).toThrow(TypeError)
    const network = newMemoryMDNSNetwork()
    const registry = newMDNSRegistry(network.host("options"), queryTimeout(5))
    expect(Object.keys(registry).sort()).toEqual(["deregister", "getService", "register", "watch"])
  })

  test("rejects invalid interface inventories, selections, and non-local endpoints before binding", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("interfaces")
    const invalid: MDNSHost = {
      networkInterfaces(): Promise<readonly MDNSNetworkInterface[]> {
        return Promise.resolve([null as never])
      },
      bindDatagram: base.bindDatagram
    }
    await expect(newMDNSRegistry(invalid).getService(background(), "x")).rejects.toThrow(TypeError)

    const duplicate: MDNSHost = {
      async networkInterfaces(ctx): Promise<readonly MDNSNetworkInterface[]> {
        const values = await base.networkInterfaces(ctx)
        const first = values[0]
        if (first === undefined) throw new Error("missing fixture interface")
        return [first, first]
      },
      bindDatagram: base.bindDatagram
    }
    await expect(newMDNSRegistry(duplicate).getService(background(), "x")).rejects.toThrow(
      TypeError
    )
    const unavailable: MDNSHost = {
      networkInterfaces(): Promise<readonly MDNSNetworkInterface[]> {
        return Promise.resolve([])
      },
      bindDatagram: base.bindDatagram
    }
    await expect(newMDNSRegistry(unavailable).getService(background(), "x")).rejects.toMatchObject({
      code: "GO_LIKE_UNSUPPORTED_REGISTRY_CAPABILITY"
    })
    await expect(
      newMDNSRegistry(base, interfaces("missing")).getService(background(), "x")
    ).rejects.toThrow(TypeError)
    await expect(
      newMDNSRegistry(base).register(background(), instance("http://127.0.0.2:8080/"))
    ).rejects.toMatchObject({ code: "GO_LIKE_UNSUPPORTED_REGISTRY_CAPABILITY" })
    expect(network.activeSockets()).toBe(0)
  })

  test("rolls back an accepted first-family socket when a later bind fails", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("partial-bind")
    const failure = new Error("second bind failed")
    let binds = 0
    const host: MDNSHost = {
      networkInterfaces: base.networkInterfaces,
      async bindDatagram(ctx, options): Promise<MDNSDatagramSocket> {
        binds += 1
        if (binds === 2) throw failure
        return base.bindDatagram(ctx, options)
      }
    }
    await expect(
      newMDNSRegistry(host, families("ipv4", "ipv6"), queryTimeout(5)).getService(background(), "x")
    ).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("aggregates setup and cleanup failures without leaking the partial socket", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("setup-failure")
    const setup = new Error("interface setup failed")
    const cleanup = new Error("partial close failed")
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        setMulticastInterface(): Promise<void> {
          return Promise.reject(setup)
        },
        async close(ctx): Promise<void> {
          await socket.close(ctx)
          throw cleanup
        }
      })
    )
    const observed = await newMDNSRegistry(host, queryTimeout(5))
      .getService(background(), "x")
      .catch((error: unknown) => error)
    expect(observed).toBeInstanceOf(AggregateError)
    expect((observed as AggregateError).errors).toEqual([setup, cleanup])
    expect(network.activeSockets()).toBe(0)
  })

  test("registration announcement failure is rolled back and closes every socket", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("announcement-failure")
    const failure = new Error("announcement failed")
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        send(ctx, data, target): Promise<void> {
          const packet = decodeDNSPacket(data, 1_200)
          return packet.response ? Promise.reject(failure) : socket.send(ctx, data, target)
        }
      })
    )
    await expect(
      newMDNSRegistry(host, queryTimeout(5)).register(background(), instance())
    ).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("a failed goodbye keeps registration ownership retryable", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("goodbye-retry")
    const failure = new Error("goodbye failed")
    let failed = false
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        send(ctx, data, target): Promise<void> {
          const packet = decodeDNSPacket(data, 1_200)
          const goodbye = packet.response && packet.answers.some((record) => record.ttl === 0)
          if (goodbye && !failed) {
            failed = true
            return Promise.reject(failure)
          }
          return socket.send(ctx, data, target)
        }
      })
    )
    const registry = newMDNSRegistry(host, queryTimeout(5))
    const current = instance()
    await registry.register(background(), current)
    await expect(registry.deregister(background(), current)).rejects.toBe(failure)
    await registry.deregister(background(), current)
    expect(network.activeSockets()).toBe(0)
  })

  test("query send and receive failures preserve identity and close operation sockets", async () => {
    for (const phase of ["send", "receive"] as const) {
      const network = newMemoryMDNSNetwork()
      const base = network.host(`query-${phase}`)
      const failure = new Error(`query ${phase} failed`)
      const host = decorateHost(base, (socket) =>
        wrapSocket(
          socket,
          phase === "send"
            ? { send: () => Promise.reject(failure) }
            : { receive: () => Promise.reject(failure) }
        )
      )
      await expect(
        newMDNSRegistry(host, queryTimeout(5)).getService(background(), "missing")
      ).rejects.toBe(failure)
      expect(network.activeSockets()).toBe(0)
    }
  })

  test("watch initial-query failure closes listener resources", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("watch-setup")
    const failure = new Error("watch query failed")
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, { send: () => Promise.reject(failure) })
    )
    await expect(
      newMDNSRegistry(host, queryTimeout(5)).watch(background(), "boundary-service")
    ).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("watch passive socket failure rejects next and releases resources", async () => {
    const network = newMemoryMDNSNetwork()
    const host = network.host("watch-crash")
    const watcher = await newMDNSRegistry(host, queryTimeout(5)).watch(
      background(),
      "boundary-service"
    )
    const pending = watcher.next(background())
    const failure = new Error("host crashed")
    host.crash(failure)
    await expect(pending).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("malformed unrelated datagrams are ignored before a valid snapshot", async () => {
    const network = newMemoryMDNSNetwork()
    const watcher = await newMDNSRegistry(
      network.host("observer"),
      queryTimeout(5),
      watchBufferSize(4)
    ).watch(background(), "boundary-service")
    await sendRaw(network, "attacker", new Uint8Array([0, 1, 2]))
    await sendRaw(
      network,
      "irrelevant",
      encodeDNSPacket(
        {
          id: 0,
          response: true,
          questions: [],
          answers: [],
          authorities: [],
          additionals: []
        },
        1_200
      )
    )
    const publisher = newMDNSRegistry(network.host("publisher"), queryTimeout(5))
    const current = instance()
    await publisher.register(background(), current)
    expect(await next(watcher)).toEqual([current])
    await publisher.deregister(background(), current)
    expect(await next(watcher)).toEqual([])
    await watcher.stop(background())
    expect(network.activeSockets()).toBe(0)
  })

  test("retains shared service records while another local instance remains", async () => {
    const network = newMemoryMDNSNetwork()
    const publisher = newMDNSRegistry(network.host("multi-publisher"), queryTimeout(5))
    const watcher = await newMDNSRegistry(
      network.host("multi-observer"),
      queryTimeout(5),
      watchBufferSize(8)
    ).watch(background(), "boundary-service")
    const first = instance("http://127.0.0.1:8080/", "one")
    const second = instance("http://127.0.0.1:8080/", "two")
    await publisher.register(background(), first)
    expect(await next(watcher)).toEqual([first])
    await publisher.register(background(), second)
    expect(await next(watcher)).toEqual([first, second])
    await publisher.deregister(background(), first)
    expect(await next(watcher)).toEqual([second])
    await publisher.deregister(background(), second)
    expect(await next(watcher)).toEqual([])
    await watcher.stop(background())
    expect(network.activeSockets()).toBe(0)
  })

  test("preserves Context causes across all public operation admissions", async () => {
    const network = newMemoryMDNSNetwork()
    const registry = newMDNSRegistry(network.host("canceled"), queryTimeout(5))
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("caller canceled")
    cancel(failure)
    await expect(registry.register(ctx, instance())).rejects.toBe(failure)
    await expect(registry.deregister(ctx, instance())).rejects.toBe(failure)
    await expect(registry.getService(ctx, "boundary-service")).rejects.toBe(failure)
    await expect(registry.watch(ctx, "boundary-service")).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("rolls back accepted resources when Context cancellation wins between families", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("between-families")
    const [ctx, cancel] = withCancelCause(background())
    const failure = new Error("canceled before second family")
    let joins = 0
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        async joinMulticast(joinContext, group, interfaceId): Promise<MDNSMembership> {
          const membership = await socket.joinMulticast(joinContext, group, interfaceId)
          joins += 1
          if (joins === 1) cancel(failure)
          return membership
        }
      })
    )
    await expect(
      newMDNSRegistry(host, families("ipv4", "ipv6"), queryTimeout(5)).getService(ctx, "x")
    ).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("splits one complete dual-family record graph into bounded response packets", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("packet-splitting")
    let responses = 0
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        send(ctx, data, target): Promise<void> {
          if (decodeDNSPacket(data, 1_200).response) responses += 1
          return socket.send(ctx, data, target)
        }
      })
    )
    const registry = newMDNSRegistry(
      host,
      families("ipv4", "ipv6"),
      maxPacketBytes(512),
      queryTimeout(5)
    )
    const current: ServiceInstance = {
      ...instance(),
      endpoints: ["http://127.0.0.1:8080/", "http://[::1]:8080/"]
    }
    await registry.register(background(), current)
    expect(responses).toBeGreaterThan(2)
    await registry.deregister(background(), current)
    expect(network.activeSockets()).toBe(0)
  })

  test("ignores malformed query responses and malformed registration queries", async () => {
    const queryNetwork = newMemoryMDNSNetwork()
    let injectMalformedResponse = true
    const queryHost = decorateHost(queryNetwork.host("query-reader"), (socket) =>
      wrapSocket(socket, {
        receive(ctx): Promise<MDNSDatagram> {
          if (!injectMalformedResponse) return socket.receive(ctx)
          injectMalformedResponse = false
          return Promise.resolve({
            data: new Uint8Array([0, 1, 2]),
            remote: { family: "ipv4", address: "127.0.0.1", port: 5_353 }
          })
        }
      })
    )
    const reader = newMDNSRegistry(queryHost, queryTimeout(30))
    await expect(reader.getService(background(), "missing")).resolves.toEqual([])
    expect(queryNetwork.activeSockets()).toBe(0)

    const registrationNetwork = newMemoryMDNSNetwork()
    const registry = newMDNSRegistry(registrationNetwork.host("query-responder"), queryTimeout(5))
    const current = instance()
    await registry.register(background(), current)
    await sendRaw(registrationNetwork, "bad-query", new Uint8Array([0, 1, 2]))
    await receiverTurn()
    expect(await registry.getService(background(), current.name)).toEqual([current])
    await registry.deregister(background(), current)
    expect(registrationNetwork.activeSockets()).toBe(0)
  })

  test("converges registration owners after receive and response-send failures", async () => {
    for (const phase of ["receive", "response"] as const) {
      const network = newMemoryMDNSNetwork()
      const base = network.host(`registration-${phase}`)
      const failure = new Error(`registration ${phase} failed`)
      let responseCount = 0
      const host = decorateHost(base, (socket) =>
        wrapSocket(
          socket,
          phase === "receive"
            ? {
                receive(ctx): Promise<MDNSDatagram> {
                  return ctx.deadline()[1] ? socket.receive(ctx) : Promise.reject(failure)
                }
              }
            : {
                send(ctx, data, target): Promise<void> {
                  if (decodeDNSPacket(data, 1_200).response) {
                    responseCount += 1
                    if (responseCount > 1) return Promise.reject(failure)
                  }
                  return socket.send(ctx, data, target)
                }
              }
        )
      )
      const registry = newMDNSRegistry(host, queryTimeout(5))
      await registry.register(background(), instance())
      if (phase === "response") {
        await newMDNSRegistry(network.host("response-reader"), queryTimeout(10)).getService(
          background(),
          "boundary-service"
        )
      }
      await receiverTurn()
      expect(network.activeSockets()).toBe(0)
    }
  })

  test("reports registration cleanup failure after the socket itself is closed", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("registration-cleanup")
    const failure = new Error("registration close failed")
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        async close(ctx): Promise<void> {
          await socket.close(ctx)
          throw failure
        }
      })
    )
    const registry = newMDNSRegistry(host, queryTimeout(5))
    const current = instance()
    await registry.register(background(), current)
    await expect(registry.deregister(background(), current)).rejects.toBe(failure)
    expect(network.activeSockets()).toBe(0)
  })

  test("rejects an empty watcher name and propagates receive-loop failure", async () => {
    const emptyNetwork = newMemoryMDNSNetwork()
    await expect(
      newMDNSRegistry(emptyNetwork.host("empty-watch")).watch(background(), "")
    ).rejects.toThrow(TypeError)
    expect(emptyNetwork.activeSockets()).toBe(0)

    const failureNetwork = newMemoryMDNSNetwork()
    const base = failureNetwork.host("watch-receive")
    const failure = new Error("watch receive failed")
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, { receive: () => Promise.reject(failure) })
    )
    await expect(
      newMDNSRegistry(host, queryTimeout(5)).watch(background(), "boundary-service")
    ).rejects.toThrow()
    expect(failureNetwork.activeSockets()).toBe(0)
  })

  test("cleans up after passive registration loss", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("logged-crash")
    let ownedSocket: MDNSDatagramSocket | null = null
    const host = decorateHost(base, (socket) => {
      ownedSocket = socket
      return socket
    })
    const registry = newMDNSRegistry(host, queryTimeout(5))
    await registry.register(background(), instance())
    if (ownedSocket === null) throw new Error("registration socket was not captured")
    await (ownedSocket as MDNSDatagramSocket).close(background())
    await Promise.resolve()
    expect(network.activeSockets()).toBe(0)
  })

  test("handles a rejected registration socket terminal as passive owner loss", async () => {
    const network = newMemoryMDNSNetwork()
    const host = network.host("terminal-failure")
    const failure = new Error("passive socket failure")
    const notifications: { readonly error: Error; readonly service: ServiceInstance }[] = []
    const registry = newMDNSRegistry(
      host,
      queryTimeout(5),
      onRegistrationError(function notify(error, service): Promise<void> {
        notifications.push({ error, service })
        return Promise.reject(new Error("borrowed terminal observer failed"))
      })
    )
    const current = instance()
    await registry.register(background(), current)
    host.crash(failure)
    await Promise.resolve()
    await Promise.resolve()
    expect(notifications).toEqual([{ error: failure, service: current }])
    expect(notifications[0]?.service).not.toBe(current)
    expect(Object.isFrozen(notifications[0]?.service)).toBe(true)
    expect(network.activeSockets()).toBe(0)
    await registry.deregister(background(), current)
  })

  test("a retired registration generation cannot notify its replacement", async () => {
    const network = newMemoryMDNSNetwork()
    const host = network.host("generation-fence")
    const notifications: ServiceInstance[] = []
    const registry = newMDNSRegistry(
      host,
      queryTimeout(5),
      onRegistrationError(function notify(_error, service): void {
        notifications.push(service)
      })
    )
    const initial = instance()
    const replacement = instance("http://127.0.0.1:8081/", "node-1", "two")
    await registry.register(background(), initial)
    await registry.register(background(), replacement)
    await Promise.resolve()
    expect(notifications).toEqual([])
    const failure = new Error("current generation failed")
    host.crash(failure)
    await Promise.resolve()
    await Promise.resolve()
    expect(notifications).toEqual([replacement])
    expect(network.activeSockets()).toBe(0)
  })

  test("aggregates membership and socket cleanup failures after watcher stop", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("cleanup-failures")
    const leaveFailure = new Error("leave failed")
    const closeFailure = new Error("close failed")
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        async joinMulticast(ctx, group, interfaceId): Promise<MDNSMembership> {
          const membership = await socket.joinMulticast(ctx, group, interfaceId)
          return Object.freeze({
            async leave(leaveContext: Context): Promise<void> {
              await membership.leave(leaveContext)
              throw leaveFailure
            }
          })
        },
        async close(ctx): Promise<void> {
          await socket.close(ctx)
          throw closeFailure
        }
      })
    )
    const watcher = await newMDNSRegistry(host, queryTimeout(5)).watch(
      background(),
      "boundary-service"
    )
    const observed = await watcher.stop(background()).catch((error: unknown) => error)
    expect(observed).toBeInstanceOf(AggregateError)
    expect((observed as AggregateError).errors).toEqual([leaveFailure, closeFailure])
    expect(network.activeSockets()).toBe(0)
  })

  test("fails a watcher closed on managed identity and RR-graph conflicts", async () => {
    const current = instance()
    const canonical = await instanceRecords(current, "go-like.", 2, 65_536)
    const identityOwner = canonical.find((record) => record.type === "SRV")?.name
    if (identityOwner === undefined) throw new Error("fixture identity owner is missing")
    const fakeOwner = `li-${"a".repeat(52)}.${identityOwner.split(".").slice(1).join(".")}`
    const renamed = canonical.map((record): DNSRecord => {
      const data = record.data === identityOwner ? fakeOwner : record.data
      return Object.freeze({
        name: record.name === identityOwner ? fakeOwner : record.name,
        type: record.type,
        ttl: record.ttl,
        flush: record.flush,
        data
      })
    })

    const invalidOwnerNetwork = newMemoryMDNSNetwork()
    const invalidOwnerWatcher = await newMDNSRegistry(
      invalidOwnerNetwork.host("invalid-owner-observer"),
      queryTimeout(5)
    ).watch(background(), current.name)
    const invalidOwnerPending = invalidOwnerWatcher.next(background())
    await sendRaw(
      invalidOwnerNetwork,
      "invalid-owner-publisher",
      response([
        {
          name: `li-${"b".repeat(52)}.go-like.`,
          type: "TXT",
          ttl: 2,
          flush: true,
          data: [new TextEncoder().encode("Go-Like-Wire-Version=2")]
        }
      ])
    )
    await expect(invalidOwnerPending).rejects.toMatchObject({
      code: "GO_LIKE_REGISTRY_PROTOCOL"
    })
    expect(invalidOwnerNetwork.activeSockets()).toBe(0)

    const renamedNetwork = newMemoryMDNSNetwork()
    const renamedWatcher = await newMDNSRegistry(
      renamedNetwork.host("renamed-observer"),
      queryTimeout(5)
    ).watch(background(), current.name)
    const renamedPending = renamedWatcher.next(background())
    await sendRaw(renamedNetwork, "renamed-publisher", response(renamed))
    await expect(renamedPending).rejects.toMatchObject({
      code: "GO_LIKE_REGISTRY_PROTOCOL"
    })
    expect(renamedNetwork.activeSockets()).toBe(0)

    const conflicting = canonical.map((record): DNSRecord => {
      if (record.type !== "SRV") return record
      const data = record.data
      if (typeof data !== "object" || data === null || Array.isArray(data) || !("port" in data)) {
        throw new Error("fixture SRV payload is invalid")
      }
      const srv: DNSSRVData = {
        priority: data.priority,
        weight: data.weight,
        port: data.port + 1,
        target: data.target
      }
      return Object.freeze({ ...record, data: srv })
    })
    const conflictNetwork = newMemoryMDNSNetwork()
    const conflictWatcher = await newMDNSRegistry(
      conflictNetwork.host("conflict-observer"),
      queryTimeout(5)
    ).watch(background(), current.name)
    const conflictPending = conflictWatcher.next(background())
    await sendRaw(conflictNetwork, "conflict-publisher", response(conflicting))
    await expect(conflictPending).rejects.toMatchObject({
      code: "GO_LIKE_REGISTRY_PROTOCOL"
    })
    expect(conflictNetwork.activeSockets()).toBe(0)
  })

  test("keeps incomplete managed graphs silent until all expected address records arrive", async () => {
    const current: ServiceInstance = {
      ...instance(),
      endpoints: ["http://127.0.0.1:8080/", "http://[::1]:8080/"]
    }
    const records = await instanceRecords(current, "go-like.", 2, 65_536)
    for (const mode of ["no-address", "missing-ipv6"] as const) {
      const network = newMemoryMDNSNetwork()
      const watcher = await newMDNSRegistry(
        network.host(`${mode}-observer`),
        queryTimeout(5)
      ).watch(background(), current.name)
      const selected = records.filter((record) =>
        mode === "no-address"
          ? record.type !== "A" && record.type !== "AAAA"
          : record.type !== "AAAA"
      )
      await sendRaw(network, `${mode}-publisher`, response(selected))
      await receiverTurn()
      await watcher.stop(background())
      expect(network.activeSockets()).toBe(0)
    }
  })

  test("bounds wire-assembler publisher and record retention", async () => {
    const publisherNetwork = newMemoryMDNSNetwork()
    const publisherWatcher = await newMDNSRegistry(
      publisherNetwork.host("publisher-limit-observer"),
      queryTimeout(5)
    ).watch(background(), "boundary-service")
    const irrelevant: DNSRecord = {
      name: "noise.go-like.",
      type: "PTR",
      ttl: 2,
      flush: false,
      data: "target.go-like."
    }
    for (let index = 0; index < 65; index += 1) {
      await sendRaw(
        publisherNetwork,
        `publisher-limit-${index}`,
        response([{ ...irrelevant, name: `noise-${index}.go-like.` }])
      )
    }
    await receiverTurn()
    await publisherWatcher.stop(background())
    expect(publisherNetwork.activeSockets()).toBe(0)

    const recordNetwork = newMemoryMDNSNetwork()
    const recordWatcher = await newMDNSRegistry(
      recordNetwork.host("record-limit-observer"),
      queryTimeout(5)
    ).watch(background(), "boundary-service")
    const packets: Uint8Array[] = []
    for (let index = 0; index < 257; index += 1) {
      packets.push(response([{ ...irrelevant, name: `record-${index}.go-like.` }]))
    }
    await sendPackets(recordNetwork, "record-limit-publisher", packets)
    await receiverTurn()
    await recordWatcher.stop(background())
    expect(recordNetwork.activeSockets()).toBe(0)
  })

  test("ignores invalid UTF-8 TXT markers without failing the watcher", async () => {
    const network = newMemoryMDNSNetwork()
    const watcher = await newMDNSRegistry(network.host("utf8-observer"), queryTimeout(5)).watch(
      background(),
      "boundary-service"
    )
    await sendRaw(
      network,
      "utf8-publisher",
      response([
        {
          name: "noise.go-like.",
          type: "TXT",
          ttl: 2,
          flush: true,
          data: [new Uint8Array([255])]
        }
      ])
    )
    await receiverTurn()
    await watcher.stop(background())
    expect(network.activeSockets()).toBe(0)
  })

  test("aliases multiple IPv6 packet sources to one advertised instance identity", async () => {
    const network = newMemoryMDNSNetwork()
    const watcher = await newMDNSRegistry(
      network.host("ipv6-observer"),
      families("ipv6"),
      queryTimeout(5),
      watchBufferSize(8)
    ).watch(background(), "boundary-service")
    const initial = instance("http://[::1]:8080/", "node-1", "one")
    const updated = instance("http://[::1]:8080/", "node-1", "two")
    await sendRaw(
      network,
      "ipv6-first",
      response(await instanceRecords(initial, "go-like.", 2, 65_536)),
      "ipv6"
    )
    expect(await next(watcher)).toEqual([initial])
    await sendRaw(
      network,
      "ipv6-second",
      response(await instanceRecords(updated, "go-like.", 2, 65_536)),
      "ipv6"
    )
    expect(await next(watcher)).toEqual([updated])
    await watcher.stop(background())
    expect(network.activeSockets()).toBe(0)
  })

  test("fails registration when goodbye rescue cannot be sent", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("rescue-owner")
    const failure = new Error("rescue send failed")
    let rescue = false
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        async receive(ctx): Promise<MDNSDatagram> {
          const datagram = await socket.receive(ctx)
          try {
            const packet = decodeDNSPacket(datagram.data, 1_200)
            if (packet.response && packet.answers.some((record) => record.ttl === 0)) {
              rescue = true
            }
          } catch {
            // Unmanaged traffic does not arm this injected rescue failure.
          }
          return datagram
        },
        send(ctx, data, target): Promise<void> {
          if (rescue && decodeDNSPacket(data, 1_200).response) {
            rescue = false
            return Promise.reject(failure)
          }
          return socket.send(ctx, data, target)
        }
      })
    )
    const owner = newMDNSRegistry(host, queryTimeout(5))
    const peer = newMDNSRegistry(network.host("rescue-peer"), queryTimeout(5))
    const current = instance()
    await owner.register(background(), current)
    await peer.register(background(), current)
    await peer.deregister(background(), current)
    await receiverTurn()
    expect(network.activeSockets()).toBe(0)
  })

  test("refreshes a short-TTL registration before graceful deregistration", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("refresh")
    let responses = 0
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        send(ctx, data, target): Promise<void> {
          if (decodeDNSPacket(data, 1_200).response) responses += 1
          return socket.send(ctx, data, target)
        }
      })
    )
    const registry = newMDNSRegistry(host, queryTimeout(5))
    const current = instance()
    await registry.register(background(), current)
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    expect(responses).toBeGreaterThan(1)
    await registry.deregister(background(), current)
    expect(network.activeSockets()).toBe(0)
  }, 3_000)

  test("a refresh-send failure converges the private registration owner", async () => {
    const network = newMemoryMDNSNetwork()
    const base = network.host("refresh-failure")
    const failure = new Error("refresh failed")
    let responses = 0
    const host = decorateHost(base, (socket) =>
      wrapSocket(socket, {
        send(ctx, data, target): Promise<void> {
          if (decodeDNSPacket(data, 1_200).response) {
            responses += 1
            if (responses > 1) return Promise.reject(failure)
          }
          return socket.send(ctx, data, target)
        }
      })
    )
    const registry = newMDNSRegistry(host, queryTimeout(5))
    await registry.register(background(), instance())
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    expect(network.activeSockets()).toBe(0)
  }, 3_000)
})
