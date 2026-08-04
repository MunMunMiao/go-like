import { background, withCancelCause, withTimeout } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import { expect, test } from "bun:test"

import { encodeRecord, instancePath, servicePath, servicesPath } from "../src/codec"
import { newOperationError } from "../src/errors"
import {
  newZookeeperRegistry,
  type ZookeeperClientFactory,
  type ZookeeperRegistry,
  type ZookeeperRegistryOptions
} from "../src/index"
import { fakeZookeeper, fixture } from "./helpers"

/** Creates one fast Registry over a shared fake ensemble. */
function registry(
  zookeeper: ReturnType<typeof fakeZookeeper>,
  logger: ZookeeperRegistryOptions["logger"] = null
) {
  return newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: zookeeper.factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100,
    logger
  })
}

/** Creates one fast Registry with a provider-owned watcher queue size. */
function registryWithWatchBuffer(
  zookeeper: ReturnType<typeof fakeZookeeper>,
  size: number
): ZookeeperRegistry {
  return newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: zookeeper.factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100,
    watchBufferSize: size
  })
}

/** Creates a Registry whose first registration readback returns another valid instance. */
function mismatchedReadbackRegistry(
  zookeeper: ReturnType<typeof fakeZookeeper>,
  replacement: ServiceInstance,
  failRollback: boolean
): ZookeeperRegistry {
  let corrupt = true
  const factory: ZookeeperClientFactory = function create(options) {
    const client = zookeeper.factory(options)
    let removes = 0
    return Object.freeze({
      ...client,
      async data(path: string, signal: AbortSignal) {
        if (corrupt) {
          corrupt = false
          return encodeRecord("/go-like/registry/v1", replacement).data
        }
        return client.data(path, signal)
      },
      async remove(path: string, signal: AbortSignal) {
        removes += 1
        if (failRollback && removes === 2) {
          throw newOperationError("remove", -102, false)
        }
        return client.remove(path, signal)
      }
    })
  }
  return newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100
  })
}

/** Waits until one assertion converges. */
async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = performance.now() + 2_000
  let last: unknown
  while (performance.now() < deadline) {
    try {
      await assertion()
      return
    } catch (value) {
      last = value
      await Bun.sleep(10)
    }
  }
  throw last
}

test("reads, deterministic registration, update, and cleanup align the root contract", async () => {
  const zookeeper = fakeZookeeper()
  const subject = registry(zookeeper)
  expect(await subject.getService(background(), "missing")).toEqual([])
  expect(Object.keys(subject).sort()).toEqual(["deregister", "getService", "register", "watch"])

  const initial = fixture("initial")
  await subject.register(background(), initial)
  expect(await subject.getService(background(), initial.name)).toEqual([initial])
  expect(zookeeper.paths()).toContain(
    instancePath("/go-like/registry/v1", initial.name, initial.id)
  )
  const updated = fixture("updated")
  await subject.register(background(), updated)
  expect(await subject.getService(background(), initial.name)).toEqual([updated])
  await subject.deregister(background(), updated)
  expect(await subject.getService(background(), initial.name)).toEqual([])
  expect(zookeeper.activeSessions()).toBe(0)
})

test("watch returns complete replacement snapshots and re-arms after a dropped notification", async () => {
  const zookeeper = fakeZookeeper()
  const observer = registry(zookeeper)
  const publisher = registry(zookeeper)
  const initial = fixture("initial", "watch/catalog")
  const updated = fixture("updated", "watch/catalog")
  const watcher = await observer.watch(background(), initial.name)
  await publisher.register(background(), initial)
  expect(await watcher.next(background())).toEqual([initial])
  zookeeper.dropNextWatch()
  await publisher.register(background(), updated)
  const [ctx, cancel] = withTimeout(background(), 2_000)
  expect(await watcher.next(ctx)).toEqual([updated])
  cancel()
  await publisher.deregister(background(), updated)
  expect(await watcher.next(background())).toEqual([])
  await watcher.stop(background())
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_WATCHER_STOPPED"
  })
  expect(zookeeper.watchCount(servicePath("/go-like/registry/v1", initial.name))).toBeGreaterThan(1)
  expect(zookeeper.activeSessions()).toBe(0)
})

test("registration and watcher sessions recover after expiration", async () => {
  const zookeeper = fakeZookeeper()
  const subject = registry(zookeeper)
  const value = fixture("initial", "recovery")
  await subject.register(background(), value)
  const watcher = await subject.watch(background(), value.name)
  expect(await watcher.next(background())).toEqual([value])
  zookeeper.expireSessions()
  await eventually(async function restored(): Promise<void> {
    expect(await subject.getService(background(), value.name)).toEqual([value])
  })
  await subject.deregister(background(), value)
  expect(await watcher.next(background())).toEqual([])
  await watcher.stop(background())
})

