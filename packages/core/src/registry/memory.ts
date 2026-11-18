import { cause, type Context } from "../context"

import { newSnapshotWatcher } from "./snapshot-watcher"
import { snapshotServiceInstance, snapshotServiceInstances } from "./snapshot"
import type { Registry, ServiceInstance, Watcher } from "./types"

/** Options for one process-local registry. */
export interface MemoryRegistryOptions {
  /** Instances visible before any register call. Snapshotted at construction. */
  readonly instances?: readonly ServiceInstance[]
  /** Per-watcher queue bound, integer 1..4096, default 128. */
  readonly watchBufferSize?: number
}

/** In-process Registry. Two instances never share state. */
export interface MemoryRegistry extends Registry {}

interface WatchHandle {
  publish(snapshot: readonly ServiceInstance[]): void
}

/** Creates an in-process registry. Invalid instances or bounds throw before return. */
export function newMemoryRegistry(options: MemoryRegistryOptions = {}): MemoryRegistry {
  const bufferSize = options.watchBufferSize ?? 128
  if (!Number.isInteger(bufferSize) || bufferSize < 1 || bufferSize > 4_096) {
    throw new RangeError("watchBufferSize must be an integer from 1 through 4096")
  }
  const byName = new Map<string, Map<string, ServiceInstance>>()
  const watchers = new Map<string, Set<WatchHandle>>()
  for (const instance of options.instances ?? []) {
    const snapshot = snapshotServiceInstance(instance)
    store(byName, snapshot)
  }

  /** Publishes the current complete snapshot for one service name. */
  function publish(name: string): void {
    const snapshot = current(name)
    const targets = watchers.get(name)
    if (targets === undefined) return
    for (const target of targets) target.publish(snapshot)
  }

  /** Returns the frozen snapshot for one name, including the empty snapshot. */
  function current(name: string): readonly ServiceInstance[] {
    const instances = byName.get(name)
    return snapshotServiceInstances(instances === undefined ? [] : Array.from(instances.values()))
  }

  return {
    /** Inserts or replaces one instance and notifies watchers of that name. */
    async register(ctx: Context, service: ServiceInstance): Promise<void> {
      const failure = cause(ctx)
      if (failure !== null) throw failure
      const snapshot = snapshotServiceInstance(service)
      store(byName, snapshot)
      publish(snapshot.name)
    },
    /** Removes one instance identity. A missing identity is a no-op. */
    async deregister(ctx: Context, service: ServiceInstance): Promise<void> {
      const failure = cause(ctx)
      if (failure !== null) throw failure
      const snapshot = snapshotServiceInstance(service)
      const instances = byName.get(snapshot.name)
      if (instances === undefined || !instances.has(snapshot.id)) return
      instances.delete(snapshot.id)
      if (instances.size === 0) byName.delete(snapshot.name)
      publish(snapshot.name)
    },
    /** Returns the current complete snapshot. An unknown name is empty. */
    async getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
      const failure = cause(ctx)
      if (failure !== null) throw failure
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("service name must be a non-empty string")
      }
      return current(name)
    },
    /** Opens one replacement-snapshot watcher. An non-empty current snapshot is the first next. */
    async watch(ctx: Context, name: string): Promise<Watcher> {
      const failure = cause(ctx)
      if (failure !== null) throw failure
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("service name must be a non-empty string")
      }
      const handle = newSnapshotWatcher(ctx, { initial: current(name), bufferSize })
      let group = watchers.get(name)
      if (group === undefined) {
        group = new Set()
        watchers.set(name, group)
      }
      group.add(handle)
      const owned = group
      const inner = handle.watcher
      return {
        /** Returns the next complete snapshot for this name. */
        next(nextCtx: Context): Promise<readonly ServiceInstance[]> {
          return inner.next(nextCtx)
        },
        /** Stops this watcher and detaches it from later publications. */
        async stop(stopCtx: Context): Promise<void> {
          owned.delete(handle)
          if (owned.size === 0) watchers.delete(name)
          await inner.stop(stopCtx)
        }
      }
    }
  }
}

/** Stores one instance under its name and id, replacing a previous id. */
function store(byName: Map<string, Map<string, ServiceInstance>>, instance: ServiceInstance): void {
  let instances = byName.get(instance.name)
  if (instances === undefined) {
    instances = new Map()
    byName.set(instance.name, instances)
  }
  instances.set(instance.id, instance)
}
