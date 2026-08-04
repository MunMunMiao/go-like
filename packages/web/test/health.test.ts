import { expect, test } from "bun:test"
import vm from "node:vm"

import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "../src/health"

async function json(response: Response): Promise<unknown> {
  return await response.json()
}

test("default paths ignore query strings and return deterministic sanitized JSON", async () => {
  const registry = newProbeRegistry()
  registry.register("ready", "go-like.app", () => {})
  const handler = createHealthHandler(registry)

  const response = await handler(new Request("https://service.test/readyz?x=1"))

  expect(response.status).toBe(200)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
  expect(await response.text()).toBe(
    '{"status":"ok","checks":[{"name":"go-like.app","status":"ok"}]}'
  )
})

test("unhealthy reports use 503 and never expose private errors", async () => {
  const registry = newProbeRegistry()
  registry.register("live", "db", () => {
    throw new Error("postgres://secret")
  })
  const handler = createHealthHandler(registry)

  const response = await handler(new Request("https://service.test/livez"))

  expect(response.status).toBe(503)
  expect(await json(response)).toEqual({
    status: "unavailable",
    checks: [{ name: "db", status: "failed" }]
  })
})

test("HEAD matches GET representation metadata without a body", async () => {
  const registry = newProbeRegistry()
  registry.register("live", "x", () => {})
  const handler = createHealthHandler(registry)
  const get = await handler(new Request("https://service.test/livez"))
  const head = await handler(new Request("https://service.test/livez", { method: "HEAD" }))

  expect(head.status).toBe(get.status)
  expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"))
  expect(head.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"))
  expect(await head.text()).toBe("")
})

test("unknown paths and unsupported methods do not run checks", async () => {
  let ran = 0
  const registry = newProbeRegistry()
  registry.register("ready", "x", () => {
    ran += 1
  })
  const handler = createHealthHandler(registry)

  const missing = await handler(new Request("https://service.test/missing"))
  const method = await handler(new Request("https://service.test/readyz", { method: "POST" }))

  expect(missing.status).toBe(404)
  expect(method.status).toBe(405)
  expect(method.headers.get("Allow")).toBe("GET, HEAD")
  expect(await missing.text()).toBe("")
  expect(await method.text()).toBe("")
  expect(ran).toBe(0)
})

test("custom paths are validated, snapshotted, and distinct", async () => {
  const registry = newProbeRegistry()
  expect(() => createHealthHandler(null as never)).toThrow(TypeError)
  expect(() => createHealthHandler(registry, { livePath: "livez" })).toThrow(TypeError)
  expect(() => createHealthHandler(registry, { livePath: "/a/../livez" })).toThrow(TypeError)
  expect(() => createHealthHandler(registry, { livePath: "/same", readyPath: "/same" })).toThrow(
    TypeError
  )

  const options = { livePath: "/health/live", readyPath: "/health/ready" }
  const handler = createHealthHandler(registry, options)
  options.livePath = "/mutated"
  registry.register("live", "x", () => {})

  const ok = await handler(new Request("https://service.test/health/live"))
  const missing = await handler(new Request("https://service.test/mutated"))
  expect(ok.status).toBe(200)
  expect(missing.status).toBe(404)
})

test("registry structural failures return the exact sanitized payload", async () => {
  const handler = createHealthHandler({
    register: () => () => false,
    check: async () => {
      throw new Error("stack and secret")
    }
  })

  const response = await handler(new Request("https://service.test/readyz"))

  expect(response.status).toBe(503)
  expect(await response.text()).toBe('{"status":"unavailable","checks":[]}')
})

test("empty readiness is accepted as a valid unavailable report", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(JSON, "stringify")
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("JSON.stringify descriptor is missing")
  }
  const stringify = descriptor.value
  let serializations = 0
  Object.defineProperty(JSON, "stringify", {
    ...descriptor,
    value(value: unknown): string | undefined {
      serializations += 1
      return stringify.call(JSON, value)
    }
  })

  try {
    const handler = createHealthHandler(newProbeRegistry())
    const response = await handler(new Request("https://service.test/readyz"))

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"status":"unavailable","checks":[]}')
    expect(serializations).toBe(1)
  } finally {
    Object.defineProperty(JSON, "stringify", descriptor)
  }
})

test("structural reports cannot claim successful empty readiness", async () => {
  const handler = createHealthHandler({
    register: () => () => false,
    check: async () => ({ kind: "ready", ok: true, checks: [] })
  })

  const response = await handler(new Request("https://service.test/readyz"))

  expect(response.status).toBe(503)
  expect(await response.text()).toBe('{"status":"unavailable","checks":[]}')
})

test("malformed registry reports fail closed with the exact sanitized payload", async () => {
  const handler = createHealthHandler({
    register: () => () => false,
    check: async () =>
      ({ kind: "ready", ok: true, checks: [{ name: "x", ok: true, error: "bad" }] }) as never
  })

  const response = await handler(new Request("https://service.test/readyz"))

  expect(response.status).toBe(503)
  expect(await response.text()).toBe('{"status":"unavailable","checks":[]}')
})

