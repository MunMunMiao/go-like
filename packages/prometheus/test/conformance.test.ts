import { expect, test } from "bun:test"
import { afterStart, id, name, newApp, telemetry, version } from "@go-like/core"
import { background } from "@go-like/core/context"
import type { InstrumentDescriptor } from "@go-like/core/metric"
import { newTelemetry } from "@go-like/core/telemetry"
import { meterProviderConformance } from "@go-like/core/testing"
import { newPrometheusMeterProvider } from "@go-like/prometheus/metric"
import { Registry } from "prom-client"

const scope = Object.freeze({ name: "conformance" })

function descriptor(
  kind: InstrumentDescriptor["kind"],
  metricName: string,
  unit = "",
  attributeKeys: readonly string[] = [],
  buckets: readonly number[] | null = null,
  description = ""
): InstrumentDescriptor {
  return Object.freeze({ kind, name: metricName, unit, description, attributeKeys, buckets })
}

interface Sample {
  readonly value?: number
  readonly labels?: Readonly<Record<string, string | number>>
  readonly metricName?: string
}

interface JsonMetric {
  readonly name: string
  readonly values?: readonly Sample[]
}

test("prometheus meter provider passes the core conformance suite", async () => {
  const registry = new Registry()
  const provider = newPrometheusMeterProvider(registry)
  const names = new Map<string, string>()
  const cases = meterProviderConformance({
    provider: {
      instrument(metricScope, metric) {
        const before = new Set(registry.getMetricsAsArray().map((item) => item.name))
        const instrument = provider.instrument(metricScope, metric)
        for (const item of registry.getMetricsAsArray()) {
          if (!before.has(item.name)) names.set(item.name, metric.name)
        }
        return instrument
      },
      lifecycle: provider.lifecycle
    },
    async collect() {
      const metrics = (await registry.getMetricsAsJSON()) as readonly JsonMetric[]
      const rows = []
      for (const metric of metrics) {
        const metricName = names.get(metric.name)
        if (metricName === undefined) continue
        for (const sample of metric.values ?? []) {
          if (sample.metricName?.endsWith("_bucket") === true) continue
          if (sample.metricName?.endsWith("_count") === true) continue
          const attributes: Record<string, string | number | boolean> = {}
          for (const [key, value] of Object.entries(sample.labels ?? {})) {
            if (key === "le") continue
            attributes[key] = value
          }
          rows.push({ name: metricName, attributes, value: sample.value ?? 0 })
        }
      }
      return rows
    }
  })
  for (const item of cases) await item.run()
})

test("maps names, units, labels, and target_info into a scrape", async () => {
  const registry = new Registry()
  const provider = newPrometheusMeterProvider(registry)
  const orders = provider.instrument(
    scope,
    descriptor("counter", "orders.accepted", "1", ["service.name"], null, "Accepted orders")
  )
  const latency = provider.instrument(scope, descriptor("histogram", "rpc.server.duration", "s"))
  const size = provider.instrument(scope, descriptor("gauge", "response.size", "By"))
  const wait = provider.instrument(scope, descriptor("gauge", "queue.wait", "ms"))
  const ratio = provider.instrument(scope, descriptor("up_down_counter", "queue.depth", "1"))
  const custom = provider.instrument(
    scope,
    descriptor("counter", "work.done", "widgets", ["flags", "count", "ok"])
  )
  const braced = provider.instrument(scope, descriptor("counter", "work.started", "{requests}"))
  const already = provider.instrument(
    scope,
    descriptor("counter", "http_server_duration_seconds", "s")
  )
  const sameKind = provider.instrument(scope, descriptor("counter", "orders.accepted", "1"))
  expect(sameKind).toBe(orders)
  expect(() => provider.instrument(scope, descriptor("gauge", "requests_total", ""))).not.toThrow()
  expect(() => provider.instrument(scope, descriptor("counter", "requests_total", ""))).toThrow(
    TypeError
  )
  orders.record(background(), 2, { "service.name": "orders", extra: "drop" })
  latency.record(background(), 0.25, {})
  size.record(background(), 8, {})
  wait.record(background(), 3, {})
  ratio.record(background(), -1, {})
  custom.record(background(), 1, { flags: ["a", "b"], count: 4, ok: true })
  braced.record(background(), 1, {})
  already.record(background(), 1, {})
  provider
    .instrument(scope, descriptor("histogram", "plain.histogram", ""))
    .record(background(), 1, {})

  let body = ""
  let release = (): void => {
    throw new Error("admission did not start")
  }
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = newApp(
    name("orders"),
    version("1.2.3"),
    id("box-1"),
    telemetry(newTelemetry({ meterProviders: [provider] })),
    afterStart(async function scrape(ctx): Promise<void> {
      await provider.lifecycle.start(ctx)
      body = await registry.metrics()
      release()
    })
  )
  const running = app.run()
  await admitted
  await app.stop()
  await running
  expect(body).toContain('flags="a,b"')
  expect(body).toContain('count="4"')
  expect(body).toContain('ok="true"')
  expect(body).toContain("orders_accepted_total")
  expect(body).toContain('service_name="orders"')
  expect(body).not.toContain("extra")
  expect(body).toContain("# HELP orders_accepted_total Accepted orders")
  expect(body).toContain("rpc_server_duration_seconds")
  expect(body).toContain("response_size_bytes")
  expect(body).toContain("queue_wait_milliseconds")
  expect(body).toContain("queue_depth")
  expect(body).toContain("work_done_widgets_total")
  expect(body).toContain("work_started_total")
  expect(body).toContain("http_server_duration_seconds_total")
  expect(body).not.toContain("http_server_duration_seconds_seconds")
  expect(body).toContain("target_info")
  expect((body.match(/target_info/gu) ?? []).length).toBeGreaterThan(0)
  const names = registry.getMetricsAsArray().map((item) => item.name)
  expect(names.filter((item) => item === "target_info")).toHaveLength(1)
  expect(() => newPrometheusMeterProvider({} as never)).toThrow(TypeError)
  await expect(provider.lifecycle.stop(background())).resolves.toBeUndefined()
  await expect(provider.lifecycle.start(background())).resolves.toBeUndefined()
})
