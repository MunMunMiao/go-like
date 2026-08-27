import type { Context } from "@go-like/context"
import { type ServiceInstance, type Watcher } from "@go-like/registry"

import { newChangeBus } from "./changes"
import { newDiscoveryManager } from "./discovery"
import { newNativeZookeeperClient } from "./native"
import { captureOptions, operationOptions } from "./options"
import { newRegistrationManager } from "./registration"
import type { ZookeeperRegistry, ZookeeperRegistryOptions } from "./types"

export type {
  ZookeeperAcl,
  ZookeeperAuth,
  ZookeeperAuthenticationError,
  ZookeeperChildren,
  ZookeeperClient,
  ZookeeperClientFactory,
  ZookeeperClientFactoryOptions,
  ZookeeperClientState,
  ZookeeperMutation,
  ZookeeperOperation,
  ZookeeperOperationError,
  ZookeeperRegistry,
  ZookeeperRegistryOptions
} from "./types"

/** Creates the sole Node/Bun ZooKeeper Registry with owned native sessions. */
export function newZookeeperRegistry(options: ZookeeperRegistryOptions): ZookeeperRegistry {
  const provider = captureOptions(options, newNativeZookeeperClient)
  const changes = newChangeBus()
  const registrations = newRegistrationManager(changes)
  const discovery = newDiscoveryManager(changes)
  return Object.freeze({
    /** Registers or replaces one ServiceInstance through a private ephemeral owner. */
    async register(ctx: Context, service: ServiceInstance): Promise<void> {
      await registrations.register(ctx, service, operationOptions(provider, provider.common))
    },
    /** Deregisters the deterministic service instance path. */
    async deregister(ctx: Context, service: ServiceInstance): Promise<void> {
      await registrations.deregister(ctx, service, operationOptions(provider, provider.common))
    },
    /** Reads complete verified ServiceInstance declarations. */
    getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
      return discovery.getService(ctx, name, operationOptions(provider, provider.common))
    },
    /** Opens one complete replacement-snapshot watcher for one service name. */
    watch(ctx: Context, name: string): Promise<Watcher> {
      return discovery.watch(ctx, name, provider, operationOptions(provider, provider.common))
    }
  })
}
