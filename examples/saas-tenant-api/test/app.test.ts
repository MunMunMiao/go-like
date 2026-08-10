import { expiresIn, type Cache } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"
import { newConfig, objectSource, schema, source, type ConfigObject } from "@go-like/config"
import { background, withoutCancel } from "@go-like/context"
import { afterStop, beforeStart, newApp, stopTimeout, type App } from "@go-like/core"
import { afterEach, describe, expect, test } from "bun:test"
import pino from "pino"

import { decodeCached } from "../src/cache"
import { tenantDocumentSchema, type TenantDocument } from "../src/config"
import { newTenantHandler } from "../src/http"

const applications: Array<{ readonly app: App; readonly running: Promise<void> }> = []

/** Creates one valid immutable tenant configuration input. */
function document(generation = "generation-1"): TenantDocument {
  return {
    schemaVersion: 1,
    generation,
    cacheTtlMs: 30_000,
    tenants: {
      "tenant-acme": {
        enabled: true,
        plan: "pro",
        features: { exports: true },
        rateLimit: { capacity: 3, refillTokens: 3, refillIntervalMs: 60_000 }
      },
      "tenant-beta": {
        enabled: true,
        plan: "basic",
        features: { exports: false },
        rateLimit: { capacity: 1, refillTokens: 1, refillIntervalMs: 60_000 }
      }
    }
  }
}

/** Starts a real Config around the public handler and creates an in-process Cache. */
async function fixture(input: ConfigObject = document()) {
  const config = newConfig(source(objectSource("tenant-test", input)), schema(tenantDocumentSchema))
  const cache = newMemoryCache()
  const app = newApp(
    stopTimeout(1_000),
    beforeStart((ctx) => config.load(ctx)),
    afterStop((ctx) => config.close(withoutCancel(ctx)))
  )
  const running = app.run()
  void running.catch(() => {})
  applications.push({ app, running })
  const deadline = Date.now() + 1_000
  while (config.value("generation").load() === null && Date.now() < deadline) await Bun.sleep(1)
  if (config.value("generation").load() === null)
    throw new Error("tenant test Config did not publish")
  const handler = newTenantHandler({
    config,
    cache,
    logger: pino({ enabled: false }),
    resolveTenant(_ctx, request) {
      return request.headers.get("X-Test-Tenant") ?? ""
    }
  })
  return { config, cache, handler }
}

function failingCache(): Cache {
  return Object.freeze({
    async get() {
      throw new Error("cache get failed")
    },
    async put() {
      throw new Error("cache put failed")
    },
    async delete() {
      throw new Error("cache delete failed")
    },
    string() {
      return "failing-cache"
    }
  })
}

afterEach(async () => {
  while (applications.length > 0) {
    const application = applications.pop()
    if (application === undefined) continue
    await application.app.stop()
    await application.running
  }
})

describe("tenant configuration schema", () => {
  test("validates one complete tenant document", () => {
    const result = tenantDocumentSchema["~standard"].validate(document())
    expect(result).toHaveProperty("value")
    if (!("value" in result)) throw new Error("expected tenant document validation to succeed")
    expect(result.value.generation).toBe("generation-1")
    expect(result.value.tenants["tenant-acme"]?.features.exports).toBe(true)
  })

  test("rejects invalid limiter data before publication", async () => {
    const invalid: ConfigObject = {
      schemaVersion: 1,
      generation: "generation-1",
      cacheTtlMs: 30_000,
      tenants: {
        "tenant-acme": {
          enabled: true,
          plan: "pro",
          features: { exports: true },
          rateLimit: { capacity: 0, refillTokens: 1, refillIntervalMs: 1 }
        }
      }
    }
    const config = newConfig(source(objectSource("invalid", invalid)), schema(tenantDocumentSchema))
    await expect(config.load(background())).rejects.toMatchObject({
      code: "GO_LIKE_CONFIG_VALIDATION"
    })
  })

  test("rejects invalid document roots before publication", () => {
    const invalid = { ...document(), schemaVersion: 2 } as ConfigObject
    const result = tenantDocumentSchema["~standard"].validate(invalid)
    expect(result).toMatchObject({
      issues: [{ message: "invalid tenant configuration document" }]
    })
  })
})

