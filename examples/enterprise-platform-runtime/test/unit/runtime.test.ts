import type { CallOption, CallOptions, Client } from "@go-like/core/client"
import { describe, expect, test } from "bun:test"

import { newConfig, objectSource, schema, source as configSource } from "@go-like/core/config"
import { background, type Context } from "@go-like/core/context"
import { newProbeRegistry } from "@go-like/core/health"
import { info, type LogHandler } from "@go-like/core/log"
import { name, newApp, server, telemetry } from "@go-like/core"
import { newTelemetry } from "@go-like/core/telemetry"
import { createHealthHandler } from "@go-like/core/web"

import { runtimeConfigSchema } from "../../src/config"
import { echoService } from "../../src/contract"
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

test("the App installs telemetry and shuts it down", async () => {
  const events: string[] = []
  const handler: LogHandler = {
    enabled: () => true,
    handle(_ctx, record) {
      events.push(record.message)
    },
    lifecycle: {
      async start() {
        events.push("telemetry.start")
      },
      async stop() {
        events.push("telemetry.stop")
      }
    }
  }
  const app = newApp(
    name("enterprise-platform-runtime"),
    telemetry(newTelemetry({ logHandlers: [handler] })),
    server({
      async start(ctx) {
        info(ctx, "handler-installed")
      },
      async stop() {}
    })
  )
  const running = app.run()
  void running.catch(() => {})
  const deadline = Date.now() + 1_000
  while (!events.includes("handler-installed")) {
    if (Date.now() > deadline) throw new Error(`telemetry was not installed: ${events.join(",")}`)
    await Bun.sleep(5)
  }
  expect(events.indexOf("handler-installed")).toBeGreaterThan(events.indexOf("telemetry.start"))
  await app.stop()
  await running
  expect(events.indexOf("telemetry.stop")).toBeGreaterThan(events.indexOf("handler-installed"))
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
    }).ping(background())
    expect(response).toBe("pong:3")
    expect(calls).toBe(1)
    expect(await newEchoHandler(config).ping(background())).toBe("pong:3")
  } finally {
    await config.close(background())
  }
})

test("echo handler rejects calls before configuration is available", () => {
  const config = newConfig(
    configSource(objectSource("test", { release: 1, feature: { enabled: true } })),
    schema(runtimeConfigSchema)
  )
  expect(() => newEchoHandler(config).ping(background())).toThrow(
    /runtime configuration is not ready/
  )
})

test("registers the Echo handler on its exact service endpoint", () => {
  let registration: readonly { readonly endpoint: unknown; readonly handler: unknown }[] =
    Object.freeze([])
  let invoked = false
  const echoServer = {
    registerHandlers(
      handlers: readonly { readonly endpoint: unknown; readonly handler: unknown }[]
    ): void {
      registration = handlers
    }
  }

  expect({
    name: echoService.name,
    endpoint: echoService.endpoints.ping?.endpoint
  }).toEqual({ name: "platform-echo.v1", endpoint: "ping" })
  echoService.registerHandler(echoServer, {
    ping() {
      invoked = true
      return "pong:0"
    }
  })

  expect(registration[0]?.endpoint).toEqual(echoService.endpoints.ping)
  expect(typeof registration[0]?.handler).toBe("function")
  const registered = registration[0]?.handler as (ctx: Context) => string
  expect(registered(background())).toBe("pong:0")
  expect(invoked).toBe(true)
})

test("creates a typed Echo client that preserves calls and errors", async () => {
  const ctx = background()
  const option = ((options: CallOptions) => options) as unknown as CallOption
  const failure = new Error("Echo unavailable")
  let rejected = false
  let observed: readonly unknown[] = Object.freeze([])
  const client = Object.freeze({
    async call(...args: readonly unknown[]) {
      observed = args
      if (rejected) throw failure
      return "pong:7"
    },
    async close(): Promise<void> {}
  }) as unknown as Client
  const { ping } = echoService.newClient(client)

  expect(await ping(ctx, option)).toBe("pong:7")
  expect(observed).toEqual([ctx, echoService.endpoints.ping, {}, option])
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
