import { expect, test } from "bun:test"

import { background, withCancel } from "@go-like/core/context"
import { newTelemetry, withTelemetry } from "@go-like/core/telemetry"
import { LogField } from "@go-like/core/telemetry"
import type { LogRecord } from "@go-like/core/log"
import type { Attributes, Scope } from "@go-like/core/telemetry"
import type { InstrumentDescriptor } from "@go-like/core/metric"
import type { Context as OtelContext } from "@opentelemetry/api"

import {
  newOtelLogHandler,
  newOtelMeterProvider,
  newOtelTracerProvider,
  type OtelLogHandler,
  type OtelMeterProvider,
  type OtelTracerProvider
} from "../src/index"

const scope: Scope = Object.freeze({ name: "lifecycle", version: "1" })

function tracer(
  shutdown: () => Promise<void>,
  seen: { version: string | undefined } = { version: undefined }
): OtelTracerProvider {
  return newOtelTracerProvider({
    getTracer(_name: string, version?: string) {
      seen.version = version
      return {
        startSpan() {
          return {
            spanContext: () => ({
              traceId: "0123456789abcdef0123456789abcdef",
              spanId: "0123456789abcdef",
              traceFlags: 1
            }),
            isRecording: () => true,
            setAttribute() {},
            setAttributes() {},
            addEvent() {},
            setStatus() {},
            recordException() {},
            end() {}
          }
        }
      }
    },
    shutdown
  } as never)
}

test("stop before start shuts the provider down once", async () => {
  let calls = 0
  const plug = tracer(() => {
    calls += 1
    return Promise.resolve()
  })
  await plug.lifecycle.stop(background())
  expect(calls).toBe(1)
  await plug.lifecycle.stop(background())
  expect(calls).toBe(1)
  await expect(plug.lifecycle.start(background())).rejects.toMatchObject({
    name: "OtelAlreadyStartedError",
    code: "GO_LIKE_OTEL_ALREADY_STARTED",
    status: "stopped"
  })
})

test("start admits once and a zero timeout fails the owner wait immediately", async () => {
  let resolveShutdown: () => void = () => {}
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve
  })
  const seen = { version: undefined as string | undefined }
  const plug = newOtelTracerProvider(
    {
      getTracer(_name: string, version?: string) {
        seen.version = version
        return {
          startSpan() {
            return {
              spanContext: () => ({
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "fedcba9876543210",
                traceFlags: 1,
                isRemote: false
              }),
              isRecording: () => true,
              setAttributes() {},
              addEvent() {},
              setStatus() {},
              recordException() {},
              end() {}
            }
          }
        }
      },
      shutdown: () => shutdown
    } as never,
    { shutdownTimeoutMs: 0 }
  )
  const running = plug.lifecycle.start(background())
  await Promise.resolve()
  await Promise.resolve()
  plug
    .startSpan(background(), scope, "owned", {
      kind: "client",
      attributes: Object.freeze({}),
      links: Object.freeze([]),
      root: true
    })
    .end()
  expect(seen.version).toBe("1")
  await expect(plug.lifecycle.start(background())).rejects.toMatchObject({ status: "running" })
  await expect(plug.lifecycle.stop(background())).rejects.toMatchObject({
    name: "OtelShutdownTimeoutError",
    code: "GO_LIKE_OTEL_SHUTDOWN_TIMEOUT",
    timeoutMs: 0
  })
  resolveShutdown()
  await running
  await expect(plug.lifecycle.stop(background())).rejects.toMatchObject({
    name: "OtelShutdownTimeoutError"
  })
})

test("a synchronous shutdown throw rejects stop", async () => {
  const failure = new Error("sync shutdown failed")
  const plug = tracer(() => {
    throw failure
  })
  await expect(plug.lifecycle.stop(background())).rejects.toBe(failure)
})

test("native shutdown failure rejects the owner and the start promise", async () => {
  const failure = new Error("native shutdown failed")
  const plug = tracer(() => Promise.reject(failure), { version: undefined })
  const running = plug.lifecycle.start(background())
  await Promise.resolve()
  await Promise.resolve()
  await expect(plug.lifecycle.stop(background())).rejects.toBe(failure)
  await expect(running).rejects.toBe(failure)
})

test("a positive timeout still lets the native shutdown finish", async () => {
  let resolveShutdown: () => void = () => {}
  const plug = tracer(
    () =>
      new Promise<void>((resolve) => {
        resolveShutdown = resolve
      })
  )
  const running = plug.lifecycle.start(background())
  await Promise.resolve()
  const stopping = plug.lifecycle.stop(background())
  resolveShutdown()
  await stopping
  await running
})

