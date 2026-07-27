import { describe, expect, test } from "bun:test"

import { background } from "@likego/context"
import { envSource } from "../src/env"

describe("environment configuration source", () => {
  test("selects one application prefix and builds nested lower-case string configuration", async () => {
    const source = envSource(
      {
        APP_HTTP__HOST: "127.0.0.1",
        APP_HTTP__PORT: "8080",
        APP_FEATURES__AUDIT: "true",
        OTHER_HTTP__PORT: "9000",
        APP_UNDEFINED: undefined
      },
      { prefix: "APP_" }
    )

    expect(await source.load(background())).toEqual({
      value: {
        features: { audit: "true" },
        http: { host: "127.0.0.1", port: "8080" }
      },
      revision: null
    })
    expect(source.name).toBe("env")
    expect(source.watch).toBeUndefined()
  })

  test("supports explicit naming, separator, key casing, and value decoding", async () => {
    const source = envSource(
      { SERVICE_DB_PORT: "5432", SERVICE_DB_TLS: "true" },
      {
        name: "service-env",
        prefix: "SERVICE_",
        separator: "_",
        lowercase: false,
        /** Decodes the two known deployment values without implicit adapter magic. */
        decode(value, environmentName) {
          return environmentName.endsWith("PORT") ? Number(value) : value === "true"
        }
      }
    )

    expect(await source.load(background())).toEqual({
      value: { DB: { PORT: 5432, TLS: true } },
      revision: null
    })
    expect(source.name).toBe("service-env")
  })

  test("captures the record and decoded objects without retaining caller mutation", async () => {
    const environment: Record<string, string | undefined> = { APP_PAYLOAD: "ignored" }
    const decoded = { nested: { enabled: true } }
    const source = envSource(environment, {
      prefix: "APP_",
      /** Supplies an object to prove construction-time ownership isolation. */
      decode() {
        return decoded
      }
    })
    environment.APP_PAYLOAD = "changed"
    decoded.nested.enabled = false

    const first = await source.load(background())
    const second = await source.load(background())
    expect(first).toEqual({ value: { payload: { nested: { enabled: true } } }, revision: null })
    expect(second).toBe(first)
    expect(Object.isFrozen(first.value)).toBe(true)
  })

  test("rejects ambiguous, unsafe, and malformed environment mappings", () => {
    expect(() =>
      envSource({ APP_HTTP: "scalar", APP_HTTP__PORT: "8080" }, { prefix: "APP_" })
    ).toThrow("environment paths conflict")
    expect(() =>
      envSource({ APP_HTTP__PORT: "8080", APP_http__port: "9000" }, { prefix: "APP_" })
    ).toThrow("duplicate environment path")
    expect(() => envSource({ APP___PROTO__: "bad" }, { prefix: "APP_", separator: "." })).toThrow(
      "unsafe environment path"
    )
    expect(() => envSource({ APP_HTTP____PORT: "bad" }, { prefix: "APP_" })).toThrow(
      "environment key contains an empty path segment"
    )
  })

  test("rejects invalid options and decoder output through the config value boundary", () => {
    expect(() => envSource({}, { name: "" })).toThrow("environment source name")
    expect(() => envSource({}, { separator: "" })).toThrow("environment separator")
    expect(() =>
      envSource(
        { VALUE: "bad" },
        {
          /** Deliberately returns an accessor object at the runtime callback boundary. */
          decode() {
            return Object.defineProperty({}, "nested", {
              enumerable: true,
              get() {
                return "bad"
              }
            })
          }
        }
      )
    ).toThrow("invalid environment value")
  })

  test("accepts the full immutable value domain and rejects unsafe callback graphs", async () => {
    const source = envSource(
      { APP_VALUE: "composite" },
      {
        prefix: "APP_",
        /** Supplies the complete scalar, array, and object value domain. */
        decode() {
          return [null, true, 7, "text", { nested: [] }]
        }
      }
    )
    expect(await source.load(background())).toEqual({
      value: { value: [null, true, 7, "text", { nested: [] }] },
      revision: null
    })

    const sparse: import("@likego/config").ConfigValue[] = []
    sparse.length = 1
    expect(() =>
      envSource(
        { VALUE: "sparse" },
        {
          decode() {
            return sparse
          }
        }
      )
    ).toThrow("invalid environment value")
    const cyclic: import("@likego/config").ConfigValue[] = []
    cyclic.push(cyclic)
    expect(() =>
      envSource(
        { VALUE: "cyclic" },
        {
          decode() {
            return cyclic
          }
        }
      )
    ).toThrow("cyclic environment value")
    expect(() =>
      envSource(
        { VALUE: "nan" },
        {
          decode() {
            return Number.NaN
          }
        }
      )
    ).toThrow("invalid environment value")
    expect(() =>
      envSource(
        { VALUE: "prototype" },
        {
          /** Returns a non-plain object across the callback boundary. */
          decode() {
            return Object.setPrototypeOf({}, { inherited: true })
          }
        }
      )
    ).toThrow("invalid environment value")
    expect(() =>
      envSource(
        { VALUE: "unsafe" },
        {
          /** Returns a plain object with one unsafe own key. */
          decode() {
            return Object.defineProperty({}, "__proto__", { enumerable: true, value: "bad" })
          }
        }
      )
    ).toThrow("unsafe environment value key")
    const decoratedArray: import("@likego/config").ConfigValue[] = []
    Object.defineProperty(decoratedArray, "extra", { enumerable: true, value: "bad" })
    expect(() =>
      envSource(
        { VALUE: "decorated-array" },
        {
          decode() {
            return decoratedArray
          }
        }
      )
    ).toThrow("invalid environment value")
    const accessorArray: import("@likego/config").ConfigValue[] = ["placeholder"]
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        return "bad"
      }
    })
    expect(() =>
      envSource(
        { VALUE: "accessor-array" },
        {
          decode() {
            return accessorArray
          }
        }
      )
    ).toThrow("invalid environment value")
    expect(() =>
      envSource(
        { VALUE: "symbol" },
        {
          /** Returns an object with unsupported symbol state. */
          decode() {
            return Object.defineProperty({}, Symbol("secret"), { enumerable: true, value: "bad" })
          }
        }
      )
    ).toThrow("invalid environment value")
    expect(() =>
      envSource(
        { VALUE: "hidden" },
        {
          /** Returns an object with a hidden property that must not be silently dropped. */
          decode() {
            return Object.defineProperty({}, "hidden", { enumerable: false, value: "bad" })
          }
        }
      )
    ).toThrow("invalid environment value")
    expect(() => envSource(JSON.parse("null"))).toThrow("environment record")
  })

  test("rejects malformed runtime options instead of reading ambient defaults", () => {
    expect(() => envSource({}, { prefix: JSON.parse("1") })).toThrow("prefix")
    expect(() => envSource({}, { lowercase: JSON.parse('"yes"') })).toThrow("lowercase")
    expect(() => envSource({}, { decode: JSON.parse('"no"') })).toThrow("decoder")
    const accessorEnvironment = Object.defineProperty({}, "VALUE", {
      enumerable: true,
      get() {
        return "hidden"
      }
    })
    expect(() => envSource(accessorEnvironment)).toThrow("data properties")
  })
})
