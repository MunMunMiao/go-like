import { describe, expect, test } from "bun:test"

import { background } from "@likego/context"
import type { ConfigSource } from "../src/index"
import {
  newConfig,
  objectSource,
  onReloadError,
  schema as configSchema,
  source as configSource
} from "../src/index"
import { invalidDocument, readConfig } from "./helpers"

describe("config construction and value admission", () => {
  test("accepts no sources and rejects duplicate, malformed, and mutable-capability shapes", async () => {
    const empty = newConfig()
    await empty.load(background())
    expect(await readConfig(empty)).toEqual({})
    await empty.close(background())
    expect(() =>
      newConfig(configSource(objectSource("same", {}), objectSource("same", {})))
    ).toThrow(TypeError)
    expect(() => newConfig(JSON.parse('[{"name":"missing-load"}]'))).toThrow(TypeError)
    expect(() => newConfig(JSON.parse('[{"name":"x","watch":1}]'))).toThrow(TypeError)
    expect(() => newConfig(JSON.parse('[{"name":"","load":1}]'))).toThrow(TypeError)
    expect(() => newConfig(JSON.parse("[null]"))).toThrow(TypeError)
    expect(() => configSource(JSON.parse("null"))).toThrow(TypeError)
  })

  test("snapshots source capabilities and the source list at construction", async () => {
    let loads = 0
    const source = {
      name: "stable",
      /** Returns the originally captured source result. */
      load() {
        loads += 1
        return Promise.resolve({ value: { captured: true }, revision: "one" })
      }
    }
    const list: ConfigSource[] = [source]
    const config = newConfig(configSource(...list))
    source.name = "changed"
    source.load = function replacementLoad() {
      return Promise.resolve({ value: { captured: false }, revision: "two" })
    }
    list.length = 0

    await config.load(background())
    expect(loads).toBe(1)
    expect(await readConfig(config)).toEqual({ captured: true })
    await config.close(background())
  })

  test("uses the last source functional option like Kratos WithSource", async () => {
    let ignoredLoads = 0
    const config = newConfig(
      configSource({
        name: "ignored",
        async load() {
          ignoredLoads += 1
          return { value: { selected: "ignored" }, revision: null }
        }
      }),
      configSource(objectSource("selected", { selected: "last" }))
    )

    await config.load(background())
    expect(ignoredLoads).toBe(0)
    expect(config.value("selected").load()).toBe("last")
    await config.close(background())
  })

  test("captures Standard Schema properties exactly once without validating", () => {
    let standardReads = 0
    let versionReads = 0
    let vendorReads = 0
    let validateReads = 0
    let validations = 0
    const props = Object.create(null)
    Object.defineProperties(props, {
      version: {
        get() {
          versionReads += 1
          return 1
        }
      },
      vendor: {
        get() {
          vendorReads += 1
          return "fixture"
        }
      },
      validate: {
        get() {
          validateReads += 1
          return function validate() {
            validations += 1
            return { value: {} }
          }
        }
      }
    })
    const schema = Object.create(null)
    Object.defineProperty(schema, "~standard", {
      get() {
        standardReads += 1
        return props
      }
    })

    newConfig(configSource(objectSource("one", {})), configSchema(schema))

    expect({ standardReads, versionReads, vendorReads, validateReads, validations }).toEqual({
      standardReads: 1,
      versionReads: 1,
      vendorReads: 1,
      validateReads: 1,
      validations: 0
    })
  })

  test("turns throwing or malformed schema and hook shapes into secret-safe TypeErrors", () => {
    const throwing = Object.create(null)
    Object.defineProperty(throwing, "~standard", {
      get() {
        throw new Error("secret schema")
      }
    })
    const malformed = JSON.parse('{"~standard":{"version":2,"vendor":"","validate":1}}')
    for (const run of [
      () => configSchema(throwing),
      () => configSchema(malformed),
      () => onReloadError(JSON.parse("1")),
      () => newConfig(JSON.parse("1"))
    ]) {
      try {
        run()
        throw new Error("construction unexpectedly succeeded")
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError)
        expect(String(error)).not.toContain("secret schema")
      }
    }
  })

  test("objectSource isolates caller mutation and returns one deeply frozen stable value", async () => {
    const original = { nested: { enabled: true }, values: [1, 2] }
    const source = objectSource("memory", original)
    original.nested.enabled = false
    original.values.push(3)

    const first = await source.load(background())
    const second = await source.load(background())
    expect(first).toBe(second)
    expect(first.value).toEqual({ nested: { enabled: true }, values: [1, 2] })
    expect(Object.isFrozen(first.value)).toBe(true)
    expect(Object.isFrozen(first.value.nested)).toBe(true)
    expect(Object.isFrozen(first.value.values)).toBe(true)
  })

  test("rejects every non-JSON-like value class and non-finite number", () => {
    const custom = Object.create({ inherited: true })
    const typed = new Uint8Array([1])
    const sparse = new Array(1)
    const symbolArray = [1]
    Object.defineProperty(symbolArray, Symbol("hidden"), { value: true })
    const hiddenIndex = new Proxy([1], {
      getOwnPropertyDescriptor(target, property) {
        if (property === "0") return undefined
        return Object.getOwnPropertyDescriptor(target, property)
      }
    })
    const values: unknown[] = [
      undefined,
      1n,
      Symbol("x"),
      function invalidFunction() {},
      new Date(),
      new Map(),
      new Set(),
      typed,
      custom,
      sparse,
      symbolArray,
      hiddenIndex,
      Number.NaN,
      Number.POSITIVE_INFINITY
    ]
    for (const value of values)
      expect(() => objectSource("invalid", invalidDocument(value))).toThrow(TypeError)
  })

  test("rejects accessors without invoking them, symbols, cycles, and unsafe keys at depth", () => {
    let getterCalls = 0
    const accessor = Object.create(null)
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1
        return "do-not-read"
      }
    })
    const symbolKey = { safe: true }
    Object.defineProperty(symbolKey, Symbol("hidden"), { value: 1 })
    const cyclic = Object.create(null)
    cyclic.self = cyclic
    const unsafe = Object.create(null)
    Object.defineProperty(unsafe, "constructor", { enumerable: true, value: { secret: true } })

    for (const value of [accessor, symbolKey, cyclic, unsafe]) {
      expect(() => objectSource("invalid", invalidDocument(value))).toThrow(TypeError)
    }
    expect(getterCalls).toBe(0)
  })

  test("rejects an empty object-source name", () => {
    expect(() => objectSource("", {})).toThrow(TypeError)
  })
})
