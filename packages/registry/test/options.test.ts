import { describe, expect, test } from "bun:test"

import {
  notifyRegistrationError,
  providerOptions,
  type ProviderLogger,
  type RegistrationErrorHandler
} from "../src/provider"
import type { ServiceInstance } from "../src/types"

describe("Registry provider options", () => {
  test("publishes exact frozen implementation defaults", () => {
    const options = providerOptions({})
    expect(options).toEqual({ logger: null, onRegistrationError: null, timeoutMs: 5_000 })
    expect(Object.isFrozen(options)).toBe(true)
  })

  test("captures provider constructor controls without mutating input", () => {
    const sink: ProviderLogger = { log() {} }
    const handler: RegistrationErrorHandler = function observe(): void {}
    const input = { logger: sink, onRegistrationError: handler, timeoutMs: 2_000 }
    expect(providerOptions(input)).toEqual(input)
    expect(input).toEqual({ logger: sink, onRegistrationError: handler, timeoutMs: 2_000 })
  })

  test("rejects malformed implementation controls", () => {
    const invalidCalls: readonly (() => unknown)[] = [
      () => providerOptions(null as never),
      () => providerOptions({ logger: { log: 1 } as never }),
      () => providerOptions({ onRegistrationError: 1 as never }),
      () => providerOptions({ timeoutMs: 0 }),
      () => providerOptions({ timeoutMs: 2_147_483_648 })
    ]
    for (const invoke of invalidCalls) expect(invoke).toThrow()
  })

  test("notifies with a defensive service snapshot and isolates observer failures", async () => {
    const service: ServiceInstance = {
      id: "catalog-1",
      name: "catalog",
      version: "v1",
      metadata: { zone: "a" },
      endpoints: ["http://127.0.0.1:8080/"]
    }
    const failure = new Error("registration failed")
    const observed: ServiceInstance[] = []
    notifyRegistrationError(
      function rejecting(error, snapshot): Promise<void> {
        expect(error).toBe(failure)
        observed.push(snapshot)
        return Promise.reject(new Error("observer rejected"))
      },
      failure,
      service
    )
    expect(() =>
      notifyRegistrationError(
        function throwing(): void {
          throw new Error("observer threw")
        },
        failure,
        service
      )
    ).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(observed).toEqual([service])
    expect(observed[0]).not.toBe(service)
    expect(Object.isFrozen(observed[0])).toBe(true)
    expect(Object.isFrozen(observed[0]?.metadata)).toBe(true)
    expect(Object.isFrozen(observed[0]?.endpoints)).toBe(true)
  })
})