test("watch buffer overflow and malformed provider records fail closed", async () => {
  const zookeeper = fakeZookeeper()
  const subject = registryWithWatchBuffer(zookeeper, 1)
  const name = "overflow"
  const watcher = await subject.watch(background(), name)
  await subject.register(background(), { ...fixture("initial", name), id: "one" })
  await subject.register(background(), { ...fixture("initial", name), id: "two" })
  await expect(watcher.next(background())).rejects.toMatchObject({
    code: "GO_LIKE_WATCHER_OVERFLOW"
  })

  const corrupt = fakeZookeeper()
  const reader = registry(corrupt)
  const path = instancePath("/go-like/registry/v1", "corrupt", "id")
  const raw = await corrupt.putRaw(path, new TextEncoder().encode("{"))
  await expect(reader.getService(background(), "corrupt")).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
  await raw.close(new AbortController().signal)
})

test("tree helpers leave only provider roots after deregistration", async () => {
  const zookeeper = fakeZookeeper()
  const subject = registry(zookeeper)
  const value = fixture("initial", "prune")
  await subject.register(background(), value)
  await subject.deregister(background(), value)
  expect(zookeeper.paths()).toContain(servicesPath("/go-like/registry/v1"))
  expect(zookeeper.paths()).not.toContain(servicePath("/go-like/registry/v1", value.name))
})

test("discovery validates names, closes best effort, and rejects failed watch admission", async () => {
  const zookeeper = fakeZookeeper()
  const subject = registry(zookeeper)
  expect(() => subject.getService(background(), "")).toThrow("service name must be non-empty")
  zookeeper.failNext("close", -4)
  expect(await subject.getService(background(), "missing")).toEqual([])
  zookeeper.expireSessions()

  const rejected = fakeZookeeper()
  rejected.failNext("connect", -102)
  await expect(registry(rejected).watch(background(), "admission")).rejects.toMatchObject({
    nativeCode: -102,
    operation: "connect"
  })
  expect(rejected.activeSessions()).toBe(0)
})

test("watcher waits honor caller cancellation and stop rejects remaining waiters", async () => {
  const zookeeper = fakeZookeeper()
  const watcher = await registry(zookeeper).watch(background(), "waiters")
  const [ctx, cancel] = withCancelCause(background())
  const exact = new Error("caller canceled")
  const canceled = watcher.next(ctx)
  cancel(exact)
  await expect(canceled).rejects.toBe(exact)

  const stopped = watcher.next(background())
  await watcher.stop(background())
  await expect(stopped).rejects.toMatchObject({ code: "GO_LIKE_WATCHER_STOPPED" })
  expect(zookeeper.activeSessions()).toBe(0)
})

test("watcher reconciliation retries transient reads and terminates on protocol failures", async () => {
  const retryable = fakeZookeeper()
  const retryObserver = registry(retryable)
  const retryPublisher = registry(retryable)
  const retryValue = fixture("initial", "reconcile-retry")
  const retryWatcher = await retryObserver.watch(background(), retryValue.name)
  retryable.failNext("watch-children", -4)
  await retryPublisher.register(background(), retryValue)
  await Bun.sleep(10)
  retryable.emitConnected()
  const [retryContext, cancelRetry] = withTimeout(background(), 2_000)
  expect(await retryWatcher.next(retryContext)).toEqual([retryValue])
  cancelRetry()
  await retryWatcher.stop(background())
  await retryPublisher.deregister(background(), retryValue)

  const terminal = fakeZookeeper()
  const terminalObserver = registry(terminal)
  const terminalPublisher = registry(terminal)
  const terminalValue = fixture("initial", "reconcile-terminal")
  const terminalWatcher = await terminalObserver.watch(background(), terminalValue.name)
  const failed = terminalWatcher.next(background())
  terminal.failNext("watch-children", -102)
  await terminalPublisher.register(background(), terminalValue)
  await expect(failed).rejects.toMatchObject({
    nativeCode: -102,
    operation: "watch-children"
  })
  await terminalWatcher.stop(background())
  await terminalPublisher.deregister(background(), terminalValue)
})

