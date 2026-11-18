import { expect, test } from "bun:test"

import { background } from "../../src/context/index"
import { LogField } from "../../src/telemetry/semconv"
import {
  logHandlerConformance,
  meterProviderConformance,
  newTelemetryRecorder,
  propagatorConformance,
  tracerProviderConformance
} from "../../src/testing/index"
import { newTraceContextPropagator } from "../../src/trace/index"

test("observability conformance suites pass against the recorder and W3C", async () => {
  const recorder = newTelemetryRecorder()
  const logs = logHandlerConformance({
    newHandler: () => recorder.logHandler,
    async written() {
      return recorder.logs().map((item) => ({
        message: item.record.message,
        [LogField.event]: item.record.event,
        ...item.record.attrs
      }))
    }
  })
  const traces = tracerProviderConformance({
    provider: recorder.tracerProvider,
    implicitSpanContext: () =>
      (recorder as unknown as { implicitSpanContext(): null }).implicitSpanContext(),
    async finished() {
      return recorder.spans().flatMap((span) => {
        if (!span.ended) return []
        return [
          {
            name: span.name,
            context: span.context,
            parentSpanId: span.parent?.spanId ?? null,
            links: span.links.map((link) => link.context)
          }
        ]
      })
    }
  })
  const meters = meterProviderConformance({
    provider: recorder.meterProvider,
    async collect() {
      return recorder.measurements().map((item) => ({
        name: item.descriptor.name,
        attributes: item.attributes as Readonly<Record<string, string | number | boolean>>,
        value: item.value
      }))
    }
  })
  const propagators = propagatorConformance(() => newTraceContextPropagator())
  for (const suite of [logs, traces, meters, propagators]) {
    for (const item of suite) await item.run()
  }
  expect(recorder.measurements().some((item) => item.descriptor.buckets?.[0] === 0.005)).toBe(true)
  expect(background().err()).toBeNull()
})
