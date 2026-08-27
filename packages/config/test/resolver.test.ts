import { describe, expect, test } from "bun:test"

import { background, withCancelCause } from "@go-like/context"
import type { ConfigObject, ConfigSourceSnapshot, ConfigValue } from "../src/index"
import {
  newConfig,
  objectSource,
  onReloadError,
  placeholderResolver,
  resolver,
  schema,
  source
} from "../src/index"
import { isConfigObject } from "../src/value"
import {
  controlledWatcher,
  deferred,
  flush,
  readConfig,
  startConfig,
  type Deferred
} from "./helpers"

describe("configuration resolvers", () => {
  test("runs ordered isolated resolvers after merge and before schema validation", async () => {
    const events: string[] = []
    const firstOutput = { stage: { value: "first" } }
    const secondOutput = { stage: { value: "second" } }
    let firstInput: ConfigObject | null = null
    let secondInput: ConfigObject | null = null
    const config = newConfig(
      source(
        objectSource("base", { service: { host: "base", tls: true } }),
        objectSource("override", { service: { host: "db" } })
      ),
      resolver(function first(_ctx, value) {
        events.push("first")
        firstInput = value
        expect(value).toEqual({ service: { host: "db", tls: true } })
        expect(Object.isFrozen(value)).toBe(true)
        expect(Object.isFrozen(value.service)).toBe(true)
        return firstOutput
      }),
      resolver(async function second(_ctx, value) {
        events.push("second")
        secondInput = value
        expect(value).toEqual({ stage: { value: "first" } })
        expect(value).not.toBe(firstOutput)
        expect(Object.isFrozen(value)).toBe(true)
        expect(Object.isFrozen(value.stage)).toBe(true)
        return secondOutput
      }),
      schema({
        "~standard": {
          version: 1,
          vendor: "resolver-order",
          validate(value: unknown) {
            events.push("schema")
            expect(value).toEqual({ stage: { value: "second" } })
            return isConfigObject(value)
              ? { value }
              : { issues: [{ message: "configuration object required" }] }
          }
        }
      })
    )

    await config.load(background())
    firstOutput.stage.value = "mutated"
    secondOutput.stage.value = "mutated"
    expect(firstInput).not.toBe(secondInput)
    expect(events).toEqual(["first", "second", "schema"])
    expect(config.value("stage.value").load()).toBe("second")
    await config.close(background())
  })

  test("rejects invalid resolver boundaries without retaining rejected values", async () => {
    expect(() => resolver(JSON.parse("1"))).toThrow(TypeError)
    const malformed = newConfig(
      source(objectSource("one", {})),
      resolver(function malformed() {
        return JSON.parse("[]")
      })
    )
    await expect(malformed.load(background())).rejects.toThrow(
      "invalid configuration resolver output"
    )

    const rejected = newConfig(
      source(objectSource("one", {})),
      resolver(function rejectSecret() {
        return Promise.reject({ token: "do-not-retain" })
      })
    )
    const failure = await rejected.load(background()).catch(function capture(error: unknown) {
      return error
    })
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain("do-not-retain")
    expect(JSON.stringify(failure)).not.toContain("do-not-retain")
  })

  test("uses the exact Context cancellation and ignores a late initial result", async () => {
    const pending = deferred<ConfigObject>()
    const cancellation = new Error("resolver canceled")
    const [ctx, cancel] = withCancelCause(background())
    const config = newConfig(
      source(objectSource("one", { ready: true })),
      resolver(function delayed() {
        return pending.promise
      })
    )

    const loading = config.load(ctx)
    await flush()
    cancel(cancellation)
    await expect(loading).rejects.toBe(cancellation)
    pending.resolve({ stale: true })
    await flush()
    expect(config.value("stale").load()).toBeNull()
  })

  test("cancels a background resolver without publishing its late result", async () => {
    const nextCalls: Deferred<void>[] = []
    const watcherDone = deferred<void>()
    const watcher = controlledWatcher({
      nextCalls,
      done: watcherDone,
      stops: [],
      name: "late-resolver"
    })
    const pending = deferred<ConfigObject>()
    let loads = 0
    const config = newConfig(
      source({
        name: "late-resolver",
        async load(): Promise<ConfigSourceSnapshot> {
          loads += 1
          return { value: { loads }, revision: String(loads) }
        },
        async watch() {
          return watcher
        }
      }),
      resolver(function delayReload(_ctx, value) {
        return value.loads === 2 ? pending.promise : value
      })
    )
    const handle = await startConfig(config)
    nextCalls[0]?.resolve(undefined)
    await flush(8)

    await handle.close(background())
    expect(config.value("loads").load()).toBe(1)
    pending.resolve({ loads: 2, stale: true })
    await flush()
    expect(config.value("stale").load()).toBeNull()
  })

  test("resolves dotted keys, nested arrays, multiple references, and recursive defaults", async () => {
    const config = newConfig(
      source(
        objectSource("templates", {
          scheme: "https",
          service: { host: "database" },
          fallbackPort: "8443",
          output: {
            url: "${scheme}://${service.host}:${missing:${fallbackPort}}/v1",
            nested: [
              ["${service.host}", "x-${service.host}-${service.host}"],
              "${missing:tcp://${service.host}:${fallbackPort}}",
              "${missing:left:right}"
            ]
          }
        })
      ),
      resolver(placeholderResolver())
    )

    await config.load(background())
    expect(config.value("output").load()).toEqual({
      url: "https://database:8443/v1",
      nested: [["database", "x-database-database"], "tcp://database:8443", "left:right"]
    })
    await config.close(background())
  })

  test("preserves last-good when placeholder resolution fails and recovers later", async () => {
    const nextCalls: Deferred<void>[] = []
    const watcherDone = deferred<void>()
    const watcher = controlledWatcher({
      nextCalls,
      done: watcherDone,
      stops: [],
      name: "placeholder-reload"
    })
    const failures: { error: Error; current: ConfigValue | null }[] = []
    let loads = 0
    const config = newConfig(
      source({
        name: "placeholder-reload",
        async load(): Promise<ConfigSourceSnapshot> {
          loads += 1
          if (loads === 2) return { value: { output: "${missing}" }, revision: "2" }
          const value = loads === 1 ? "first" : "recovered"
          return { value: { value, output: "${value}" }, revision: String(loads) }
        },
        async watch() {
          return watcher
        }
      }),
      resolver(placeholderResolver()),
      onReloadError(function report(error, current) {
        failures.push({ error, current })
      })
    )
    const handle = await startConfig(config)
    nextCalls[0]?.resolve(undefined)
    await flush(10)
    expect(config.value("output").load()).toBe("first")
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error).toBeInstanceOf(TypeError)

    nextCalls[1]?.resolve(undefined)
    await flush(10)
    expect(config.value("output").load()).toBe("recovered")
    expect(failures).toHaveLength(1)
    await handle.close(background())
  })

  test("fails safely for missing, malformed, non-string, and cyclic references", async () => {
    const cases: readonly ConfigObject[] = [
      { secret: "do-not-leak", output: "${missing}" },
      { secret: "do-not-leak", output: "${secret" },
      { output: "${}" },
      { port: 8080, output: "${port:443}" },
      { direct: "${direct}" },
      { first: "${second}", second: "${first}" }
    ]
    for (const value of cases) {
      const config = newConfig(
        source(objectSource("invalid-placeholder", value)),
        resolver(placeholderResolver())
      )
      const failure = await config.load(background()).catch(function capture(error: unknown) {
        return error
      })
      expect(failure).toBeInstanceOf(TypeError)
      expect(String(failure)).not.toContain("do-not-leak")
      expect(config.value("output").load()).toBeNull()
    }
  })

  test("keeps the merged document unchanged when no resolver is configured", async () => {
    const config = newConfig(source(objectSource("plain", { value: "${literal}" })))
    await config.load(background())
    expect(await readConfig(config)).toEqual({ value: "${literal}" })
    await config.close(background())
  })
})
