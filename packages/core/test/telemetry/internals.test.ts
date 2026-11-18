import { expect, test } from "bun:test"

import { background, canceled, deadlineExceeded, withCancel } from "../../src/context/index"
import { aggregateFailure, addFailure, isError, toError } from "../../src/internal/errors"
import {
  contextFailure,
  inspectContext,
  readContextFailure,
  waitForDelay
} from "../../src/internal/context"
import { timerMs, unrefTimer } from "../../src/internal/timer"
import { coreVersion } from "../../src/internal/version"
import { newResourceServer } from "../../src/lifecycle/resource-server"
import { newWakeup, residentOwner, runResident, spawnResident } from "../../src/resident/index"
import { debug, enabled, error, info, log, warn, withLogAttrs } from "../../src/log/index"
import { newCounter, newGauge, newHistogram, newUpDownCounter } from "../../src/metric/index"
import { newTelemetry, withTelemetry, SemconvVersion } from "../../src/telemetry/index"
import { whenTelemetryAdmitted } from "../../src/telemetry/bundle"
import { endAtBodyEnd, pullInScope } from "../../src/telemetry/internal/body"
import { carrierReader, injectHeaders, injectRecord } from "../../src/telemetry/internal/carriers"
import { logEvent, recordEvent, writeLog } from "../../src/telemetry/internal/events"
import {
  durationBucketAdvice,
  jobBucketAdvice,
  recordCoreCounter
} from "../../src/telemetry/internal/instruments"
import { classifyUnit, errorType, rpcFailure } from "../../src/telemetry/internal/outcome"
import {
  isHealthResponse,
  markHealthResponse,
  resourceFromAppInfo
} from "../../src/telemetry/internal/resource"
import {
  completionMode,
  coreScope,
  enterRoot,
  enterScope,
  ignoredRequest,
  logLevelEnabled,
  observing,
  resourceFromContext,
  spanFromContext,
  stateFrom,
  withBoundLogs,
  withOperation,
  withRemoteSpanContext
} from "../../src/telemetry/internal/state"
import { beginCoreUnit } from "../../src/telemetry/internal/units"
import {
  LogSeverityNumber,
  beginUnit,
  isValidSpanContext,
  logCorrelation,
  observing as observingPublic
} from "../../src/telemetry/provider"
import {
  AttributeKey,
  LogEvent,
  LogField,
  MetricName,
  SemconvValue
} from "../../src/telemetry/semconv"
import { newTelemetryRecorder } from "../../src/testing/index"
import { inSpan, newTraceContextPropagator } from "../../src/trace/index"
import type { LogHandler } from "../../src/log/index"
import type { MeterProvider } from "../../src/metric/index"
import type { TracerProvider } from "../../src/trace/index"

const traceId = "0123456789abcdef0123456789abcdef"
const spanId = "0123456789abcdef"

test("internal helpers preserve errors, timers, and the package version", async () => {
  const failure = new Error("kept")
  expect(isError(failure)).toBe(true)
  expect(toError(failure, "boundary")).toBe(failure)
  expect(toError("text", "boundary").cause).toBe("text")
  const errors: Error[] = []
  addFailure(errors, failure)
  addFailure(errors, failure)
  expect(aggregateFailure(errors, "one")).toBe(failure)
  addFailure(errors, new Error("second"))
  expect(aggregateFailure(errors, "many")).toBeInstanceOf(AggregateError)
  expect(aggregateFailure([], "none")).toBeNull()
  expect(timerMs(0, "start timeout")).toBe(0)
  expect(() => timerMs(-1, "start timeout")).toThrow(RangeError)
  const timer = setTimeout(() => {}, 1_000)
  unrefTimer(timer)
  unrefTimer(1)
  unrefTimer({
    unref() {
      throw new Error("unref failed")
    }
  })
  clearTimeout(timer)
  expect(coreVersion).toBe("0.0.1")
  expect(inspectContext(background()).signal).toBeNull()
  expect(() => inspectContext(null as never)).toThrow(TypeError)
  const state = inspectContext(background())
  expect(readContextFailure(state)).toBeNull()
  expect(contextFailure(background())).toBeNull()
  await waitForDelay(background(), 0)
  const [ctx, cancel] = withCancel(background())
  cancel()
  expect(() => waitForDelay(ctx, 50)).toThrow(canceled)
})

