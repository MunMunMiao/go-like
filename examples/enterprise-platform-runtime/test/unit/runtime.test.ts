import { describe, expect, test } from "bun:test"

import { newConfig, objectSource, schema, source as configSource } from "@likego/config"
import { background, type Context } from "@likego/context"
import { newProbeRegistry } from "@likego/health"
import { createHealthHandler } from "@likego/web/health"

import { runtimeConfigSchema } from "../../src/config"
import { newEchoHandler } from "../../src/echo"
import { newManagementHandler } from "../../src/management"
import { registerRuntimeProbes } from "../../src/probes"

describe("runtime configuration", () => {
  test("publishes a detached validated value", async () => {
    const source = { release: 2, feature: { enabled: true } }
    const result = await runtimeConfigSchema["~standard"].validate(source)
    expect(result).toEqual({ value: source })
    source.feature.enabled = false
    expect("value" in result && result.value.feature.enabled).toBe(true)
  })

  test("rejects incomplete, unsafe, and malformed values", async () => {
    const values: unknown[] = [
      null,
      {},
      { release: 1.5, feature: { enabled: true } },
      { release: 1, feature: null },
      { release: 1, feature: [] },
      { release: 1, feature: { enabled: "yes" } }
    ]
    for (const value of values) {
      const result = await runtimeConfigSchema["~standard"].validate(value)
      expect("issues" in result).toBe(true)
    }
  })
})

test("echo handler reads the latest validated configuration", async () => {
  const config = newConfig(
    configSource(objectSource("test", { release: 3, feature: { enabled: true } })),
    schema(runtimeConfigSchema)
  )
  await config.load(background())
  try {
    let calls = 0
    const response = await newEchoHandler(config, () => {
      calls += 1
    })(background(), { header: {}, body: new Uint8Array() })
    expect(new TextDecoder().decode(response.body)).toBe("pong:3")
    expect(calls).toBe(1)
    expect(
      new TextDecoder().decode(
        (await newEchoHandler(config)(background(), { header: {}, body: new Uint8Array() })).body
      )
    ).toBe("pong:3")
  } finally {
    await config.close(background())
  }
})

test("echo handler rejects calls before configuration is available", () => {
  const config = newConfig(
    configSource(objectSource("test", { release: 1, feature: { enabled: true } })),
    schema(runtimeConfigSchema)
  )
  expect(() =>
    newEchoHandler(config)(background(), { header: {}, body: new Uint8Array() })
  ).toThrow(/runtime configuration is not ready/)
})

test("management routes metrics and preserves health status", async () => {
  let ready = true
  const probes = newProbeRegistry()
  registerRuntimeProbes(probes, () => ready)
  const handler = newManagementHandler(
    createHealthHandler(probes),
    async () => new Response("metric 1\n"),
    {
      async call() {
        return { header: {}, body: new TextEncoder().encode("pong:1") }
      },
      async close() {
        return
      }
    }
  )
  expect((await handler(new Request("http://localhost/livez"))).status).toBe(200)
  expect(await (await handler(new Request("http://localhost/metrics"))).text()).toBe("metric 1\n")
  expect(await (await handler(new Request("http://localhost/call"))).json()).toEqual({
    response: "pong:1"
  })
  const failedCall = await newManagementHandler(
    createHealthHandler(probes),
    async () => new Response("metric 1\n"),
    {
      async call() {
        throw new Error("internal call failed")
      },
      async close() {
        return
      }
    }
  )(new Request("http://localhost/call"))
  expect(failedCall.status).toBe(503)
  expect(await failedCall.json()).toEqual({ code: "internal_call_failed" })
  ready = false
  expect((await handler(new Request("http://localhost/readyz"))).status).toBe(503)
  expect((await handler(new Request("http://localhost/missing"))).status).toBe(404)
})

test("management propagates request cancellation to the internal service call", async () => {
  let observed: AbortSignal | null | undefined
  const handler = newManagementHandler(
    async () => new Response(null, { status: 404 }),
    async () => new Response("metric 1\n"),
    {
      async call(ctx: Context) {
        observed = ctx.done()
        return { header: {}, body: new TextEncoder().encode("pong:1") }
      },
      async close() {
        return
      }
    }
  )
  const controller = new AbortController()
  const request = new Request("http://localhost/call", { signal: controller.signal })
  controller.abort(new Error("caller disconnected"))

  await handler(request)

  expect(observed?.aborted).toBe(true)
})
