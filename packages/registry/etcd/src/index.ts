import type { Context } from "@go-like/context"
import { type ServiceInstance, type Watcher } from "@go-like/registry"

import { newDiscoveryManager } from "./discovery"
import { captureOptions, operationOptions } from "./options"
import { newRegistrationManager } from "./registration"
import type { EtcdRegistry, EtcdRegistryOptions } from "./types"

export type {
  EtcdFetch,
  EtcdHttpError,
  EtcdOperation,
  EtcdRegistry,
  EtcdRegistryOptions,
  EtcdTransportError
} from "./types"

/** Creates the sole unified etcd Registry through a borrowed standard Fetch capability. */
export function newEtcdRegistry(options: EtcdRegistryOptions): EtcdRegistry {
  const provider = captureOptions(options)
  const registrations = newRegistrationManager()
  const discovery = newDiscoveryManager()
  return Object.freeze({
    /** Registers one ServiceInstance through a private lease owner. */
    async register(ctx: Context, instance: ServiceInstance): Promise<void> {
      await registrations.register(ctx, instance, operationOptions(provider, provider.common))
    },
    /** Deregisters one ServiceInstance and releases its private lease owner. */
    async deregister(ctx: Context, instance: ServiceInstance): Promise<void> {
      await registrations.deregister(ctx, instance, operationOptions(provider, provider.common))
    },
    /** Reads complete verified ServiceInstance declarations. */
    getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
      return discovery.getService(ctx, name, operationOptions(provider, provider.common))
    },
    /** Opens one complete replacement-snapshot watcher for a service name. */
    watch(ctx: Context, name: string): Promise<Watcher> {
      return discovery.watch(ctx, name, provider, operationOptions(provider, provider.common))
    }
  })
}