test("watcher recovery retries transient sessions and stops during backoff", async () => {
  const zookeeper = fakeZookeeper()
  const observer = registry(zookeeper)
  const publisher = registry(zookeeper)
  const value = fixture("initial", "watch-recovery-retry")
  const watcher = await observer.watch(background(), value.name)
  const sessions = zookeeper.sessionCount()
  zookeeper.failNext("connect", -4)
  zookeeper.expireSessions()
  await eventually(function recovered(): void {
    expect(zookeeper.sessionCount()).toBeGreaterThanOrEqual(sessions + 2)
    expect(zookeeper.stateListenerCount()).toBe(1)
  })
  await publisher.register(background(), value)
  expect(await watcher.next(background())).toEqual([value])
  await watcher.stop(background())
  await publisher.deregister(background(), value)

  const interrupted = fakeZookeeper()
  const slow = newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: interrupted.factory,
    retryInitialMs: 100,
    retryMaximumMs: 100,
    reconcileIntervalMs: 100
  })
  const stopping = await slow.watch(background(), "watch-recovery-stop")
  const before = interrupted.sessionCount()
  interrupted.failNext("connect", -4)
  interrupted.expireSessions()
  await eventually(function waiting(): void {
    expect(interrupted.sessionCount()).toBe(before + 1)
    expect(interrupted.closeCalls()).toBeGreaterThanOrEqual(2)
  })
  await stopping.stop(background())
  expect(interrupted.activeSessions()).toBe(0)
})

test("watcher native state terminals fail pending waits", async () => {
  const authentication = fakeZookeeper()
  const authWatcher = await registry(authentication).watch(background(), "authentication")
  authentication.emitConnected()
  const authWait = authWatcher.next(background())
  authentication.emitAuthenticationFailure()
  await expect(authWait).rejects.toMatchObject({ code: "GO_LIKE_REGISTRY_PROTOCOL" })
  await authWatcher.stop(background())

  const terminal = fakeZookeeper()
  const terminalWatcher = await registry(terminal).watch(background(), "recovery-terminal")
  const terminalWait = terminalWatcher.next(background())
  terminal.failNext("connect", -102)
  terminal.expireSessions()
  await expect(terminalWait).rejects.toMatchObject({
    nativeCode: -102,
    operation: "connect"
  })
  await terminalWatcher.stop(background())
})

test("registration recovery retries transient sessions and reports diagnostics best effort", async () => {
  const zookeeper = fakeZookeeper()
  const diagnostics: string[] = []
  let terminalNotifications = 0
  const subject = newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: zookeeper.factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100,
    logger: {
      log(_level, message): void {
        diagnostics.push(message)
        throw new Error("diagnostic sink failed")
      }
    },
    onRegistrationError(): void {
      terminalNotifications += 1
    }
  })
  const value = fixture("initial", "registration-recovery")
  await subject.register(background(), value)
  zookeeper.failNext("connect", -4)
  zookeeper.expireSessions()
  await eventually(function reported(): void {
    expect(diagnostics).toEqual(["ZooKeeper registration session recovery failed"])
  })
  await eventually(async function recovered(): Promise<void> {
    expect(await subject.getService(background(), value.name)).toEqual([value])
  })
  expect(terminalNotifications).toBe(0)
  await subject.deregister(background(), value)
})

test("terminal registration recovery invalidates every active generation and notifies once", async () => {
  const zookeeper = fakeZookeeper()
  const notifications: { readonly error: Error; readonly service: ServiceInstance }[] = []
  const subject = newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: zookeeper.factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100,
    onRegistrationError(error, service): Promise<void> {
      notifications.push({ error, service })
      return Promise.reject(new Error("borrowed terminal observer failed"))
    }
  })
  const first = fixture("initial", "terminal-recovery-a")
  const second = fixture("updated", "terminal-recovery-b")
  await subject.register(background(), first)
  await subject.register(background(), second)
  zookeeper.failNext("connect", -102)
  zookeeper.expireSessions()

  await eventually(function notified(): void {
    expect(notifications).toHaveLength(2)
  })
  expect(
    notifications.map(function service(notification): ServiceInstance {
      return notification.service
    })
  ).toEqual([first, second])
  expect(notifications[0]?.error).toMatchObject({ operation: "connect", nativeCode: -102 })
  expect(notifications[1]?.error).toBe(notifications[0]?.error)
  expect(Object.isFrozen(notifications[0]?.service)).toBe(true)
  await subject.deregister(background(), first)
  await subject.deregister(background(), second)
  expect(zookeeper.activeSessions()).toBe(0)
})

test("registration authentication terminal is fenced from later generations", async () => {
  const zookeeper = fakeZookeeper()
  const notifications: ServiceInstance[] = []
  const subject = newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: zookeeper.factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100,
    onRegistrationError(_error, service): void {
      notifications.push(service)
    }
  })
  const initial = fixture("initial", "authentication-terminal")
  const replacement = fixture("updated", initial.name)
  await subject.register(background(), initial)
  zookeeper.emitAuthenticationFailure()
  await eventually(function notified(): void {
    expect(notifications).toEqual([initial])
  })
  await subject.register(background(), replacement)
  await Bun.sleep(20)
  expect(notifications).toEqual([initial])
  await subject.deregister(background(), replacement)
  expect(zookeeper.activeSessions()).toBe(0)
})