test("malformed top-level report fields fail closed", async () => {
  const handler = createHealthHandler({
    register: () => () => false,
    check: async () => ({ kind: "live", ok: true, checks: [] }) as never
  })

  const response = await handler(new Request("https://service.test/readyz"))

  expect(response.status).toBe(503)
  expect(await response.text()).toBe('{"status":"unavailable","checks":[]}')
})

test("throwing structural report getters fail closed", async () => {
  const handler = createHealthHandler({
    register: () => () => false,
    check: async () =>
      ({
        get kind(): "ready" {
          throw new Error("private getter failure")
        },
        ok: true,
        checks: []
      }) as never
  })

  const response = await handler(new Request("https://service.test/readyz"))

  expect(response.status).toBe(503)
  expect(await response.text()).toBe('{"status":"unavailable","checks":[]}')
})

test("structural registry reports require public names and consistent ok/error state", async () => {
  for (const check of [
    { kind: "ready", ok: true, checks: [{ name: "postgres://secret", ok: true, error: null }] },
    { kind: "ready", ok: true, checks: [{ name: "x", ok: false, error: new Error("private") }] },
    { kind: "ready", ok: false, checks: [{ name: "x", ok: true, error: null }] },
    { kind: "ready", ok: false, checks: [{ name: "x", ok: true, error: new Error("private") }] }
  ]) {
    const handler = createHealthHandler({
      register: () => () => false,
      check: async () => check as never
    })

    const response = await handler(new Request("https://service.test/readyz"))

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"status":"unavailable","checks":[]}')
  }
})

test("structural registry reports accept cross-realm Error values through Error.isError", async () => {
  const crossRealm = vm.runInNewContext("new Error('private cross realm')") as Error
  const handler = createHealthHandler({
    register: () => () => false,
    check: async () => ({
      kind: "ready",
      ok: false,
      checks: [{ name: "remote", ok: false, error: crossRealm }]
    })
  })

  const response = await handler(new Request("https://service.test/readyz"))

  expect(response.status).toBe(503)
  expect(await response.text()).toBe(
    '{"status":"unavailable","checks":[{"name":"remote","status":"failed"}]}'
  )
})

test("structural reports accept same-realm Error values without Error.isError", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  if (descriptor === undefined) throw new Error("Error.isError descriptor is missing")
  Object.defineProperty(Error, "isError", { ...descriptor, value: undefined })
  try {
    const handler = createHealthHandler({
      register: () => () => false,
      check: async () => ({
        kind: "ready",
        ok: false,
        checks: [{ name: "legacy", ok: false, error: new Error("private") }]
      })
    })

    const response = await handler(new Request("https://service.test/readyz"))

    expect(response.status).toBe(503)
    expect(await response.text()).toBe(
      '{"status":"unavailable","checks":[{"name":"legacy","status":"failed"}]}'
    )
  } finally {
    Object.defineProperty(Error, "isError", descriptor)
  }
})

test("structural reports are snapshotted once before public serialization", async () => {
  let kindReads = 0
  let reportOkReads = 0
  let checksReads = 0
  let nameReads = 0
  let checkOkReads = 0
  let errorReads = 0
  const check = {
    get name() {
      nameReads += 1
      return nameReads <= 2 ? "public-name" : "postgres://user:password@private"
    },
    get ok() {
      checkOkReads += 1
      return true
    },
    get error() {
      errorReads += 1
      return null
    }
  }
  const report = {
    get kind() {
      kindReads += 1
      return "ready"
    },
    get ok() {
      reportOkReads += 1
      return true
    },
    get checks() {
      checksReads += 1
      return [check]
    }
  }
  const handler = createHealthHandler({
    register: () => () => false,
    check: async () => report as never
  })

  const response = await handler(new Request("https://service.test/readyz"))

  expect(response.status).toBe(200)
  expect(await response.text()).toBe(
    '{"status":"ok","checks":[{"name":"public-name","status":"ok"}]}'
  )
  expect({ kindReads, reportOkReads, checksReads, nameReads, checkOkReads, errorReads }).toEqual({
    kindReads: 1,
    reportOkReads: 1,
    checksReads: 1,
    nameReads: 1,
    checkOkReads: 1,
    errorReads: 1
  })
})

test("request abort is propagated to the registry through the Context bridge", async () => {
  const registry = newProbeRegistry()
  registry.register("ready", "abort", async (ctx) => {
    await new Promise<void>((resolve) =>
      ctx.done()?.addEventListener("abort", () => resolve(), { once: true })
    )
    throw new Error("private abort detail")
  })
  const handler = createHealthHandler(registry)
  const controller = new AbortController()

  const responsePromise = handler(
    new Request("https://service.test/readyz", {
      signal: controller.signal
    })
  )
  controller.abort(new Error("client left"))
  const response = await responsePromise

  expect(response.status).toBe(503)
  expect(await response.text()).toBe(
    '{"status":"unavailable","checks":[{"name":"abort","status":"failed"}]}'
  )
})
