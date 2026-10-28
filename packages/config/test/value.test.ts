import { describe, expect, test } from "bun:test"

import { background, withCancelCause } from "@go-like/context"
import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { ConfigObject, ConfigValue } from "../src/index"
import { newConfig, source, objectSource } from "../src/index"
import { isConfigObject } from "../src/value"
import { deferred, flush } from "./helpers"

type ValueSchema<T extends ConfigValue> = StandardSchemaV1<ConfigValue, T>

/** Validates one numeric configuration value. */
function numberSchema(): ValueSchema<number> {
  return {
    "~standard": {
      version: 1,
      vendor: "value-test-number",
      validate(value) {
        return typeof value === "number" ? { value } : { issues: [{ message: "number required" }] }
      }
    }
  }
}

describe("Kratos-style config values", () => {
  test("scans the complete current configuration through Standard Schema", async () => {
    const config = newConfig(source(objectSource("one", { service: { port: 8080 } })))
    const schema = {
      "~standard": {
        version: 1,
        vendor: "root-scan",
        validate(value: unknown) {
          if (!isConfigObject(value)) return { issues: [{ message: "object required" }] }
          const service = value.service
          return {
            value: {
              ready: isConfigObject(service) && service.port === 8080
            }
          }
        }
      }
    } satisfies StandardSchemaV1<ConfigObject, { readonly ready: boolean }>

    await expect(config.scan(background(), schema)).rejects.toMatchObject({
      name: "ConfigNotFoundError",
      code: "GO_LIKE_CONFIG_NOT_FOUND",
      key: ""
    })
    await config.load(background())
    await expect(config.scan(background(), schema)).resolves.toEqual({ ready: true })
  })

  test("returns one cached live Value for a dotted path", async () => {
    const config = newConfig(
      source(
        objectSource("one", {
          service: { port: 8080, nested: { enabled: true } },
          list: [{ port: 9000 }]
        })
      )
    )
    const port = config.value("service.port")
    expect(port).toBe(config.value("service.port"))
    expect(port.load()).toBeNull()

    await config.load(background())
    expect(port.load()).toBe(8080)
    expect(config.value("service.nested").load()).toEqual({ enabled: true })
    expect(Object.isFrozen(config.value("service.nested").load())).toBe(true)
    expect(config.value("list.0").load()).toBeNull()
    await expect(port.scan(background(), numberSchema())).resolves.toBe(8080)
  })

  test("uses dotted Kratos paths and rejects malformed or unsafe keys", async () => {
    const config = newConfig(
      source(
        objectSource("one", {
          a: { b: 1 },
          "a.b": 2,
          emoji: { "😀": 3 }
        })
      )
    )
    await config.load(background())

    expect(config.value("a.b").load()).toBe(1)
    expect(config.value("emoji.😀").load()).toBe(3)
    for (const key of ["", ".a", "a.", "a..b", "__proto__", "a.constructor", "\ud800", "\udc00"]) {
      expect(() => config.value(key)).toThrow(TypeError)
    }
    expect(() => Reflect.apply(config.value, config, [null])).toThrow(TypeError)
  })

  test("classifies missing and invalid scans without a separate key DSL", async () => {
    const config = newConfig(source(objectSource("one", { service: { port: "wrong" } })))
    await config.load(background())

    const missing = config.value("service.missing")
    expect(missing.load()).toBeNull()
    await expect(missing.scan(background(), numberSchema())).rejects.toMatchObject({
      name: "ConfigNotFoundError",
      code: "GO_LIKE_CONFIG_NOT_FOUND",
      key: "service.missing"
    })
    await expect(
      config.value("service.port").scan(background(), numberSchema())
    ).rejects.toMatchObject({
      name: "ConfigValidationError",
      code: "GO_LIKE_CONFIG_VALIDATION",
      reason: "issues"
    })
  })

  test("honors Context cancellation before and during asynchronous scans", async () => {
    const config = newConfig(source(objectSource("one", { value: 1 })))
    await config.load(background())
    const before = new Error("canceled before scan")
    const [beforeContext, cancelBefore] = withCancelCause(background())
    cancelBefore(before)
    await expect(config.value("value").scan(beforeContext, numberSchema())).rejects.toBe(before)

    const validation = deferred<StandardSchemaV1.Result<number>>()
    const schema: ValueSchema<number> = {
      "~standard": {
        version: 1,
        vendor: "delayed-value",
        validate() {
          return validation.promise
        }
      }
    }
    const during = new Error("canceled during scan")
    const [duringContext, cancelDuring] = withCancelCause(background())
    const pending = config.value("value").scan(duringContext, schema)
    await flush()
    cancelDuring(during)
    await expect(pending).rejects.toBe(during)
    validation.resolve({ value: 1 })
    await flush()
  })

  test("rejects malformed scan schemas through the existing validation boundary", async () => {
    const config = newConfig(source(objectSource("one", { value: 1 })))
    await config.load(background())
    const malformed = JSON.parse('{"~standard":{"version":2}}')

    await expect(config.scan(background(), malformed)).rejects.toBeInstanceOf(TypeError)
    await expect(config.value("value").scan(background(), malformed)).rejects.toBeInstanceOf(
      TypeError
    )
  })
})
