import { expect, test } from "bun:test"

import { validateConsulScenarioEvidence } from "./integration/consul-evidence"

test("real Docker round-trip evidence rejects a missing operation result", () => {
  const evidence = {
    registerReturnedVoid: true,
    discoveredExact: true,
    deterministicRemoteId: true,
    deregisterReturnedVoid: true
  }
  expect(validateConsulScenarioEvidence("service-instance-roundtrip", evidence)).toBe(true)
  expect(
    validateConsulScenarioEvidence("service-instance-roundtrip", {
      ...evidence,
      registerReturnedVoid: false
    })
  ).toBe(false)
})

test("real Docker watcher evidence requires complete replacement snapshots", () => {
  expect(
    validateConsulScenarioEvidence("replacement-snapshot-watch", {
      initialSnapshot: 1,
      updatedSnapshot: 1,
      emptySnapshot: 0,
      watcherSurfaceExact: true
    })
  ).toBe(true)
  expect(
    validateConsulScenarioEvidence("replacement-snapshot-watch", {
      initialSnapshot: 1,
      updatedSnapshot: 1,
      emptySnapshot: 1,
      watcherSurfaceExact: true
    })
  ).toBe(false)
})

test("real Docker TTL evidence requires repeated private heartbeats", () => {
  expect(
    validateConsulScenarioEvidence("private-ttl-heartbeat", {
      heartbeatPasses: 2,
      publicHandleExposed: false
    })
  ).toBe(true)
})