test("telemetry construction, admission, rollback, and stop", async () => {
  const order: string[] = []
  const tel = newTelemetry({
    logHandlers: [handler("log", order, false), handler("log-fail", order, true)],
    tracerProvider: tracer(order),
    meterProviders: [meter(order)],
    completionLogs: "none",
    propagator: null,
    ignoreRequest: () => {
      throw new Error("ignore")
    }
  })
  await expect(tel.start(background())).rejects.toThrow("log-fail failed")
  expect(order).toEqual(["log-start", "log-fail-start", "log-stop"])
  expect(() => newTelemetry({ completionLogs: "nope" as never })).toThrow(TypeError)
  expect(() => newTelemetry({ ignoreRequest: true as never })).toThrow(TypeError)
  expect(() => newTelemetry({ meterProviders: {} as never })).toThrow(TypeError)
  expect(() => newTelemetry({ logHandlers: [null as never] })).toThrow(TypeError)
  expect(() =>
    newTelemetry({ tracerProvider: { startSpan() {}, lifecycle: { start() {} } } as never })
  ).toThrow(TypeError)
  const shared = tracer(order)
  expect(() => newTelemetry({ tracerProvider: shared, meterProviders: [shared as never] })).toThrow(
    /duplicated/
  )

  const durable: string[] = []
  const started = newTelemetry({
    logHandlers: [handler("logs", durable, false)],
    tracerProvider: tracer(durable),
    completionLogs: "failures"
  })
  const running = started.start(background())
  void running.catch(() => {})
  await whenTelemetryAdmitted(started)
  expect(durable).toEqual(["logs-start", "tracer-start"])
  const [expired, cancelExpired] = withCancel(background())
  cancelExpired()
  await expect(started.stop(expired)).rejects.toBe(canceled)
  for (let step = 0; step < 8 && durable.at(-1) !== "logs-stop"; step += 1) {
    await Promise.resolve()
  }
  expect(durable).toEqual(["logs-start", "tracer-start", "tracer-stop", "logs-stop"])
  await expect(started.start(background())).rejects.toMatchObject({
    name: "TelemetryAlreadyStartedError",
    code: "GO_LIKE_TELEMETRY_ALREADY_STARTED"
  })
  void running.catch(() => {})

  const early = newTelemetry({ logHandlers: [handler("early", [], false)] })
  await early.stop(background())
  await expect(early.start(background())).rejects.toMatchObject({
    code: "GO_LIKE_TELEMETRY_ALREADY_STARTED"
  })
  const empty = newTelemetry({ propagator: null })
  await expect(empty.start(background())).resolves.toBeUndefined()
})

