import { expect, test } from "bun:test"

import { background, withCancel } from "../../src/context"
import { snapshotServiceInstance } from "../../src/registry/snapshot"
import { newIdentityLocks, startHeartbeat } from "../../src/registry/provider"
import { LogEvent, LogField, withTelemetry } from "../../src/telemetry"
import { newTelemetryRecorder } from "../../src/testing"

const instance = snapshotServiceInstance({
  id: "catalog-1",
  name: "catalog",
  version: "1",
  metadata: {},
  endpoints: ["http://127.0.0.1:1/"]
})

test("a retryable heartbeat failure produces a record and a later success continues", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  let calls = 0
  const heartbeat = startHeartbeat(ctx, {
    instance,
    identity: "catalog-1",
    locks: newIdentityLocks(),
    intervalMs: 5,
    retryInitialMs: 1,
    retryMaximumMs: 5,
    retryable: () => true,
    message: "registry heartbeat failed",
    onRegistrationError: null,
    async renew(): Promise<void> {
      calls += 1
      if (calls === 1) throw new Error("secret-backend-detail")
    },
    lost(): void {
      throw new Error("lost must not run")
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await heartbeat.stop(background())
  const logged = recorder
    .logs()
    .filter((item) => item.record.event === LogEvent.registryHeartbeatFailed)
  expect(logged.length).toBeGreaterThan(0)
  expect(logged[0]?.record.message).toBe("registry heartbeat failed")
  expect(logged[0]?.record.message.includes("secret-backend-detail")).toBe(false)
  const exception = logged[0]?.record.attrs[LogField.exception]
  expect(exception).toBeInstanceOf(Error)
  expect(calls).toBeGreaterThan(1)
})

test("a non-retryable heartbeat failure notifies lost and stops", async () => {
  const seen: Error[] = []
  const heartbeat = startHeartbeat(background(), {
    instance,
    identity: "catalog-1",
    locks: newIdentityLocks(),
    intervalMs: 20,
    retryInitialMs: 1,
    retryMaximumMs: 5,
    retryable: () => false,
    message: "registry heartbeat failed",
    onRegistrationError(error): void {
      seen.push(error)
    },
    renew(): Promise<void> {
      return Promise.reject(new Error("terminal"))
    },
    lost(error): void {
      seen.push(error)
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await heartbeat.stop(background())
  expect(seen.map((error) => error.message)).toEqual(["terminal", "terminal"])
})

test("rejects invalid heartbeat options and a canceled register context", () => {
  const locks = newIdentityLocks()
  const base = {
    instance,
    identity: "catalog-1",
    locks,
    intervalMs: 1,
    retryInitialMs: 1,
    retryMaximumMs: 1,
    retryable: () => true,
    message: "registry heartbeat failed",
    onRegistrationError: null,
    renew: () => Promise.resolve(),
    lost: () => {}
  }
  expect(() => startHeartbeat(background(), { ...base, retryMaximumMs: 0 })).toThrow(RangeError)
  expect(() => startHeartbeat(background(), { ...base, identity: "" })).toThrow(TypeError)
  expect(() => startHeartbeat(background(), { ...base, renew: null as never })).toThrow(TypeError)
  expect(() => startHeartbeat(background(), { ...base, lost: null as never })).toThrow(TypeError)
  expect(() => startHeartbeat(background(), { ...base, message: "" })).toThrow(TypeError)
  expect(() => startHeartbeat(background(), { ...base, locks: null as never })).toThrow(TypeError)
  expect(() => startHeartbeat(background(), { ...base, intervalMs: -1 })).toThrow(RangeError)
  const [ctx, cancel] = withCancel(background())
  cancel()
  expect(() => startHeartbeat(ctx, base)).toThrow()
})

test("a lock rejection, a throwing lost callback, and a non-Error renewal all leave the loop", async () => {
  const rejected = startHeartbeat(background(), {
    instance,
    identity: "catalog-1",
    locks: { acquire: () => Promise.reject(new Error("locked")), size: () => 0 },
    intervalMs: 1,
    retryInitialMs: 1,
    retryMaximumMs: 1,
    retryable: () => false,
    message: "registry heartbeat failed",
    onRegistrationError: null,
    renew: () => Promise.resolve(),
    lost: () => {}
  })
  await rejected.stop(background())

  const seen: unknown[] = []
  const throwing = startHeartbeat(background(), {
    instance,
    identity: "catalog-1",
    locks: newIdentityLocks(),
    intervalMs: 5,
    retryInitialMs: 1,
    retryMaximumMs: 1,
    retryable: () => false,
    message: "registry heartbeat failed",
    onRegistrationError: null,
    renew: () => Promise.reject("nope"),
    lost(): void {
      seen.push("lost")
      throw new Error("lost failed")
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await throwing.stop(background())
  expect(seen).toEqual(["lost"])
})
