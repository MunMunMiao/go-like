import { expect, test } from "bun:test"

import * as Registry from "../src/index"
import * as RegistryProvider from "../src/provider"
import * as InternalRegistryTesting from "../src/testing"

test("root exports the exact Registry contract and portable helpers", () => {
  expect(Object.keys(Registry).sort()).toEqual([
    "filterLabel",
    "filterVersion",
    "newEWMASelector",
    "newNoAvailableEndpointError",
    "newP2CSelector",
    "newRandomSelector",
    "newRoundRobinSelector",
    "newWeightedRoundRobinSelector"
  ])
})

test("provider subpath exports only implementation-author helpers", () => {
  expect(Object.keys(RegistryProvider).sort()).toEqual([
    "newRegistryProtocolError",
    "newRegistryStateError",
    "newUnsupportedRegistryCapabilityError",
    "newWatcherOverflowError",
    "newWatcherStoppedError",
    "notifyRegistrationError",
    "providerOptions",
    "snapshotServiceInstance",
    "snapshotServiceInstances"
  ])
})

test("internal conformance module exports only the shared provider test inventory", () => {
  expect(Object.keys(InternalRegistryTesting).sort()).toEqual(["registryConformanceCases"])
})