test("constructor rejects a bad provider, budget, or missing context manager", () => {
  expect(() => newOtelTracerProvider(null as never)).toThrow(TypeError)
  expect(() => newOtelTracerProvider({ getTracer() {}, shutdown: "no" } as never)).toThrow(
    TypeError
  )
  expect(() => newOtelMeterProvider({ getMeter() {} } as never)).toThrow(TypeError)
  expect(() => newOtelLogHandler({ shutdown() {} } as never)).toThrow(TypeError)
  expect(() =>
    newOtelTracerProvider({ getTracer() {}, shutdown() {} } as never, { shutdownTimeoutMs: -1 })
  ).toThrow(RangeError)
  expect(() =>
    newOtelMeterProvider({ getMeter() {}, shutdown() {} } as never, { shutdownTimeoutMs: 1.5 })
  ).toThrow(RangeError)
  expect(() =>
    newOtelLogHandler({ getLogger() {}, shutdown() {} } as never, {
      shutdownTimeoutMs: 2_147_483_648
    })
  ).toThrow(RangeError)
  expect(() =>
    newOtelTracerProvider({ getTracer() {}, shutdown() {} } as never, {
      requireContextManager: true
    })
  ).toThrow(TypeError)
  const [ctx, cancel] = withCancel(background())
  cancel()
  const plug = tracer(() => Promise.resolve())
  return expect(plug.lifecycle.start(ctx)).rejects.toBeTruthy()
})

test("metrics keep declared attributes and logs map values onto the native record", async () => {
  const exemplars: Array<OtelContext | undefined> = []
  const options: unknown[] = []
  let meterVersion: string | undefined
  const meter: OtelMeterProvider = newOtelMeterProvider({
    getMeter(_name: string, version?: string) {
      meterVersion = version
      return {
        createCounter(_name: string, metricOptions?: unknown) {
          options.push(metricOptions)
          return {
            add(_value: number, _attributes: unknown, exemplar?: OtelContext) {
              exemplars.push(exemplar)
            }
          }
        },
        createUpDownCounter() {
          return { add() {} }
        },
        createHistogram(_name: string, metricOptions?: unknown) {
          options.push(metricOptions)
          return { record() {} }
        },
        createGauge() {
          return { record() {} }
        }
      }
    },
    shutdown: () => Promise.resolve()
  } as never)
  const descriptor = (
    kind: InstrumentDescriptor["kind"],
    buckets: readonly number[] | null
  ): InstrumentDescriptor =>
    Object.freeze({
      kind,
      name: "orders",
      unit: "1",
      description: "Orders",
      attributeKeys: Object.freeze(["name"]),
      buckets
    })
  const counter = meter.instrument(scope, descriptor("counter", null))
  const again = meter.instrument(scope, descriptor("counter", null))
  expect(again).toBe(counter)
  expect(meterVersion).toBe("1")
  counter.record(background(), 1, { name: "kept", extra: "drop" } as Attributes)
  expect(exemplars).toEqual([undefined])
  meter.instrument(scope, descriptor("histogram", Object.freeze([1, 5])))
  expect(options[0]).toEqual({ unit: "1", description: "Orders" })
  expect(options[1]).toMatchObject({ advice: { explicitBucketBoundaries: [1, 5] } })
  await meter.lifecycle.stop(background())

  const emitted: Array<Record<string, unknown>> = []
  const logs: OtelLogHandler = newOtelLogHandler(
    {
      getLogger(name: string, version?: string) {
        expect(name).toBe("app")
        expect(version).toBe("2")
        return {
          enabled: () => false,
          emit(record: Record<string, unknown>) {
            emitted.push({ ...record })
          }
        }
      },
      shutdown: () => Promise.resolve()
    } as never,
    { scope: { name: "app", version: "2" } }
  )
  const failure = new Error("secret failure text")
  const record: LogRecord = Object.freeze({
    time: 5,
    level: "error",
    message: "failed",
    event: "go_like.server.failed",
    attrs: Object.freeze({
      note: "hello",
      tags: Object.freeze(["a"]),
      detail: Object.freeze({ code: 1, cause: failure }),
      [LogField.exception]: failure
    })
  })
  expect(logs.enabled(background(), "debug")).toBe(false)
  logs.handle(background(), record)
  expect(emitted[0]?.exception).toBe(failure)
  expect(emitted[0]?.eventName).toBe("go_like.server.failed")
  expect(emitted[0]?.body).toBe("failed")
  const attributes = emitted[0]?.attributes as Record<string, unknown>
  expect(attributes.note).toBe("hello")
  expect(attributes.tags).toEqual(["a"])
  expect(attributes.detail).toEqual({ code: 1, cause: "Error" })
  expect(JSON.stringify(attributes)).not.toContain("secret failure text")
  const tel = newTelemetry({ logHandlers: [logs] })
  void withTelemetry(background(), tel)
  await logs.lifecycle.stop(background())
})
