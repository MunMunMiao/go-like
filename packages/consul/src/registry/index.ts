import type { ServiceInstance, Watcher } from "@go-like/core/registry"
import type { Context } from "@go-like/core/context"

import type { ConsulClient } from "../client/client"
import { newDiscoveryManager } from "./discovery"
import { captureOptions, operationOptions } from "./options"
import { newRegistrationManager } from "./registration"
import type { ConsulRegistry, ConsulRegistryOptions } from "./types"

export type { ConsulRegistry, ConsulRegistryOptions } from "./types"

/** Creates the sole unified Consul Registry on a shared Consul client. */
export function newConsulRegistry(
  client: ConsulClient,
  options?: ConsulRegistryOptions
): ConsulRegistry {
  const provider = captureOptions(client, options)
  const registrations = newRegistrationManager()
  const discovery = newDiscoveryManager()
  return Object.freeze({
    /** Registers one ServiceInstance through a private TTL owner. */
    async register(ctx: Context, instance: ServiceInstance): Promise<void> {
      await registrations.register(ctx, instance, operationOptions(provider, provider.common))
    },
    /** Deregisters one ServiceInstance and releases its private TTL owner. */
    async deregister(ctx: Context, instance: ServiceInstance): Promise<void> {
      await registrations.deregister(ctx, instance, operationOptions(provider, provider.common))
    },
    /** Reads complete passing ServiceInstance declarations. */
    getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
      return discovery.getService(ctx, name, operationOptions(provider, provider.common))
    },
    /** Opens one complete replacement-snapshot watcher for a service name. */
    watch(ctx: Context, name: string): Promise<Watcher> {
      return discovery.watch(ctx, name, provider, operationOptions(provider, provider.common))
    }
  })
}
