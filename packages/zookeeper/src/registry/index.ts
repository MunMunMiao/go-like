import type { Context } from "@go-like/core/context"
import type { ServiceInstance, Watcher } from "@go-like/core/registry"

import { newChangeBus } from "./changes"
import { newDiscoveryManager } from "./discovery"
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

/** Creates a ZooKeeper Registry from the required client factory. */
export function newZookeeperRegistry(options: ZookeeperRegistryOptions): ZookeeperRegistry {
  const provider = captureOptions(options)
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