describe("tenant cache decoding", () => {
  test.each([
    "not-json",
    JSON.stringify({ tenantId: "other", generation: "generation-1", plan: "pro", features: {} }),
    JSON.stringify({ tenantId: "tenant-acme", generation: "old", plan: "pro", features: {} }),
    JSON.stringify({
      tenantId: "tenant-acme",
      generation: "generation-1",
      plan: "invalid plan",
      features: {}
    }),
    JSON.stringify({
      tenantId: "tenant-acme",
      generation: "generation-1",
      plan: "pro",
      features: { exports: "yes" }
    })
  ])("rejects a malformed, stale, or hostile cache payload %#", (value) => {
    expect(decodeCached(new TextEncoder().encode(value), "tenant-acme", "generation-1")).toBeNull()
  })
})

describe("tenant API", () => {
  test("isolates tenants and reuses the tenant-generation cache entry", async () => {
    const { cache, handler } = await fixture()
    const first = await handler(
      new Request("http://example.test/v1/tenant/config", {
        headers: { "X-Test-Tenant": "tenant-acme" }
      })
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      tenantId: "tenant-acme",
      generation: "generation-1",
      plan: "pro",
      features: { exports: true }
    })
    expect(await cache.get(background(), "config:v1:generation-1:tenant-acme")).not.toBeNull()

    const cached = await handler(
      new Request("http://example.test/v1/tenant/config", {
        headers: { "X-Test-Tenant": "tenant-acme" }
      })
    )
    expect(cached.status).toBe(200)
    expect((await cached.json()).tenantId).toBe("tenant-acme")

    const second = await handler(
      new Request("http://example.test/v1/tenant/config", {
        headers: { "X-Test-Tenant": "tenant-beta" }
      })
    )
    expect(second.status).toBe(200)
    expect((await second.json()).tenantId).toBe("tenant-beta")
    expect(await cache.get(background(), "config:v1:generation-1:tenant-beta")).not.toBeNull()
  })

  test("keeps Config authoritative over a valid-shaped cache payload", async () => {
    const { cache, handler } = await fixture()
    await cache.put(
      background(),
      "config:v1:generation-1:tenant-acme",
      new TextEncoder().encode(
        JSON.stringify({
          tenantId: "tenant-acme",
          generation: "generation-1",
          plan: "enterprise",
          features: { exports: false }
        })
      ),
      expiresIn(30_000)
    )

    const response = await handler(
      new Request("http://example.test/v1/tenant/config", {
        headers: { "X-Test-Tenant": "tenant-acme" }
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tenantId: "tenant-acme",
      generation: "generation-1",
      plan: "pro",
      features: { exports: true }
    })
  })

  test("fails identity closed and rate limits before another cache read", async () => {
    const { cache, handler } = await fixture()
    const anonymous = await handler(new Request("http://example.test/v1/tenant/config"))
    expect(anonymous.status).toBe(401)
    const inherited = await handler(
      new Request("http://example.test/v1/tenant/config", {
        headers: { "X-Test-Tenant": "constructor" }
      })
    )
    expect(inherited.status).toBe(404)

    const request = () =>
      handler(
        new Request("http://example.test/v1/tenant/config", {
          headers: { "X-Test-Tenant": "tenant-beta" }
        })
      )
    expect((await request()).status).toBe(200)
    const limited = await request()
    expect(limited.status).toBe(429)
    expect(limited.headers.get("Retry-After")).toBe("60")

    await cache.put(background(), "unrelated", new Uint8Array([1]), expiresIn(1_000))
    expect(await cache.get(background(), "unrelated")).not.toBeNull()
  })

  test("maps missing, disabled, configuration, and cache failures to stable responses", async () => {
    const { config } = await fixture()
    const missing = newTenantHandler({
      config,
      cache: newMemoryCache(),
      logger: pino({ enabled: false }),
      resolveTenant: () => "tenant-missing"
    })
    expect((await missing(new Request("http://example.test/v1/tenant/config"))).status).toBe(404)

    const disabledDocument = document()
    const disabledInput = {
      ...disabledDocument,
      tenants: {
        ...disabledDocument.tenants,
        "tenant-disabled": { ...disabledDocument.tenants["tenant-beta"], enabled: false }
      }
    }
    const disabledResult = tenantDocumentSchema["~standard"].validate(disabledInput)
    expect(disabledResult).toHaveProperty("value")
    const disabledConfig = newConfig(
      source(objectSource("disabled", disabledInput)),
      schema(tenantDocumentSchema)
    )
    const disabled = newTenantHandler({
      config: disabledConfig,
      cache: newMemoryCache(),
      logger: pino({ enabled: false }),
      resolveTenant: () => "tenant-disabled"
    })
    const disabledRunning = disabledConfig.load(background())
    await disabledRunning
    expect((await disabled(new Request("http://example.test/v1/tenant/config"))).status).toBe(403)
    await disabledConfig.close(withoutCancel(background()))

    const unavailableConfig = {
      async scan() {
        throw new Error("config unavailable")
      }
    } as never
    const unavailable = newTenantHandler({
      config: unavailableConfig,
      cache: newMemoryCache(),
      logger: pino({ enabled: false }),
      resolveTenant: () => "tenant-acme"
    })
    expect((await unavailable(new Request("http://example.test/v1/tenant/config"))).status).toBe(
      503
    )

    const cacheFailure = newTenantHandler({
      config,
      cache: failingCache(),
      logger: pino({ enabled: false }),
      resolveTenant: () => "tenant-acme"
    })
    expect((await cacheFailure(new Request("http://example.test/v1/tenant/config"))).status).toBe(
      200
    )

    const invalidCache = newTenantHandler({
      config,
      cache: {
        async get() {
          return new TextEncoder().encode("not-json")
        },
        async put() {},
        async delete() {
          throw new Error("cache cleanup failed")
        },
        string() {
          return "invalid-cache"
        }
      },
      logger: pino({ enabled: false }),
      resolveTenant: () => "tenant-acme"
    })
    expect((await invalidCache(new Request("http://example.test/v1/tenant/config"))).status).toBe(
      200
    )

    const cacheHit = newTenantHandler({
      config,
      cache: {
        async get() {
          return new TextEncoder().encode(
            JSON.stringify({
              tenantId: "tenant-acme",
              generation: "generation-1",
              plan: "pro",
              features: { exports: true }
            })
          )
        },
        async put() {},
        async delete() {},
        string() {
          return "cache-hit"
        }
      },
      logger: pino({ enabled: false }),
      resolveTenant: () => "tenant-acme"
    })
    expect((await cacheHit(new Request("http://example.test/v1/tenant/config"))).status).toBe(200)
  })

  test("returns a stable response if the framework loses request context identity", async () => {
    const { config, cache } = await fixture()
    const weakMapPrototype = WeakMap.prototype as unknown as {
      set(key: object, value: unknown): WeakMap<object, unknown>
    }
    const originalSet = weakMapPrototype.set
    let skippedContext = false
    weakMapPrototype.set = function skipContextSet(
      this: WeakMap<object, unknown>,
      key: object,
      value: unknown
    ): WeakMap<object, unknown> {
      if (
        !skippedContext &&
        value !== null &&
        typeof value === "object" &&
        "done" in value &&
        "err" in value
      ) {
        skippedContext = true
        return this
      }
      return originalSet.call(this, key, value)
    }
    try {
      const response = await newTenantHandler({
        config,
        cache,
        logger: pino({ enabled: false }),
        resolveTenant: () => "tenant-acme"
      })(new Request("http://example.test/v1/tenant/config"))
      expect(skippedContext).toBe(true)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error: "internal_context_missing" })
    } finally {
      weakMapPrototype.set = originalSet
    }
  })

  test("normalizes primitive identity failures without exposing details", async () => {
    const { config, cache } = await fixture()
    const handler = newTenantHandler({
      config,
      cache,
      logger: pino({ enabled: false }),
      resolveTenant() {
        throw "identity lookup failed"
      }
    })
    const response = await handler(new Request("http://example.test/v1/tenant/config"))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "identity_unavailable" })
  })

  test("preserves request ids and sanitizes identity diagnostics", async () => {
    const { config, cache } = await fixture()
    const handler = newTenantHandler({
      config,
      cache,
      logger: pino({ enabled: false }),
      resolveTenant() {
        throw Object.assign(new Error("hidden"), { code: "Unsafe Code" })
      }
    })
    const response = await handler(
      new Request("http://example.test/v1/tenant/config", {
        headers: { "X-Request-Id": "request-123" }
      })
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: "identity_unavailable",
      requestId: "request-123"
    })
  })

  test("keeps a hostile identity failure from replacing the unavailable response", async () => {
    const { config, cache } = await fixture()
    const handler = newTenantHandler({
      config,
      cache,
      logger: pino({ enabled: false }),
      resolveTenant() {
        const failure = Object.create(null)
        Object.defineProperty(failure, "code", {
          get() {
            throw new Error("hostile error getter")
          }
        })
        throw failure
      }
    })

    const response = await handler(new Request("http://example.test/v1/tenant/config"))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "identity_unavailable" })
  })
})
