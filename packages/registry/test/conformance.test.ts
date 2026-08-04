import { expect, test } from "bun:test"

import { background, cause, withCancelCause, type Context } from "@go-like/context"
import { type Registry, type ServiceInstance, type Watcher } from "../src/index"
import { snapshotServiceInstance, snapshotServiceInstances } from "../src/provider"
import { registryConformanceCases } from "../src/testing"

interface WatchState {
  readonly name: string
  readonly queue: (readonly ServiceInstance[])[]
  pending: WatchWaiter | null
  stopped: boolean
}

interface WatchWaiter {
  readonly resolve: (value: readonly ServiceInstance[]) => void
  readonly reject: (reason: unknown) => void
}

interface Backend {
  readonly instances: Map<string, ServiceInstance>
  readonly watchers: Set<WatchState>
}

/** Throws the active Context failure before provider side effects. */
function check(ctx: Context): void {
  if (ctx.err() !== null) throw cause(ctx) ?? ctx.err()
}

/** Returns one complete snapshot for a service name. */
function values(backend: Backend, name: string): readonly ServiceInstance[] {
  return snapshotServiceInstances(
    Array.from(backend.instances.values()).filter((service) => service.name === name)
  )
}

/** Publishes one replacement snapshot to matching watchers. */
function publish(backend: Backend, name: string): void {
  const snapshot = values(backend, name)
  for (const watcher of backend.watchers) {
    if (watcher.stopped || watcher.name !== name) continue
    const pending = watcher.pending
    if (pending === null) watcher.queue.push(snapshot)
    else {
      watcher.pending = null
      pending.resolve(snapshot)
    }
  }
}

/** Creates one structural in-memory Registry for conformance itself. */
function newRegistry(backend: Backend, initialMisses = 0): Registry {
  let remainingMisses = initialMisses
  return Object.freeze({
    async register(ctx: Context, value: ServiceInstance): Promise<void> {
      check(ctx)
      const service = snapshotServiceInstance(value)
      backend.instances.set(service.id, service)
      publish(backend, service.name)
    },
    async deregister(ctx: Context, value: ServiceInstance): Promise<void> {
      check(ctx)
      const service = snapshotServiceInstance(value)
      backend.instances.delete(service.id)
      publish(backend, service.name)
    },
    async getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]> {
      check(ctx)
      if (remainingMisses > 0) {
        remainingMisses -= 1
        return []
      }
      return values(backend, name)
    },
    async watch(ctx: Context, name: string): Promise<Watcher> {
      check(ctx)
      const state: WatchState = { name, queue: [], pending: null, stopped: false }
      const initial = values(backend, name)
      if (initial.length > 0) state.queue.push(initial)
      backend.watchers.add(state)
      return Object.freeze({
        async next(nextContext: Context): Promise<readonly ServiceInstance[]> {
          check(nextContext)
          if (state.stopped) throw new Error("watcher stopped")
          const snapshot = state.queue.shift()
          if (snapshot !== undefined) return snapshot
          if (state.pending !== null) throw new Error("test watcher already has a pending next")
          return await new Promise<readonly ServiceInstance[]>((resolve, reject) => {
            state.pending = { resolve, reject }
          })
        },
        async stop(stopContext: Context): Promise<void> {
          check(stopContext)
          if (state.stopped) return
          state.stopped = true
          backend.watchers.delete(state)
          const pending = state.pending
          state.pending = null
          pending?.reject(new Error("watcher stopped"))
        }
      })
    }
  })
}

/** Creates one isolated fake backend. */
function backend(): Backend {
  return { instances: new Map(), watchers: new Set() }
}

const service = (revision: "initial" | "updated"): ServiceInstance => ({
  id: "catalog-1",
  name: "catalog",
  version: revision === "initial" ? "v1" : "v2",
  metadata: { revision },
  endpoints: [revision === "initial" ? "http://127.0.0.1:8000" : "http://127.0.0.1:9000"]
})

const cases = registryConformanceCases({
  createRegistry() {
    return newRegistry(backend())
  },
  createSharedRegistries() {
    const shared = backend()
    const pair: readonly [Registry, Registry] = [newRegistry(shared), newRegistry(shared, 1)]
    return Object.freeze(pair)
  },
  service
})

test("publishes the compact canonical conformance inventory", () => {
  expect(cases.map((value) => value.name)).toEqual([
    "register, discover, update, and deregister one service instance",
    "watch publishes complete replacement snapshots",
    "independent clients converge through one shared backend"
  ])
})

for (const value of cases) test(value.name, value.run)

test("rejects malformed conformance subjects and timeouts", () => {
  expect(() => registryConformanceCases(null as never)).toThrow(TypeError)
  expect(() =>
    registryConformanceCases({
      createRegistry: () => newRegistry(backend()),
      createSharedRegistries: () => {
        const shared = backend()
        return [newRegistry(shared), newRegistry(shared)]
      },
      service,
      convergenceTimeoutMs: 0
    })
  ).toThrow(RangeError)
})

test("rejects shared registry factories that never converge", async () => {
  const conformance = registryConformanceCases({
    createRegistry: () => newRegistry(backend()),
    createSharedRegistries() {
      const pair: readonly [Registry, Registry] = [newRegistry(backend()), newRegistry(backend())]
      return pair
    },
    service,
    convergenceTimeoutMs: 1
  })
  const convergence = conformance.at(-1)
  if (convergence === undefined) throw new Error("convergence case is missing")
  await expect(convergence.run()).rejects.toThrow(
    "Registry conformance failed: shared registration did not converge"
  )
})

test("the fake registry itself preserves Context identity", async () => {
  const registry = newRegistry(backend())
  const failure = new Error("canceled")
  const [ctx, cancel] = withCancelCause(background())
  cancel(failure)
  await expect(registry.register(ctx, service("initial"))).rejects.toBe(failure)
  expect(await registry.getService(background(), "catalog")).toEqual([])
})

test("the fake watcher returns an existing snapshot and stop terminates a pending next", async () => {
  const registry = newRegistry(backend())
  const existing = service("initial")
  await registry.register(background(), existing)
  const watcher = await registry.watch(background(), existing.name)

  expect(await watcher.next(background())).toEqual([snapshotServiceInstance(existing)])
  const stopped = watcher.next(background()).then(
    () => false,
    (error: unknown) => error instanceof Error && error.message === "watcher stopped"
  )
  await watcher.stop(background())
  expect(await stopped).toBe(true)
})