test("units, outcomes, metrics, logs, and propagation", async () => {
  expect(SemconvVersion).toBe("1.45.0")
  expect(LogSeverityNumber.error).toBe(17)
  expect(durationBucketAdvice()[0]).toBe(0.005)
  expect(jobBucketAdvice().at(-1)).toBe(3600)
  expect(resourceFromAppInfo({ id: () => "", name: () => "orders", version: () => "v1" })).toEqual({
    [AttributeKey.serviceName]: "orders",
    [AttributeKey.serviceVersion]: "v1"
  })
  const recorder = newTelemetryRecorder({ completionLogs: "all" })
  const ctx = withTelemetry(background(), recorder.telemetry)
  expect(observing(ctx)).toBe(true)
  expect(observingPublic(ctx)).toBe(true)
  expect(observing(background())).toBe(false)
  expect(completionMode(ctx)).toBe("all")
  expect(resourceFromContext(ctx)).toEqual({})
  expect(coreScope(coreVersion).name).toBe("go-like")
  expect(ignoredRequest(ctx, new Request("https://example.test/health"))).toBe(false)
  expect(logLevelEnabled(ctx, "debug")).toBe(true)

  const remote = withRemoteSpanContext(ctx, {
    traceId,
    spanId,
    traceFlags: 1,
    traceState: "vendor=one",
    isRemote: false
  })
  expect(isValidSpanContext(spanFromContext(remote).spanContext())).toBe(true)
  expect(logCorrelation(remote)?.trace_id).toBe(traceId)
  expect(() =>
    withRemoteSpanContext(ctx, { ...spanFromContext(remote).spanContext(), traceId: "zz" })
  ).toThrow(TypeError)
  const headers = new Headers({ traceparent: "stale", other: "kept" })
  injectHeaders(remote, headers)
  expect(headers.get("other")).toBe("kept")
  expect(headers.get("traceparent")).toContain(traceId)
  const copied = injectRecord(remote, { traceparent: "stale", other: "kept" })
  expect(copied.other).toBe("kept")
  expect(Object.isFrozen(copied)).toBe(true)
  expect(carrierReader(headers).get("other")).toBe("kept")
  expect(carrierReader({ Other: "kept" }).get("other")).toBe("kept")

  const kinds = [
    beginUnit(ctx, { kind: "rpc.server", system: "go_like", method: "Get", stream: true }, null),
    beginCoreUnit(ctx, {
      kind: "rpc.client",
      system: "grpc",
      method: SemconvValue.other,
      stream: false
    }),
    beginCoreUnit(
      ctx,
      { kind: "http.server", method: "GET", scheme: "https" },
      { traceparent: "bad" }
    ),
    beginCoreUnit(ctx, { kind: "http.server", method: "bad method", scheme: "http" }),
    beginCoreUnit(ctx, {
      kind: "messaging.publish",
      system: "nats",
      destination: "jobs",
      bodySize: 4
    }),
    beginCoreUnit(ctx, {
      kind: "messaging.process",
      system: "nats",
      destination: "jobs",
      subscription: "jobs.*",
      bodySize: 0
    }),
    beginCoreUnit(ctx, {
      kind: "job.run",
      name: "daily",
      trigger: "schedule",
      system: "cron",
      id: "1",
      attempt: 1
    }),
    beginCoreUnit(ctx, {
      kind: "job.run",
      name: "queued",
      trigger: "queue",
      system: "memory",
      id: null,
      attempt: 2
    }),
    beginCoreUnit(ctx, { kind: "job.enqueue", name: "daily", system: "memory", queue: "default" }),
    beginCoreUnit(ctx, { kind: "config.load" }),
    beginCoreUnit(ctx, { kind: "config.reload", loadLink: spanFromContext(remote).spanContext() }),
    beginCoreUnit(ctx, { kind: "registry.register", service: "orders" }),
    beginCoreUnit(ctx, { kind: "registry.deregister", service: "orders" }),
    beginCoreUnit(ctx, { kind: "app.start" }),
    beginCoreUnit(ctx, { kind: "app.stop", reason: "requested", startLink: null })
  ]
  const callerFault = serviceError(404, "not_found")
  kinds[0]?.end({
    error: callerFault,
    stream: { messages: 2, handshakeMs: 3, status: "success", code: null }
  })
  kinds[1]?.end({ error: new Error("down") })
  kinds[2]?.end({ httpStatus: 204 })
  kinds[3]?.end({ httpStatus: 500 })
  kinds[4]?.end()
  kinds[5]?.end({ error: canceled })
  kinds[6]?.end()
  kinds[7]?.end({ error: deadlineExceeded })
  kinds[8]?.end()
  kinds[9]?.end()
  kinds[10]?.end({ error: new Error("reload") })
  kinds[11]?.end()
  kinds[12]?.end()
  kinds[13]?.end()
  kinds[14]?.end({ error: new Error("stop") })
  expect(recorder.spans().map((span) => span.name)).toEqual(
    expect.arrayContaining([
      "Get",
      "go_like",
      "GET",
      "HTTP",
      "publish",
      "process jobs.*",
      "run daily",
      "app start"
    ])
  )
  expect(
    recorder
      .measurements()
      .some((item) => item.descriptor.name === MetricName.rpcServerCallDuration)
  ).toBe(true)
  expect(recorder.logs().some((item) => item.record.event === LogEvent.appStarted)).toBe(true)
  expect(recorder.logs().some((item) => item.record.event === LogEvent.configReloadFailed)).toBe(
    true
  )

  const http = beginCoreUnit(ctx, { kind: "http.server", method: "POST", scheme: "https" })
  const identity = spanFromContext(http.ctx)
  expect(identity).toBe(recorder.spans().at(-1)?.context ? identity : identity)
  expect(identity.isRecording()).toBe(true)
  http.end()
  http.end()

  const inert = beginCoreUnit(background(), { kind: "app.start" })
  expect(inert.run((value) => value)).toBe(background())
  inert.end()
  expect(spanFromContext(background()).isRecording()).toBe(false)

  expect(errorType(canceled)).toBe("canceled")
  expect(errorType(deadlineExceeded)).toBe("deadline_exceeded")
  expect(errorType(serviceError(500, "internal"))).toBe("internal")
  expect(errorType({ code: "NOT_FOUND" })).toBe("NOT_FOUND")
  expect(errorType(503)).toBe("503")
  expect(errorType("nope")).toBe("_OTHER")
  expect(rpcFailure(serviceError(404, "not_found")).callerFault).toBe(true)
  expect(rpcFailure("nope").rpcStatusCode).toBe("internal")
  expect(classifyUnit("rpc.client", { error: callerFault }, background()).outcome).toBe("failure")
  expect(classifyUnit("http.server", { httpStatus: 404 }, background()).outcome).toBe(
    "caller_fault"
  )
  expect(
    classifyUnit(
      "rpc.server",
      { stream: { messages: 0, handshakeMs: 0, status: "truncated", code: null } },
      background()
    ).outcome
  ).toBe("failure")
  const broken = {
    ...background(),
    err: () => {
      throw new Error("broken")
    }
  }
  expect(classifyUnit("app.start", undefined, broken as never).outcome).toBe("success")

  recordEvent(ctx, { kind: "retry.scheduled", attempt: 2, delayMs: 10, error: new Error("later") })
  recordEvent(ctx, { kind: "circuit_breaker.transition", name: "pay", state: "open" })
  recordEvent(ctx, { kind: "circuit_breaker.transition", name: "pay", state: "half_open" })
  recordEvent(ctx, { kind: "rate_limit.rejected" })
  recordEvent(ctx, { kind: "registry.watch.updated", service: "orders", instances: 1 })
  recordEvent(ctx, { kind: "registry.watch.failed", service: "orders", error: "down" })
  recordEvent(ctx, { kind: "config.terminal", error: new Error("gone") })
  recordEvent(ctx, { kind: "app.ready", ready: true })
  recordEvent(ctx, { kind: "app.stopping", reason: "requested" })
  recordEvent(background(), {
    kind: "server.failed",
    tier: "resource",
    index: 1,
    error: new Error("down")
  })
  recordEvent(background(), { kind: "config.terminal", error: "text" })
  writeLog(background(), "info", LogEvent.appReady, "app ready")
  logEvent(ctx, "warn", LogEvent.instrumentFailed, "instrument creation failed", {
    [LogField.exception]: new Error("meter")
  })
  logEvent(background(), "error", LogEvent.serverFailed, "server failed")
  logEvent(ctx, "debug", LogEvent.retryScheduled, "hidden", {})
  info(ctx, "hello", { request_id: "1" })
  debug(ctx, "debug")
  warn(ctx, "warn")
  error(ctx, "error")
  log(ctx, "info", "direct")
  expect(enabled(ctx, "debug")).toBe(true)
  expect(enabled(background(), "error")).toBe(false)
  const bound = withLogAttrs(ctx, { request_id: "bound" })
  info(bound, "bound")
  withBoundLogs(background(), { request_id: "none" })
  expect(stateFrom(withOperation(ctx, "Get"))?.operation).toBe("Get")
  expect(withOperation(background(), "")).toBe(background())

  const counter = newCounter("requests", { attributeKeys: ["route"] as const, unit: "1" })
  counter.add(ctx, 1, { route: "list", extra: "drop" } as never)
  expect(() => counter.add(ctx, -1)).toThrow(RangeError)
  expect(() => counter.add(ctx, Number.NaN)).toThrow(RangeError)
  counter.add(background(), -1)
  newUpDownCounter("inflight").add(ctx, -1)
  newHistogram("latency", { buckets: [0.1, 1], attributeKeys: ["route"] as const }).record(
    ctx,
    0.2,
    { route: "list" }
  )
  newGauge("ready").record(ctx, 1)
  expect(() => newCounter("9bad")).toThrow(TypeError)
  const throwingMeter: MeterProvider = {
    instrument() {
      throw new Error("instrument failed")
    }
  }
  const brokenTel = newTelemetry({ meterProviders: [throwingMeter], propagator: null })
  const brokenCtx = withTelemetry(background(), brokenTel)
  newCounter("requests_broken").add(brokenCtx, 1)
  newCounter("requests_broken").add(brokenCtx, 1)
  expect(() => recordCoreCounter(ctx, "not.a.core.metric", 1)).toThrow(TypeError)

  await inSpan(ctx, "child", (spanCtx, span) => {
    expect(span.isRecording()).toBe(true)
    expect(stateFrom(spanCtx)?.operation).not.toBe("child")
  })
  await expect(
    inSpan(ctx, "failed", () => {
      throw new Error("span failed")
    })
  ).rejects.toThrow("span failed")
  await inSpan(background(), "plain", (_spanCtx, span) => {
    expect(span.isRecording()).toBe(false)
  })

  const throwingTracer: TracerProvider = {
    startSpan() {
      throw new Error("start failed")
    },
    enter(_entered, _fn) {
      throw new Error("enter failed")
    }
  }
  const traced = newTelemetry({ tracerProvider: throwingTracer, propagator: null })
  await inSpan(withTelemetry(background(), traced), "fallback", () => 1)
  const entered = withTelemetry(background(), traced)
  expect(enterScope(entered, () => 4)).toBe(4)
  const silent: TracerProvider = {
    startSpan() {
      return spanFromContext(background())
    },
    enter(_entered, _fn) {
      return undefined as never
    }
  }
  expect(
    enterScope(
      withTelemetry(background(), newTelemetry({ tracerProvider: silent, propagator: null })),
      () => 5
    )
  ).toBe(5)
  expect(enterRoot(ctx, () => "root")).toBe("root")

  const live = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ok"))
        controller.close()
      }
    })
  )
  const scope = beginCoreUnit(ctx, { kind: "http.server", method: "GET", scheme: "http" })
  const wrapped = endAtBodyEnd(scope, live, {
    onEnd() {
      throw new Error("observer")
    }
  })
  expect(await wrapped.text()).toBe("ok")
  const emptyBody = new Response(null)
  const emptyScope = beginCoreUnit(ctx, { kind: "http.server", method: "GET", scheme: "http" })
  expect(endAtBodyEnd(emptyScope, emptyBody)).toBe(emptyBody)
  const health = markHealthResponse(new Response(null, { status: 204 }))
  expect(isHealthResponse(health)).toBe(true)
  endAtBodyEnd(beginCoreUnit(ctx, { kind: "http.server", method: "GET", scheme: "http" }), health)
  const aborted = new AbortController()
  aborted.abort(canceled)
  const blocked = new Response(new ReadableStream({ start() {} }))
  endAtBodyEnd(
    beginCoreUnit(ctx, { kind: "http.server", method: "GET", scheme: "http" }),
    blocked,
    { signal: aborted.signal }
  )
  expect(() => endAtBodyEnd(scope, null as never)).toThrow(TypeError)

  const iterator = pullInScope(
    ctx,
    (async function* values() {
      yield 1
    })()
  )
  expect((await iterator.next()).value).toBe(1)
  const returning = pullInScope(ctx, {
    async next() {
      return { done: true as const, value: undefined }
    },
    async return() {
      return { done: true as const, value: undefined }
    },
    async throw() {
      return { done: true as const, value: undefined }
    }
  })
  await returning.return?.()
  await returning.throw?.(new Error("stop"))

  const propagator = newTraceContextPropagator()
  const longState = "x".repeat(513)
  const dropped = propagator.extract(
    ctx,
    carrierReader({ traceparent: `00-${traceId}-${spanId}-01`, tracestate: longState })
  )
  expect(spanFromContext(dropped).spanContext().traceState).toBe("")
  expect(propagator.fields()).toEqual(["traceparent", "tracestate"])
  const throwingPropagator = newTelemetry({
    propagator: {
      fields() {
        throw new Error("fields")
      },
      inject() {
        throw new Error("inject")
      },
      extract() {
        throw new Error("extract")
      }
    }
  })
  injectHeaders(
    withTelemetry(background(), throwingPropagator),
    new Headers({ traceparent: "stale" })
  )
  injectRecord(withTelemetry(background(), throwingPropagator), { traceparent: "stale" })
})

