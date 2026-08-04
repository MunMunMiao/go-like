import type { Context } from "@go-like/context"
import type { Registry } from "@go-like/registry"
import type { RegistrationErrorHandler } from "@go-like/registry/provider"

/** Supplies runtime-specific datagram and interface capabilities to the portable provider. */
export interface MDNSHost {
  /** Lists runtime network interfaces under the caller Context. */
  networkInterfaces(ctx: Context): Promise<readonly MDNSNetworkInterface[]>
  /** Binds one datagram socket without transferring host ownership. */
  bindDatagram(ctx: Context, options: MDNSBindOptions): Promise<MDNSDatagramSocket>
}

/** Owns one bound datagram socket created by an injected MDNSHost. */
export interface MDNSDatagramSocket {
  /** Returns the stable socket terminal Promise. */
  settled(): Promise<void>
  /** Joins one multicast group and returns its owning membership. */
  joinMulticast(ctx: Context, group: string, interfaceId: string | number): Promise<MDNSMembership>
  /** Configures multicast loopback. */
  setMulticastLoopback(ctx: Context, enabled: boolean): Promise<void>
  /** Selects the outbound multicast interface. */
  setMulticastInterface(ctx: Context, interfaceId: string | number): Promise<void>
  /** Sends one datagram to an explicit target. */
  send(ctx: Context, data: Uint8Array, target: MDNSAddress): Promise<void>
  /** Receives one datagram. */
  receive(ctx: Context): Promise<MDNSDatagram>
  /** Closes the owned socket while the caller may abandon waiting. */
  close(ctx: Context): Promise<void>
}

/** Owns one multicast membership created through a datagram socket. */
export interface MDNSMembership {
  /** Leaves the multicast group. */
  leave(ctx: Context): Promise<void>
}

/** Identifies one supported multicast address family. */
export type MDNSFamily = "ipv4" | "ipv6"

/** Describes one runtime network interface snapshot. */
export interface MDNSNetworkInterface {
  readonly id: string | number
  readonly name: string
  readonly family: MDNSFamily
  readonly address: string
  readonly internal: boolean
}

/** Configures one runtime datagram bind operation. */
export interface MDNSBindOptions {
  readonly family: MDNSFamily
  readonly bindAddress: string
  readonly port: number
  readonly interfaceId: string | number
  readonly interfaceAddress: string
  readonly reuseAddress: boolean
  readonly multicastTTL: number
}

/** Describes one UDP datagram target or remote peer. */
export interface MDNSAddress {
  readonly family: MDNSFamily
  readonly address: string
  readonly port: number
}

/** Carries one received datagram and optional runtime interface metadata. */
export interface MDNSDatagram {
  readonly data: Uint8Array
  readonly remote: MDNSAddress
  readonly interfaceId?: string | number
}

/** Captures immutable provider construction options. */
export interface MDNSOptions {
  readonly domain: string
  readonly interfaceIds: readonly (string | number)[]
  readonly families: readonly MDNSFamily[]
  readonly queryTimeoutMs: number
  readonly port: number
  readonly maxPacketBytes: number
  readonly maxDecodedPayloadBytes: number
  readonly watchBufferSize: number
  readonly ttlMs: number
  readonly onRegistrationError: RegistrationErrorHandler | null
}

/** Reduces one immutable mDNS provider option snapshot. */
export type MDNSOption = (options: MDNSOptions) => MDNSOptions

/** Identifies the unified mDNS Registry result. */
export interface MDNSRegistry extends Registry {}