test("registration queued behind an authentication terminal remains owned", async () => {
  const zookeeper = fakeZookeeper()
  const notifications: ServiceInstance[] = []
  const subject = newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: zookeeper.factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100,
    onRegistrationError(_error, service): void {
      notifications.push(service)
    }
  })
  const initial = fixture("initial", "queued-authentication-terminal")
  const replacement = fixture("updated", initial.name)
  await subject.register(background(), initial)

  zookeeper.emitAuthenticationFailure()
  const registering = subject.register(background(), replacement)
  await eventually(function notified(): void {
    expect(notifications).toEqual([initial])
  })
  await registering
  expect(await subject.getService(background(), replacement.name)).toEqual([replacement])

  await subject.deregister(background(), replacement)
  expect(zookeeper.activeSessions()).toBe(0)
  zookeeper.expireSessions()
  await Bun.sleep(20)
  expect(await subject.getService(background(), replacement.name)).toEqual([])
})

test("stale queued registration recovery retires without replacing the current generation", async () => {
  const zookeeper = fakeZookeeper()
  const subject = registry(zookeeper)
  const initial = fixture("initial", "stale-registration-recovery")
  const updated = fixture("updated", initial.name)
  await subject.register(background(), initial)
  zookeeper.holdMutationResult()
  const replacing = subject.register(background(), updated)
  await eventually(async function committed(): Promise<void> {
    expect(await subject.getService(background(), initial.name)).toEqual([updated])
  })
  zookeeper.expireSessions()
  await Bun.sleep(1)
  zookeeper.releaseMutationResult()
  await expect(replacing).rejects.toBeInstanceOf(AggregateError)
  await eventually(async function restored(): Promise<void> {
    expect(await subject.getService(background(), initial.name)).toEqual([initial])
  })
  await subject.deregister(background(), initial)
})

test("registration failures close unused sessions and preserve prior records", async () => {
  const connectFailure = fakeZookeeper()
  connectFailure.failNext("connect", -102)
  connectFailure.failNext("close", -4)
  await expect(
    registry(connectFailure).register(background(), fixture("initial", "connect-failure"))
  ).rejects.toMatchObject({ nativeCode: -102, operation: "connect" })
  expect(connectFailure.activeSessions()).toBe(0)

  const unused = fakeZookeeper()
  unused.failNext("mkdirp", -102)
  await expect(
    registry(unused).register(background(), fixture("initial", "unused-session"))
  ).rejects.toMatchObject({ nativeCode: -102, operation: "mkdirp" })
  expect(unused.activeSessions()).toBe(0)

  const zookeeper = fakeZookeeper()
  const subject = registry(zookeeper)
  const initial = fixture("initial", "restore")
  const updated = fixture("updated", initial.name)
  await subject.register(background(), initial)
  zookeeper.failNext("mkdirp", -102)
  await expect(subject.register(background(), updated)).rejects.toMatchObject({
    nativeCode: -102,
    operation: "mkdirp"
  })
  expect(await subject.getService(background(), initial.name)).toEqual([initial])

  zookeeper.failNext("mkdirp", -102)
  zookeeper.failNext("mkdirp", -102)
  await expect(subject.register(background(), updated)).rejects.toMatchObject({
    nativeCode: -102,
    operation: "mkdirp"
  })
  expect(await subject.getService(background(), initial.name)).toEqual([initial])
  await subject.deregister(background(), initial)
})

test("registration readback mismatch rolls back or reports an aggregate rollback failure", async () => {
  const rollback = fakeZookeeper()
  const initial = fixture("initial", "readback-rollback")
  const mismatch = fixture("updated", initial.name)
  await expect(
    mismatchedReadbackRegistry(rollback, mismatch, false).register(background(), initial)
  ).rejects.toThrow("readback differs")
  expect(rollback.activeSessions()).toBe(0)
  expect(rollback.paths()).not.toContain(
    instancePath("/go-like/registry/v1", initial.name, initial.id)
  )

  const failedRollback = fakeZookeeper()
  failedRollback.failNext("close", -4)
  await expect(
    mismatchedReadbackRegistry(failedRollback, mismatch, true).register(background(), initial)
  ).rejects.toBeInstanceOf(AggregateError)
  failedRollback.expireSessions()
})

test("deregistration preserves native failures and remains retryable", async () => {
  const zookeeper = fakeZookeeper()
  const subject = registry(zookeeper)
  const value = fixture("initial", "deregister-failure")
  await subject.register(background(), value)
  zookeeper.failNext("remove", -102)
  await expect(subject.deregister(background(), value)).rejects.toMatchObject({
    nativeCode: -102,
    operation: "remove"
  })
  expect(await subject.getService(background(), value.name)).toEqual([value])
  await subject.deregister(background(), value)
})