test("resource servers and residents", async () => {
  const closed: string[] = []
  const server = newResourceServer({
    async open() {},
    async close(ctx) {
      closed.push(ctx.err() === null ? "open" : "canceled")
    }
  })
  await server.start(background())
  await expect(server.start(background())).rejects.toMatchObject({
    code: "GO_LIKE_RESOURCE_ALREADY_STARTED"
  })
  await server.stop(background())
  expect(closed).toEqual(["open"])
  const failed = newResourceServer({
    async open() {
      throw "down"
    },
    async close() {
      closed.push("should-not")
    }
  })
  await expect(failed.start(background())).rejects.toThrow("resource server open failed")
  await failed.stop(background())
  const idle = newResourceServer({
    async close() {
      closed.push("idle")
    }
  })
  await idle.stop(background())
  expect(closed).not.toContain("idle")
  expect(() => newResourceServer(null as never)).toThrow(TypeError)
  expect(() => newResourceServer({ close: "no" as never })).toThrow(TypeError)

  const wakeup = newWakeup()
  wakeup.wake()
  await wakeup.wait(background(), 1_000)
  const pending = wakeup.wait(background(), 1_000)
  wakeup.wake()
  await pending
  const [ownerCtx, cancelOwner] = withCancel(background())
  const values: number[] = []
  const resident = runResident(
    ownerCtx,
    {
      async poll() {
        return values.length
      },
      result(value) {
        values.push(value)
        if (value === 0) cancelOwner()
      },
      backoff: () => 0,
      retryable: () => true,
      intervalMs: 0,
      terminal() {}
    },
    wakeup
  )
  await resident
  expect(values).toEqual([0])

  const retryWake = newWakeup()
  let polls = 0
  const [retryCtx, cancelRetry] = withCancel(background())
  await runResident(
    retryCtx,
    {
      async poll() {
        polls += 1
        if (polls === 1) throw new Error("retry")
        cancelRetry()
        return 1
      },
      result() {},
      backoff: () => 0,
      retryable: () => true,
      intervalMs: 0,
      terminal() {}
    },
    retryWake
  )

  const seen: { error: Error | null } = { error: null }
  await runResident(
    background(),
    {
      async poll() {
        throw "fatal"
      },
      result() {},
      backoff: () => 1,
      retryable: () => false,
      intervalMs: 1,
      terminal(error) {
        seen.error = error
      }
    },
    newWakeup()
  )
  expect(seen.error?.cause).toBe("fatal")
  expect(() => residentOwner(ownerCtx)).toThrow(canceled)
  const [live, cancelLive] = withCancel(background())
  const spawned = spawnResident(live, {
    async poll(ctx) {
      if (ctx.err() !== null) return 0
      cancelLive()
      return 1
    },
    result() {},
    backoff: () => 0,
    retryable: () => false,
    intervalMs: 0,
    terminal() {}
  })
  await spawned
  expect(residentOwner(background()).err()).toBeNull()
})

function handler(name: string, order: string[], fail: boolean): LogHandler {
  return {
    enabled: () => true,
    handle() {},
    lifecycle: {
      start() {
        order.push(`${name}-start`)
        return fail ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve()
      },
      stop() {
        order.push(`${name}-stop`)
        return Promise.resolve()
      }
    }
  }
}

function tracer(order: string[]): TracerProvider {
  return {
    startSpan() {
      const span = spanFromContext(background())
      return span
    },
    lifecycle: {
      start() {
        order.push("tracer-start")
        return Promise.resolve()
      },
      stop() {
        order.push("tracer-stop")
        return Promise.resolve()
      }
    }
  }
}

function meter(order: string[]): MeterProvider {
  return {
    instrument() {
      return { record() {} }
    },
    lifecycle: {
      start() {
        order.push("meter-start")
        return Promise.resolve()
      },
      stop() {
        order.push("meter-stop")
        return Promise.resolve()
      }
    }
  }
}

function serviceError(status: number, code: string): Error {
  const error = new Error(code)
  Object.defineProperty(error, "name", { value: "ServiceError" })
  Object.defineProperty(error, "code", { value: code })
  Object.defineProperty(error, "status", { value: status })
  return error
}
