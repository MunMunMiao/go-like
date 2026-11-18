import { expect, test } from "bun:test"

import { background } from "../../src/context"
import { newCircuitBreaker, retry } from "../../src/resilience"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  SemconvValue,
  SpanEvent,
  withTelemetry
} from "../../src/telemetry"
import { withSpan } from "../../src/telemetry/internal/state"
import { newTelemetryRecorder, type TelemetryRecorder } from "../../src/testing"
import type { Context } from "../../src/context"

const secret = "secret-retry-detail"

/** Installs one recording span so span events have a place to land. */
function operationContext(recorder: TelemetryRecorder): Context {
  const ctx = withTelemetry(background(), recorder.telemetry)
  const span = recorder.tracerProvider.startSpan(
    ctx,
    { name: "go-like", version: "0.0.1" },
    "orders/get",
    {
      kind: "internal",
      attributes: {},
      links: [],
      root: true
    }
  )
  return withSpan(ctx, span, "orders/get")
}

test("the first successful attempt records no retry", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = operationContext(recorder)
  await expect(
    retry(ctx, async () => "ok", {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry: () => true,
      backoff: () => 7
    })
  ).resolves.toBe("ok")
  expect(recorder.logs().some((item) => item.record.event === LogEvent.retryScheduled)).toBe(false)
  expect(
    recorder.measurements().some((item) => item.descriptor.name === MetricName.retryAttempts)
  ).toBe(false)
  expect(recorder.spans()[0]?.events ?? []).toEqual([])
})

test("a later attempt records the retry event, metric, and log", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = operationContext(recorder)
  let attempts = 0
  await retry(
    ctx,
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error(secret)
      return "ok"
    },
    {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry: () => true,
      backoff: () => 7
    }
  )
  const logged = recorder.logs().filter((item) => item.record.event === LogEvent.retryScheduled)
  expect(logged).toHaveLength(1)
  expect(logged[0]?.record.level).toBe("debug")
  expect(logged[0]?.record.message).toBe("retry scheduled")
  expect(logged[0]?.record.message).not.toContain(secret)
  expect(logged[0]?.record.attrs[AttributeKey.retryAttempt]).toBe(2)
  expect(logged[0]?.record.attrs[AttributeKey.retryDelayMs]).toBe(7)
  expect(logged[0]?.record.attrs.exception).toBeInstanceOf(Error)
  expect(JSON.stringify({ message: logged[0]?.record.message })).not.toContain(secret)
  const measured = recorder
    .measurements()
    .filter((item) => item.descriptor.name === MetricName.retryAttempts)
  expect(measured).toHaveLength(1)
  expect(measured[0]?.descriptor.unit).toBe("{attempt}")
  expect(measured[0]?.descriptor.attributeKeys).toEqual([AttributeKey.operation])
  expect(measured[0]?.attributes).toEqual({ [AttributeKey.operation]: "orders/get" })
  expect(measured[0]?.value).toBe(1)
  expect(recorder.spans()[0]?.events).toEqual([
    {
      name: SpanEvent.retry,
      attributes: {
        [AttributeKey.retryAttempt]: 2,
        [AttributeKey.retryDelayMs]: 7
      }
    }
  ])
})

test("a rejected retry records nothing", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = operationContext(recorder)
  await expect(
    retry(ctx, async () => Promise.reject(new Error(secret)), {
      authorization: "caller-approved",
      maxAttempts: 3,
      shouldRetry: () => false
    })
  ).rejects.toThrow(secret)
  expect(recorder.logs()).toEqual([])
  expect(recorder.measurements()).toEqual([])
  expect(recorder.spans()[0]?.events).toEqual([])
})

test("retry records nothing when telemetry is not installed", async () => {
  const recorder = newTelemetryRecorder()
  let attempts = 0
  await retry(
    background(),
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error(secret)
      return "done"
    },
    {
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry: () => true,
      backoff: () => 0
    }
  )
  expect(attempts).toBe(2)
  expect(recorder.spans()).toEqual([])
  expect(recorder.logs()).toEqual([])
  expect(recorder.measurements()).toEqual([])
})

test("a closed success records no circuit transition", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = operationContext(recorder)
  const breaker = newCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 0, name: "payments" })
  await expect(breaker.execute(ctx, async () => "ok")).resolves.toBe("ok")
  expect(
    recorder.logs().some((item) => item.record.event === LogEvent.circuitBreakerTransition)
  ).toBe(false)
  expect(
    recorder
      .measurements()
      .some((item) => item.descriptor.name === MetricName.circuitBreakerTransitions)
  ).toBe(false)
})

