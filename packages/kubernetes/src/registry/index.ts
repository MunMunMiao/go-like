import type { Context } from "@go-like/core/context"
import type { ServiceInstance, Watcher } from "@go-like/core/registry"

import type { KubernetesClient } from "../client/client"
import { newDiscoveryManager } from "./discovery"
import { captureOptions, operationOptions } from "./options"
import { newRegistrationManager } from "./registration"
import type { KubernetesRegistry, KubernetesRegistryOptions } from "./types"

export type { KubernetesPodOwner, KubernetesRegistry, KubernetesRegistryOptions } from "./types"

/** Creates one namespace-scoped Kubernetes EndpointSlice Registry. */
export function newKubernetesRegistry(
  client: KubernetesClient,
  options: KubernetesRegistryOptions
): KubernetesRegistry {
  const provider = captureOptions(client, options)
  const registrations = newRegistrationManager()
  const discovery = newDiscoveryManager()
  return Object.freeze({
    /** Registers or replaces one ServiceInstance. */
    async register(ctx: Context, instance: ServiceInstance): Promise<void> {
      await registrations.register(ctx, instance, operationOptions(provider, provider.common))
    },
    /** Deregisters one exact current ServiceInstance. */
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
