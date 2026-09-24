import type { CallOption, CallRequest, Client } from "@go-like/client"
import { describe, expect, test } from "bun:test"

import { newConfig, objectSource, schema, source as configSource } from "@go-like/config"
import { background, type Context } from "@go-like/context"
import { newProbeRegistry } from "@go-like/health"
import type { Handler, HandlerRegistrar } from "@go-like/server"
import { createHealthHandler } from "@go-like/web/health"

import { runtimeConfigSchema } from "../../src/config"
import { newEchoClient, newEchoHandler, registerEchoHandler } from "../../src/echo"
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

test("registers the Echo handler on its exact service endpoint", () => {
  const handler: Handler = (_ctx, request) => request
  let registration: readonly unknown[] = Object.freeze([])
  const server: HandlerRegistrar = {
    registerHandler(...args: readonly unknown[]): void {
      registration = args
    }
  }

  registerEchoHandler(server, handler)

  expect(registration).toEqual(["platform.echo", "Ping", handler])
})

test("creates a typed Echo client that preserves calls and errors", async () => {
  const ctx = background()
  const option: CallOption = (options) => options
  const failure = new Error("Echo unavailable")
  let rejected = false
  let observed: readonly unknown[] = Object.freeze([])
  const client = Object.freeze({
    async call(ctxValue: unknown, request: CallRequest, ...options: readonly unknown[]) {
      observed = [ctxValue, request, ...options]
      if (rejected) throw failure
      return {
        header: Object.freeze({}),
        body: new TextEncoder().encode("pong:7")
      }
    },
    async close(): Promise<void> {}
  }) as unknown as Client
  const { ping } = newEchoClient(client)

  expect(await ping(ctx, option)).toBe("pong:7")
  expect(observed[0]).toBe(ctx)
  expect(observed[1]).toEqual({
    service: "platform.echo",
    endpoint: "Ping",
    message: { header: {}, body: new Uint8Array() }
  })
  expect(observed.slice(2)).toEqual([option])
  rejected = true
  await expect(ping(ctx)).rejects.toBe(failure)
})

test("management routes metrics and preserves health status", async () => {
  let ready = true
  const probes = newProbeRegistry()
  registerRuntimeProbes(probes, () => ready)
  const handler = newManagementHandler(
    createHealthHandler(probes),
    async () => new Response("metric 1\n"),
    {
      async ping() {
        return "pong:1"
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
      async ping() {
        throw new Error("internal call failed")
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
      async ping(ctx: Context) {
        observed = ctx.done()
        return "pong:1"
      }
    }
  )
  const controller = new AbortController()
  const request = new Request("http://localhost/call", { signal: controller.signal })
  controller.abort(new Error("caller disconnected"))

  await handler(request)

  expect(observed?.aborted).toBe(true)
})
