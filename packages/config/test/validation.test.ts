import { describe, expect, test } from "bun:test"

import { background, withCancelCause } from "@go-like/context"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ConfigObject, ConfigSchema, ConfigValue } from "../src/index"
import { newConfig, objectSource, schema as configSchema, source } from "../src/index"
import { deferred, flush, invalidDocument } from "./helpers"

/** Builds a runtime Standard Schema around a deliberately broad fixture validator. */
function runtimeSchema(validate: (value: ConfigObject) => unknown): ConfigSchema<ConfigValue> {
  const schema = JSON.parse('{"~standard":{"version":1,"vendor":"fixture"}}')
  schema["~standard"].validate = validate
  return schema
}

describe("Standard Schema validation", () => {
  test("supports sync transformed output and preserves the captured callable receiver", async () => {
    const props: StandardSchemaV1.Props<ConfigObject, { readonly receiver: string }> = {
      version: 1,
      vendor: "captured-vendor",
      /** Uses its Standard Schema receiver to prove call binding. */
      validate() {
        return { value: { receiver: this.vendor } }
      }
    }
    const schema = { "~standard": props }
    const config = newConfig(source(objectSource("one", { value: 1 })), configSchema(schema))
    schema["~standard"] = {
      version: 1,
      vendor: "replacement",
      /** Would expose a later replacement if capture were not stable. */
      validate() {
        return { value: { receiver: "wrong" } }
      }
    }
    Object.defineProperty(props, "validate", {
      value: function replacementValidate() {
        return { value: { receiver: "also-wrong" } }
      }
    })

    await config.load(background())
    const receiver = config.value("receiver").load()
    expect(receiver).toBe("captured-vendor")
    await config.close(background())
  })

  test("supports asynchronous successful output and deeply isolates later validator mutation", async () => {
    const output = { nested: { ready: true } }
    const schema = runtimeSchema(async function validateAsync() {
      return { value: output }
    })
    const config = newConfig(source(objectSource("one", {})), configSchema(schema))
    await config.load(background())
    output.nested.ready = false
    const nested = config.value("nested").load()
    expect(nested).toEqual({ ready: true })
    expect(Object.isFrozen(nested)).toBe(true)
    await config.close(background())
  })

  test("replaces vendor issues with only fixed frozen framework-owned messages", async () => {
    const vendorIssue = { message: "token=secret", path: ["secret-value"] }
    const schema = runtimeSchema(function invalid() {
      return { issues: [vendorIssue, vendorIssue] }
    })
    const config = newConfig(source(objectSource("one", { token: "secret" })), configSchema(schema))
    const failure = await config.load(background()).catch((error: unknown) => error)
    if (!(failure instanceof Error)) throw new Error("expected validation Error")

    expect(failure).toMatchObject({
      name: "ConfigValidationError",
      code: "GO_LIKE_CONFIG_VALIDATION",
      reason: "issues",
      issues: [
        { message: "configuration validation failed" },
        { message: "configuration validation failed" }
      ]
    })
    expect(JSON.stringify(failure)).not.toContain("secret")
    expect(Object.isFrozen(failure)).toBe(true)
    const details = Object.fromEntries(Object.entries(failure))
    const issues = details.issues
    if (!Array.isArray(issues)) throw new Error("expected sanitized issue list")
    expect(Object.isFrozen(issues)).toBe(true)
    expect(issues.every(Object.isFrozen)).toBe(true)
  })

  test("distinguishes thrown and rejected validators while preserving Error identity", async () => {
    const thrown = new Error("validator threw")
    const rejected = new Error("validator rejected")
    const cases = [
      runtimeSchema(function throwValidator() {
        throw thrown
      }),
      runtimeSchema(function rejectValidator() {
        return Promise.reject(rejected)
      })
    ]
    for (const [index, schema] of cases.entries()) {
      if (schema === undefined) throw new Error("missing schema fixture")
      const failure = await newConfig(source(objectSource("one", {})), configSchema(schema))
        .load(background())
        .catch((error: unknown) => error)
      if (!(failure instanceof Error)) throw new Error("expected validator Error")
      expect(failure).toMatchObject({ reason: "threw", issues: [] })
      expect(failure.cause).toBe(index === 0 ? thrown : rejected)
    }
  })

  test("classifies malformed results with fixed causes and no vendor result retention", async () => {
    const throwingResult = Object.create(null)
    Object.defineProperty(throwingResult, "issues", {
      get() {
        throw new Error("secret getter")
      }
    })
    const results: unknown[] = [null, {}, { issues: "wrong" }, throwingResult]
    for (const result of results) {
      const schema = runtimeSchema(function malformed() {
        return result
      })
      const failure = await newConfig(source(objectSource("one", {})), configSchema(schema))
        .load(background())
        .catch((error: unknown) => error)
      if (!(failure instanceof Error)) throw new Error("expected malformed-result Error")
      expect(failure).toMatchObject({
        reason: "malformed-result",
        issues: [],
        cause: expect.any(Error)
      })
      expect(String(failure)).not.toContain("secret getter")
    }
  })

  test("re-admits successful output and rejects every invalid JSON-like result", async () => {
    const cyclic = Object.create(null)
    cyclic.self = cyclic
    const invalidOutputs = [new Date(), invalidDocument(undefined), cyclic]
    for (const output of invalidOutputs) {
      const schema = runtimeSchema(function invalidOutput() {
        return { value: output }
      })
      const failure = await newConfig(source(objectSource("one", {})), configSchema(schema))
        .load(background())
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({
        reason: "invalid-output",
        issues: [],
        cause: expect.any(Error)
      })
    }
  })

  test("initial validation failure publishes no value", async () => {
    const schema = runtimeSchema(function invalid() {
      return { issues: [{ message: "bad" }] }
    })
    const config = newConfig(source(objectSource("one", { ready: true })), configSchema(schema))
    await expect(config.load(background())).rejects.toMatchObject({ reason: "issues" })
    expect(config.value("ready").load()).toBeNull()
  })

  test("cancellation during async validation prevents publication", async () => {
    const validation = deferred<unknown>()
    const schema = runtimeSchema(function delayedValidation() {
      return validation.promise
    })
    const config = newConfig(source(objectSource("one", { ready: true })), configSchema(schema))
    const cancellation = new Error("validation canceled")
    const [ctx, cancel] = withCancelCause(background())
    const first = config.load(ctx)
    await flush()
    cancel(cancellation)
    validation.resolve({ value: { stale: true } })
    await expect(first).rejects.toBe(cancellation)
    expect(config.value("stale").load()).toBeNull()
  })
})
