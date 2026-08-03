import { expect, test } from "bun:test"

import {
  newRegistryProtocolError,
  newRegistryStateError,
  newUnsupportedRegistryCapabilityError,
  newWatcherOverflowError,
  newWatcherStoppedError
} from "../src/provider"
import { newNoAvailableEndpointError } from "../src/index"
import { combineFailures, normalizeBoundaryError } from "../src/errors"

test("publishes stable immutable Registry error identities without classes", () => {
  const cause = new Error("wire cause")
  const errors = [
    newRegistryStateError("registry.init", "stopped"),
    newWatcherStoppedError(),
    newWatcherOverflowError(128),
    newRegistryProtocolError("invalid wire payload", cause),
    newUnsupportedRegistryCapabilityError("ttl", "provider minimum is 5000ms"),
    newNoAvailableEndpointError()
  ]
  expect(errors.map((error) => [error.name, error.code])).toEqual([
    ["RegistryStateError", "LIKEGO_REGISTRY_STATE"],
    ["WatcherStoppedError", "LIKEGO_WATCHER_STOPPED"],
    ["WatcherOverflowError", "LIKEGO_WATCHER_OVERFLOW"],
    ["RegistryProtocolError", "LIKEGO_REGISTRY_PROTOCOL"],
    ["UnsupportedRegistryCapabilityError", "LIKEGO_UNSUPPORTED_REGISTRY_CAPABILITY"],
    ["NoAvailableEndpointError", "LIKEGO_NO_AVAILABLE_ENDPOINT"]
  ])
  expect(errors.every(Object.isFrozen)).toBe(true)
  expect(errors.every((error) => error instanceof Error)).toBe(true)
  expect(errors[0]).toMatchObject({ operation: "registry.init", state: "stopped" })
  expect(errors[2]).toMatchObject({ bufferSize: 128 })
  expect(errors[3]?.cause).toBe(cause)
  expect(errors[4]).toMatchObject({ capability: "ttl" })
})

test("validates public error details before constructing a stable value", () => {
  expect(() => newRegistryStateError("", "running")).toThrow(TypeError)
  expect(() => newRegistryStateError("watch", "")).toThrow(TypeError)
  expect(() => newWatcherOverflowError(0)).toThrow(RangeError)
  expect(() => newRegistryProtocolError("")).toThrow(TypeError)
  expect(() => newUnsupportedRegistryCapabilityError("", "reason")).toThrow(TypeError)
  expect(() => newUnsupportedRegistryCapabilityError("ttl", "")).toThrow(TypeError)
})

test("preserves padded public error details without normalization", () => {
  expect(newRegistryStateError(" registry.watch ", " failed ")).toMatchObject({
    operation: " registry.watch ",
    state: " failed "
  })
  expect(newRegistryProtocolError(" protocol conflict ").message).toBe(" protocol conflict ")
  const unsupported = newUnsupportedRegistryCapabilityError(" ttl ", " provider bound ")
  expect(unsupported.capability).toBe(" ttl ")
  expect(unsupported.message).toBe("Registry capability  ttl  is unsupported:  provider bound ")
})

test("preserves one cleanup failure identity and aggregates independent failures in order", () => {
  const first = new Error("stop failed")
  const second = new Error("done failed")
  expect(combineFailures([first], "cleanup failed")).toBe(first)
  const aggregate = combineFailures([first, second], "cleanup failed")
  expect(aggregate).toBeInstanceOf(AggregateError)
  expect(aggregate.message).toBe("cleanup failed")
  expect((aggregate as AggregateError).errors).toEqual([first, second])
  expect(Object.isFrozen(aggregate)).toBe(true)
})

test("preserves Error boundary failures and normalizes non-Error rejections", () => {
  const failure = new Error("registry failed")
  expect(normalizeBoundaryError("Registry", failure)).toBe(failure)
  const normalized = normalizeBoundaryError("Registry", "failed")
  expect(normalized).toBeInstanceOf(Error)
  expect(normalized.message).toBe("Registry failed with a non-Error value")
  expect(Object.isFrozen(normalized)).toBe(true)
})
