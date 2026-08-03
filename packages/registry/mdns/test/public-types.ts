import type { Context } from "@likego/context"
import type { Registry } from "@likego/registry"
import {
  domain,
  families,
  interfaces,
  maxDecodedPayloadBytes,
  maxPacketBytes,
  newMDNSRegistry,
  onRegistrationError,
  port,
  queryTimeout,
  ttl,
  watchBufferSize,
  type MDNSAddress,
  type MDNSBindOptions,
  type MDNSDatagram,
  type MDNSDatagramSocket,
  type MDNSHost,
  type MDNSMembership,
  type MDNSNetworkInterface,
  type MDNSOption,
  type MDNSOptions,
  type MDNSRegistry
} from "../src/index"
import { newNodeMDNSHost } from "../src/node"
import { newMemoryMDNSNetwork, type MemoryMDNSHost, type MemoryMDNSNetwork } from "../src/testing"

const membership: MDNSMembership = {
  leave(_ctx: Context): Promise<void> {
    return Promise.resolve()
  }
}
const socket: MDNSDatagramSocket = {
  settled(): Promise<void> {
    return Promise.resolve()
  },
  joinMulticast(_ctx, _group, _interfaceId): Promise<MDNSMembership> {
    return Promise.resolve(membership)
  },
  setMulticastLoopback(): Promise<void> {
    return Promise.resolve()
  },
  setMulticastInterface(): Promise<void> {
    return Promise.resolve()
  },
  send(): Promise<void> {
    return Promise.resolve()
  },
  receive(): Promise<MDNSDatagram> {
    return new Promise<MDNSDatagram>(function pending() {})
  },
  close(): Promise<void> {
    return Promise.resolve()
  }
}
const networkInterface: MDNSNetworkInterface = {
  id: "en0",
  name: "en0",
  family: "ipv4",
  address: "127.0.0.1",
  internal: false
}
const host: MDNSHost = {
  networkInterfaces(): Promise<readonly MDNSNetworkInterface[]> {
    return Promise.resolve([networkInterface])
  },
  bindDatagram(_ctx: Context, _options: MDNSBindOptions): Promise<MDNSDatagramSocket> {
    return Promise.resolve(socket)
  }
}
const options: readonly MDNSOption[] = [
  domain("mesh.local"),
  interfaces("en0"),
  families("ipv4"),
  queryTimeout(1_000),
  port(5_353),
  maxPacketBytes(1_200),
  maxDecodedPayloadBytes(65_536),
  watchBufferSize(128),
  ttl(120_000),
  onRegistrationError(() => Promise.resolve())
]
const registry: Registry = newMDNSRegistry(host, ...options)
const concrete: MDNSRegistry = newMDNSRegistry(host)
const snapshot: MDNSOptions = {
  domain: "likego.",
  interfaceIds: [],
  families: ["ipv4"],
  queryTimeoutMs: 1_000,
  port: 5_353,
  maxPacketBytes: 1_200,
  maxDecodedPayloadBytes: 65_536,
  watchBufferSize: 128,
  ttlMs: 120_000,
  onRegistrationError: null
}
const address: MDNSAddress = { family: "ipv4", address: "224.0.0.251", port: 5_353 }
const memoryNetwork: MemoryMDNSNetwork = newMemoryMDNSNetwork()
const memoryHost: MemoryMDNSHost = memoryNetwork.host("types")
const nodeHost: MDNSHost = newNodeMDNSHost()
void registry
void concrete
void snapshot
void address
void memoryHost
void nodeHost

// @ts-expect-error Node host is isolated from the portable root entrypoint.
import("../src/index").then((module) => module.newNodeMDNSHost())