test("circuit transitions record open as warn and half_open and closed as info", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = operationContext(recorder)
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0, name: "payments" })
  await expect(breaker.execute(ctx, async () => Promise.reject(new Error(secret)))).rejects.toThrow(
    secret
  )
  await expect(breaker.execute(ctx, async () => "ok")).resolves.toBe("ok")
  const logged = recorder
    .logs()
    .filter((item) => item.record.event === LogEvent.circuitBreakerTransition)
  expect(logged.map((item) => item.record.level)).toEqual(["warn", "info", "info"])
  expect(logged.map((item) => item.record.message)).toEqual([
    "circuit breaker transition",
    "circuit breaker transition",
    "circuit breaker transition"
  ])
  expect(logged.map((item) => item.record.attrs[AttributeKey.circuitBreakerState])).toEqual([
    "open",
    "half_open",
    "closed"
  ])
  for (const item of logged) {
    expect(item.record.attrs[AttributeKey.circuitBreakerName]).toBe("payments")
    expect(item.record.message).not.toContain(secret)
    expect(JSON.stringify({ message: item.record.message, name: "payments" })).not.toContain(secret)
  }
  const measured = recorder
    .measurements()
    .filter((item) => item.descriptor.name === MetricName.circuitBreakerTransitions)
  expect(measured.map((item) => item.attributes)).toEqual([
    {
      [AttributeKey.operation]: "orders/get",
      [AttributeKey.circuitBreakerName]: "payments",
      [AttributeKey.circuitBreakerState]: "open"
    },
    {
      [AttributeKey.operation]: "orders/get",
      [AttributeKey.circuitBreakerName]: "payments",
      [AttributeKey.circuitBreakerState]: "half_open"
    },
    {
      [AttributeKey.operation]: "orders/get",
      [AttributeKey.circuitBreakerName]: "payments",
      [AttributeKey.circuitBreakerState]: "closed"
    }
  ])
  expect(measured[0]?.descriptor.unit).toBe("{transition}")
  expect(measured[0]?.descriptor.attributeKeys).toEqual([
    AttributeKey.operation,
    AttributeKey.circuitBreakerName,
    AttributeKey.circuitBreakerState
  ])
  expect(measured.every((item) => item.value === 1)).toBe(true)
  expect(recorder.spans()[0]?.events.map((event) => event.name)).toEqual([
    SpanEvent.circuitBreakerTransition,
    SpanEvent.circuitBreakerTransition,
    SpanEvent.circuitBreakerTransition
  ])
  expect(
    recorder.spans()[0]?.events.map((event) => event.attributes[AttributeKey.circuitBreakerName])
  ).toEqual(["payments", "payments", "payments"])
  expect(
    recorder.spans()[0]?.events.map((event) => event.attributes[AttributeKey.circuitBreakerState])
  ).toEqual(["open", "half_open", "closed"])
})

test("an unnamed breaker uses _OTHER and records nothing without telemetry", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const named = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 })
  await expect(
    named.execute(traced, async () => Promise.reject(new Error(secret)))
  ).rejects.toThrow(secret)
  const logged = recorder
    .logs()
    .filter((item) => item.record.event === LogEvent.circuitBreakerTransition)
  expect(logged).toHaveLength(1)
  expect(logged[0]?.record.attrs[AttributeKey.circuitBreakerName]).toBe(SemconvValue.other)
  expect(logged[0]?.record.attrs[AttributeKey.circuitBreakerState]).toBe("open")
  expect(
    recorder
      .measurements()
      .find((item) => item.descriptor.name === MetricName.circuitBreakerTransitions)?.attributes[
      AttributeKey.operation
    ]
  ).toBe(SemconvValue.other)

  recorder.reset()
  const silent = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0, name: "payments" })
  await expect(
    silent.execute(background(), async () => Promise.reject(new Error(secret)))
  ).rejects.toThrow(secret)
  await expect(silent.execute(background(), async () => "ok")).resolves.toBe("ok")
  expect(recorder.spans()).toEqual([])
  expect(recorder.logs()).toEqual([])
  expect(recorder.measurements()).toEqual([])
})
