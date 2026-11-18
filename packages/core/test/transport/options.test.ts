import { describe, expect, test } from "bun:test"

import type { DialOption, Option, TLSConfig } from "../../src/transport/types"
import * as OptionsModule from "../../src/transport/options"
import {
  reduceTestDialOptions,
  reduceTestListenOptions,
  reduceTestOptions
} from "./options-fixture"

const timeout: (timeoutMs: number) => Option = Reflect.get(OptionsModule, "timeout")
const secure: (enabled: boolean) => Option = Reflect.get(OptionsModule, "secure")
const tlsConfig: (value: TLSConfig | null) => Option = Reflect.get(OptionsModule, "tlsConfig")
const withTimeout: (timeoutMs: number) => DialOption = Reflect.get(OptionsModule, "withTimeout")
const withConnClose: () => DialOption = Reflect.get(OptionsModule, "withConnClose")

function optionsImplemented(): boolean {
  return [timeout, secure, tlsConfig, withTimeout, withConnClose].every(
    (value) => typeof value === "function"
  )
}

function requireOptionsImplementation(): boolean {
  const implemented = optionsImplemented()
  expect(implemented).toBe(true)
  return implemented
}

describe("transport options", () => {
  test("publishes the exact internal reducer implementation surface", () => {
    expect(Object.keys(OptionsModule).sort()).toEqual([
      "secure",
      "timeout",
      "tlsConfig",
      "withConnClose",
      "withTimeout"
    ])
  })

  test("freezes the reviewed common, dial, and listen defaults", () => {
    if (!requireOptionsImplementation()) return
    const common = reduceTestOptions()
    const dial = reduceTestDialOptions()
    const listen = reduceTestListenOptions()

    expect(common).toEqual({
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
    expect(dial).toEqual({
      timeoutMs: 5_000,
      connectionClose: false
    })
    expect(listen).toEqual({})
    expect(Object.isFrozen(common)).toBe(true)
    expect(Object.isFrozen(dial)).toBe(true)
    expect(Object.isFrozen(listen)).toBe(true)
  })

  test("applies immutable reducers in order with last option winning", () => {
    if (!requireOptionsImplementation()) return
    const defaults = reduceTestOptions()
    const reduced = reduceTestOptions(timeout(10), timeout(20), secure(true), secure(false))
    const dial = reduceTestDialOptions(withTimeout(10), withTimeout(25), withConnClose())

    expect(defaults).toEqual({
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
    expect(reduced).toMatchObject({
      timeoutMs: 20,
      secure: false
    })
    expect(dial).toEqual({
      timeoutMs: 25,
      connectionClose: true
    })
    expect(Object.isFrozen(reduced)).toBe(true)
  })

  test("rejects invalid millisecond durations", () => {
    if (!requireOptionsImplementation()) return
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => timeout(value)).toThrow(RangeError)
      expect(() => withTimeout(value)).toThrow(RangeError)
    }
  })

  test("rejects non-boolean public flag inputs", () => {
    if (!requireOptionsImplementation()) return
    expect(() => Reflect.apply(secure, undefined, ["yes"])).toThrow(TypeError)
  })

  test("defensively snapshots TLS material at application and readback", () => {
    if (!requireOptionsImplementation()) return
    const ca = new Uint8Array([1, 2, 3])
    const certificate = new Uint8Array([4, 5])
    const key = new Uint8Array([6, 7])
    const input: TLSConfig = {
      serverName: "service.internal",
      caCertificate: { encoding: "pem", bytes: ca },
      certificateChain: { encoding: "der", bytes: certificate },
      privateKey: { encoding: "pem", bytes: key }
    }
    const reduced = reduceTestOptions(tlsConfig(input))
    ca[0] = 99
    certificate[0] = 99
    key[0] = 99

    expect(reduced.tlsConfig?.caCertificate?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(reduced.tlsConfig?.certificateChain?.bytes).toEqual(new Uint8Array([4, 5]))
    expect(reduced.tlsConfig?.privateKey?.bytes).toEqual(new Uint8Array([6, 7]))
    const tlsSnapshot = reduced.tlsConfig
    if (tlsSnapshot === null) throw new Error("TLS snapshot is missing")
    const exposed = tlsSnapshot.caCertificate?.bytes
    if (exposed === undefined) throw new Error("TLS CA snapshot is missing")
    exposed[0] = 55
    expect(tlsSnapshot.caCertificate?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(Object.isFrozen(tlsSnapshot)).toBe(true)
    expect(Object.isFrozen(tlsSnapshot.caCertificate)).toBe(true)

    const cleared = reduceTestOptions(tlsConfig(input), tlsConfig(null))
    expect(cleared.tlsConfig).toBeNull()
  })

  test("rejects malformed structural TLS configuration before readback", () => {
    if (!requireOptionsImplementation()) return
    const invalidServerName = {
      serverName: 42,
      caCertificate: null,
      certificateChain: null,
      privateKey: null
    }
    const invalidEncoding = {
      serverName: null,
      caCertificate: { encoding: "raw", bytes: new Uint8Array([1]) },
      certificateChain: null,
      privateKey: null
    }
    const invalidBytes = { ...invalidEncoding, caCertificate: { encoding: "pem", bytes: [1] } }
    const bytesOption = Reflect.apply(tlsConfig, undefined, [invalidBytes])
    expect(() => reduceTestOptions(bytesOption)).toThrow("TLS material bytes must be a Uint8Array")
    const serverNameOption = Reflect.apply(tlsConfig, undefined, [invalidServerName])
    const encodingOption = Reflect.apply(tlsConfig, undefined, [invalidEncoding])

    expect(() => reduceTestOptions(serverNameOption)).toThrow(TypeError)
    expect(() => reduceTestOptions(encodingOption)).toThrow(TypeError)
  })
})
