import { background } from "@go-like/context"

import { snapshotServiceInstance, snapshotServiceInstances } from "./snapshot"
import type { Registry, ServiceInstance, Watcher } from "./types"

/** Defines one runner-neutral Registry conformance case. */
export interface RegistryConformanceCase {
  readonly name: string
  readonly run: () => Promise<void>
}

/** Supplies isolated providers and deterministic fixtures to conformance. */
export interface RegistryConformanceSubject {
  readonly createRegistry: () => Registry | PromiseLike<Registry>
  readonly createSharedRegistries: () =>
    | readonly [Registry, Registry]
    | PromiseLike<readonly [Registry, Registry]>
  readonly service: (revision: "initial" | "updated") => ServiceInstance
  readonly convergenceTimeoutMs?: number
}

/** Fails one provider-neutral assertion. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Registry conformance failed: ${message}`)
}

/** Returns whether two service-instance snapshots are equal. */
function equal(left: ServiceInstance, right: ServiceInstance): boolean {
  return (
    JSON.stringify(snapshotServiceInstance(left)) === JSON.stringify(snapshotServiceInstance(right))
  )
}

/** Returns whether a snapshot contains one exact instance. */
function contains(values: readonly ServiceInstance[], expected: ServiceInstance): boolean {
  return snapshotServiceInstances(values).some((value) => equal(value, expected))
}

/** Waits one short portable convergence turn. */
function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

/** Polls shared backends until one expected state is visible. */
async function eventually(
  timeoutMs: number,
  check: () => Promise<boolean>,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Registry conformance failed: ${message}`)
    await turn()
  }
}

/** Best-effort stops a watcher after one case. */
async function stop(watcher: Watcher | null): Promise<void> {
  if (watcher !== null) await watcher.stop(background())
}

/** Builds the portable Registry conformance inventory. */
export function registryConformanceCases(
  subject: RegistryConformanceSubject
): readonly RegistryConformanceCase[] {
  if (
    typeof subject !== "object" ||
    subject === null ||
    typeof subject.createRegistry !== "function" ||
    typeof subject.createSharedRegistries !== "function" ||
    typeof subject.service !== "function"
  ) {
    throw new TypeError("Registry conformance subject is invalid")
  }
  const timeoutMs = subject.convergenceTimeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("Registry convergence timeout must be an integer from 1 through 60000")
  }

  const initial = snapshotServiceInstance(subject.service("initial"))
  const updated = snapshotServiceInstance(subject.service("updated"))
  ensure(
    initial.id === updated.id && initial.name === updated.name,
    "updated fixture changed identity"
  )

  return Object.freeze([
    Object.freeze({
      name: "register, discover, update, and deregister one service instance",
      async run(): Promise<void> {
        const registry = await subject.createRegistry()
        await registry.register(background(), initial)
        ensure(
          contains(await registry.getService(background(), initial.name), initial),
          "registered instance was not discoverable"
        )
        await registry.register(background(), updated)
        const values = await registry.getService(background(), initial.name)
        ensure(
          values.length === 1 && contains(values, updated),
          "registration update was not atomic"
        )
        await registry.deregister(background(), updated)
        ensure(
          (await registry.getService(background(), initial.name)).length === 0,
          "deregistered instance remained discoverable"
        )
      }
    }),
    Object.freeze({
      name: "watch publishes complete replacement snapshots",
      async run(): Promise<void> {
        const registry = await subject.createRegistry()
        let watcher: Watcher | null = await registry.watch(background(), initial.name)
        try {
          await registry.register(background(), initial)
          ensure(contains(await watcher.next(background()), initial), "watch omitted registration")
          await registry.register(background(), updated)
          const replacement = await watcher.next(background())
          ensure(
            replacement.length === 1 && contains(replacement, updated),
            "watch did not replace the updated instance"
          )
          await registry.deregister(background(), updated)
          ensure((await watcher.next(background())).length === 0, "watch omitted deregistration")
        } finally {
          const owned = watcher
          watcher = null
          await stop(owned)
        }
      }
    }),
    Object.freeze({
      name: "independent clients converge through one shared backend",
      async run(): Promise<void> {
        const registries = await subject.createSharedRegistries()
        ensure(
          Array.isArray(registries) && registries.length === 2 && registries[0] !== registries[1],
          "shared factory must return two distinct registries"
        )
        const publisher = registries[0] as Registry
        const reader = registries[1] as Registry
        await publisher.register(background(), initial)
        await eventually(
          timeoutMs,
          async () => contains(await reader.getService(background(), initial.name), initial),
          "shared registration did not converge"
        )
        await publisher.deregister(background(), initial)
        await eventually(
          timeoutMs,
          async () => (await reader.getService(background(), initial.name)).length === 0,
          "shared deregistration did not converge"
        )
      }
    })
  ])
}
