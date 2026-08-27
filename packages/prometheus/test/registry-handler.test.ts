import { cp, mkdtemp, realpath, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

import { expect, test } from "bun:test"
import { Counter, Registry, register, type OpenMetricsContentType } from "prom-client"

import { createPrometheusHandler } from "../src/index"

test("creates an isolated raw Registry without mutating the prom-client global registry", async () => {
  register.clear()
  const registry = new Registry()
  const counter = new Counter({
    name: "go_like_requests_total",
    help: "Total requests handled by the test.",
    registers: [registry]
  })
  counter.inc(2)

  expect(registry).toBeInstanceOf(Registry)
  expect(await registry.metrics()).toContain("go_like_requests_total 2")
  expect(await register.metrics()).not.toContain("go_like_requests_total")
  register.clear()
})

test("preserves official duplicate-registration behavior", () => {
  const registry = new Registry()
  new Counter({ name: "go_like_duplicate_total", help: "first", registers: [registry] })

  expect(() => {
    new Counter({ name: "go_like_duplicate_total", help: "second", registers: [registry] })
  }).toThrow("A metric with the name go_like_duplicate_total has already been registered")
})

test("accepts a raw Registry from a second physical prom-client installation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "go-like-prom-client-copy-"))
  try {
    const installed = await realpath(join(import.meta.dir, "../node_modules/prom-client"))
    await cp(dirname(installed), join(temporary, "node_modules"), {
      recursive: true,
      dereference: true
    })
    const requireFromInstalled = createRequire(join(installed, "index.js"))
    const bintrees = dirname(requireFromInstalled.resolve("bintrees"))
    await cp(bintrees, join(temporary, "node_modules/bintrees"), {
      recursive: true,
      dereference: true
    })
    const requireFromCopy = createRequire(join(temporary, "entry.cjs"))
    const foreign: unknown = requireFromCopy("prom-client")
    if (typeof foreign !== "object" || foreign === null || !("Registry" in foreign)) {
      throw new Error("copied prom-client does not expose Registry")
    }
    const constructor = foreign.Registry
    if (typeof constructor !== "function") throw new Error("copied Registry is not constructable")
    const registry: unknown = Reflect.construct(constructor, [])
    expect(registry).not.toBeInstanceOf(Registry)

    const handler: unknown = Reflect.apply(createPrometheusHandler, undefined, [registry])
    if (typeof handler !== "function")
      throw new Error("structural Registry did not produce a handler")
    const response: unknown = await Reflect.apply(handler, undefined, [
      new Request("https://service.test/metrics")
    ])
    if (!(response instanceof Response))
      throw new Error("structural Registry did not produce a Response")
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe(Registry.PROMETHEUS_CONTENT_TYPE)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test("serves GET and HEAD with registry-native content metadata", async () => {
  const registry = new Registry()
  const counter = new Counter({
    name: "go_like_jobs_total",
    help: "Total jobs.",
    registers: [registry]
  })
  counter.inc(3)
  const handler = createPrometheusHandler(registry)

  const get = await handler(new Request("https://service.test/metrics"))
  const payload = await get.text()
  expect(get.status).toBe(200)
  expect(get.headers.get("Content-Type")).toBe(registry.contentType)
  expect(get.headers.get("Cache-Control")).toBe("no-store")
  expect(get.headers.get("Content-Length")).toBe(
    String(new TextEncoder().encode(payload).byteLength)
  )
  expect(payload).toContain("go_like_jobs_total 3")

  const head = await handler(new Request("https://service.test/metrics", { method: "HEAD" }))
  expect(head.status).toBe(200)
  expect(await head.text()).toBe("")
  expect(head.headers.get("Content-Type")).toBe(registry.contentType)
  expect(head.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"))
})

test("tracks an official OpenMetrics registry content type", async () => {
  const registry = new Registry<OpenMetricsContentType>()
  registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE)
  const handler = createPrometheusHandler(registry)

  const response = await handler(new Request("https://service.test/metrics"))
  expect(response.status).toBe(200)
  expect(response.headers.get("Content-Type")).toBe(Registry.OPENMETRICS_CONTENT_TYPE)
  expect(await response.text()).toBe("\n# EOF\n")
})

test("routes one normalized custom path and rejects unsupported methods", async () => {
  const handler = createPrometheusHandler(new Registry(), { path: "/internal/metrics" })

  expect((await handler(new Request("https://service.test/metrics"))).status).toBe(404)
  const rejected = await handler(
    new Request("https://service.test/internal/metrics", { method: "POST" })
  )
  expect(rejected.status).toBe(405)
  expect(rejected.headers.get("Allow")).toBe("GET, HEAD")
  expect(rejected.headers.get("Cache-Control")).toBe("no-store")
})

test("sanitizes registry collection failures for GET and HEAD", async () => {
  const registry = new Registry()
  const secret = "redis://user:password@private.example"
  Object.defineProperty(registry, "metrics", {
    value: async () => {
      throw new Error(secret)
    }
  })
  const handler = createPrometheusHandler(registry)

  const get = await handler(new Request("https://service.test/metrics"))
  const getBody = await get.text()
  expect(get.status).toBe(500)
  expect(getBody).toBe("metrics unavailable\n")
  expect(getBody).not.toContain(secret)
  expect(get.headers.get("Content-Type")).toBe("text/plain; charset=utf-8")

  const head = await handler(new Request("https://service.test/metrics", { method: "HEAD" }))
  expect(head.status).toBe(500)
  expect(await head.text()).toBe("")
  expect(head.headers.get("Content-Length")).toBe(
    String(new TextEncoder().encode("metrics unavailable\n").byteLength)
  )
})

test("keeps concurrent scrapes independent", async () => {
  const registry = new Registry()
  let calls = 0
  let release = (): void => {
    throw new Error("concurrent scrape release is missing")
  }
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  Object.defineProperty(registry, "metrics", {
    value: async () => {
      calls += 1
      const current = calls
      await gate
      return `go_like_concurrent ${current}\n`
    }
  })
  const handler = createPrometheusHandler(registry)
  const first = handler(new Request("https://service.test/metrics"))
  const second = handler(new Request("https://service.test/metrics"))
  await Promise.resolve()
  release()

  const responses = await Promise.all([first, second])
  expect(await responses[0]?.text()).toBe("go_like_concurrent 1\n")
  expect(await responses[1]?.text()).toBe("go_like_concurrent 2\n")
})

test("keeps a bounded application-owned label schema intact", async () => {
  const registry = new Registry()
  const counter = new Counter({
    name: "go_like_operations_total",
    help: "Operations by bounded outcome.",
    labelNames: ["outcome"],
    registers: [registry]
  })
  counter.inc({ outcome: "success" })
  counter.inc({ outcome: "failure" })

  const response = await createPrometheusHandler(registry)(
    new Request("https://service.test/metrics")
  )
  const body = await response.text()
  expect(body).toContain('go_like_operations_total{outcome="success"} 1')
  expect(body).toContain('go_like_operations_total{outcome="failure"} 1')
})

test("leaves Registry cleanup under explicit application ownership", async () => {
  const registry = new Registry()
  new Counter({ name: "go_like_cleanup_total", help: "cleanup", registers: [registry] })
  expect(registry.getMetricsAsArray()).toHaveLength(1)

  registry.clear()

  expect(registry.getMetricsAsArray()).toHaveLength(0)
  const response = await createPrometheusHandler(registry)(
    new Request("https://service.test/metrics")
  )
  expect(await response.text()).toBe("\n")
})

test("validates the registry and route boundary before returning a handler", () => {
  expect(() => Reflect.apply(createPrometheusHandler, undefined, [{}])).toThrow(TypeError)
  const hostile = Object.defineProperty({}, "metrics", {
    get: () => {
      throw new Error("hostile registry getter")
    }
  })
  expect(() => Reflect.apply(createPrometheusHandler, undefined, [hostile])).toThrow(TypeError)
  expect(() => createPrometheusHandler(new Registry(), { path: "" })).toThrow(TypeError)
  expect(() => createPrometheusHandler(new Registry(), { path: "metrics" })).toThrow(TypeError)
  expect(() => createPrometheusHandler(new Registry(), { path: "/metrics?format=text" })).toThrow(
    TypeError
  )
  expect(() => createPrometheusHandler(new Registry(), { path: "/a/../metrics" })).toThrow(
    TypeError
  )
})
