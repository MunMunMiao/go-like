import type { Context } from "@likego/context"
import { type ServiceInstance, type Watcher } from "@likego/registry"

import { newDiscoveryManager } from "./discovery"
import { captureOptions, operationOptions } from "./options"
import { newRegistrationManager } from "./registration"
import type { KubernetesRegistry, KubernetesRegistryOptions } from "./types"

export type {
  KubernetesFetch,
  KubernetesHttpError,
  KubernetesOperation,
  KubernetesPodOwner,
  KubernetesRegistry,
  KubernetesRegistryOptions,
  KubernetesTransportError
} from "./types"

/** Creates one namespace-scoped Kubernetes EndpointSlice Registry. */
export function newKubernetesRegistry(options: KubernetesRegistryOptions): KubernetesRegistry {
  const provider = captureOptions(options)
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
