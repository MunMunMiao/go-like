import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"
import { newConfig, objectSource, schema, source, type ConfigObject } from "@go-like/config"
import { background, withoutCancel } from "@go-like/context"
import { afterStop, beforeStart, newApp, stopTimeout, type App } from "@go-like/core"
import { afterEach, describe, expect, test } from "bun:test"
import pino from "pino"

import { tenantDocumentSchema } from "../src/config"
import { newTenantHandler } from "../src/http"

const applications: Array<{ readonly app: App; readonly running: Promise<void> }> = []

/** Creates one valid immutable tenant configuration input. */
function document(generation = "generation-1"): ConfigObject {
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

afterEach(async () => {
  while (applications.length > 0) {
    const application = applications.pop()
    if (application === undefined) continue
    await application.app.stop()
    await application.running
  }
})

describe("tenant configuration schema", () => {
  test("publishes one valid complete document", async () => {
    const { config } = await fixture()
    const document = await config.scan(background(), tenantDocumentSchema)
    expect(document.generation).toBe("generation-1")
    expect(document.tenants["tenant-acme"]?.features.exports).toBe(true)
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
