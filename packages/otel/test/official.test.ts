import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { TracerProvider } from "@opentelemetry/sdk-trace"

import { newOtelServer } from "../src/index"

test("borrows fully configured official providers without replacing their APIs", async () => {
  const resource = resourceFromAttributes({ "service.name": "native-provider-test" })
  const tracerProvider = new TracerProvider({ resource, spanProcessors: [] })
  const meterProvider = new MeterProvider({ resource, readers: [] })
  const tracer = tracerProvider.getTracer("orders")
  const meter = meterProvider.getMeter("orders")
  const server = newOtelServer({ tracerProvider, meterProvider })
  const running = server.start(background())
  await Promise.resolve()

  expect(typeof tracer.startSpan).toBe("function")
  expect(typeof meter.createCounter).toBe("function")
  expect(tracerProvider.getTracer("orders")).toBe(tracer)
  expect(meterProvider.getMeter("orders")).toBe(meter)

  await server.stop(background())
  await running
})
