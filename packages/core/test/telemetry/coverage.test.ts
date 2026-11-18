import { expect, test } from "bun:test"

import { background, canceled, withCancel } from "../../src/context/index"
import type { LogHandler } from "../../src/log/index"
import { info, withLogAttrs } from "../../src/log/index"
import { newCounter } from "../../src/metric/index"
import { closedResourceFailure, newResourceServer } from "../../src/lifecycle/resource-server"
import { newWakeup, runResident } from "../../src/resident/index"
import { LogEvent, newTelemetry, withTelemetry } from "../../src/telemetry/index"
import { whenTelemetryAdmitted } from "../../src/telemetry/bundle"
import { endAtBodyEnd } from "../../src/telemetry/internal/body"
import { carrierReader, injectHeaders } from "../../src/telemetry/internal/carriers"
import { logEvent, recordEvent } from "../../src/telemetry/internal/events"
import { classifyUnit, completionAllowed } from "../../src/telemetry/internal/outcome"
import {
  enterScope,
  ignoredRequest,
  logCorrelation,
  logLevelEnabled,
  spanFromContext,
  withRemoteSpanContext,
  withSpan
} from "../../src/telemetry/internal/state"
import { beginCoreUnit, unitSpanContext } from "../../src/telemetry/internal/units"
import { newTelemetryRecorder } from "../../src/testing/index"
import { recorderContext } from "../../src/testing/recorder"
import {
  inSpan,
  newTraceContextPropagator,
  type Span,
  type SpanContext
} from "../../src/trace/index"

const traceId = "0123456789abcdef0123456789abcdef"
const spanId = "0123456789abcdef"
const remote: SpanContext = Object.freeze({
  traceId,
  spanId,
  traceFlags: 1,
  traceState: "",
  isRemote: true
})

test("telemetry bundles cover admission races and stop failures", async () => {
  await expect(
    newTelemetry({
      propagator: null,
      logHandlers: [
        {
          enabled: () => false,
          handle() {},
          lifecycle: {
            start: () => Promise.reject(new Error("only failed")),
            stop: () => Promise.resolve()
          }
        }
      ]
    }).start(background())
  ).rejects.toThrow("only failed")

  const rolled = newTelemetry({
    propagator: null,
    logHandlers: [
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => Promise.resolve(),
          stop: () => rejectLater("rollback failed")
        }
      },
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => Promise.reject(new Error("second failed")),
          stop: () => Promise.resolve()
        }
      }
    ]
  })
  const rolledFailure: unknown = await rolled.start(background()).then(
    () => {
      throw new Error("expected telemetry start to fail")
    },
    (error: unknown) => error
  )
  expect(rolledFailure).toBeInstanceOf(AggregateError)
  if (!(rolledFailure instanceof AggregateError)) return
  expect(rolledFailure.message).toBe("telemetry start failed")
  expect(
    rolledFailure.errors.map((item) => (item instanceof Error ? item.message : String(item)))
  ).toEqual(["second failed", "rollback failed"])

  const late = newTelemetry({
    propagator: null,
    logHandlers: [lifecycleHandler(() => rejectLater("late failed"))]
  })
  const lateRun = late.start(background())
  void lateRun.catch(() => {})
  await whenTelemetryAdmitted(late)
  await expect(lateRun).rejects.toThrow("late failed")

  await expect(
    newTelemetry({
      propagator: null,
      tracerProvider: {
        startSpan() {
          throw new Error("unused")
        },
        lifecycle: {
          start() {
            throw new Error("sync start")
          },
          stop: () => Promise.resolve()
        }
      }
    }).start(background())
  ).rejects.toThrow("sync start")

  const syncStop = newTelemetry({
    propagator: null,
    logHandlers: [
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => Promise.resolve(),
          stop() {
            throw new Error("sync stop")
          }
        }
      }
    ]
  })
  await syncStop.start(background())
  await expect(syncStop.stop(background())).rejects.toThrow("sync stop")

  const asyncStop = newTelemetry({
    propagator: null,
    logHandlers: [
      lifecycleHandler(
        () => Promise.resolve(),
        () => rejectLater("async stop")
      )
    ]
  })
  await asyncStop.start(background())
  await expect(asyncStop.stop(background())).rejects.toThrow("async stop")

  const bothStops = newTelemetry({
    propagator: null,
    logHandlers: [
      lifecycleHandler(
        () => Promise.resolve(),
        () => Promise.reject(new Error("stop a"))
      ),
      lifecycleHandler(
        () => Promise.resolve(),
        () => Promise.reject(new Error("stop b"))
      )
    ]
  })
  await bothStops.start(background())
  const stopFailure: unknown = await bothStops.stop(background()).then(
    () => {
      throw new Error("expected telemetry stop to fail")
    },
    (error: unknown) => error
  )
  expect(stopFailure).toBeInstanceOf(AggregateError)
  if (stopFailure instanceof AggregateError) {
    expect(stopFailure.message).toBe("telemetry stop failed")
    expect(
      stopFailure.errors.map((item) => (item instanceof Error ? item.message : String(item)))
    ).toEqual(["stop a", "stop b"])
  }

  let rejectNative: (error: Error) => void = () => {}
  const native = newTelemetry({
    propagator: null,
    logHandlers: [
      lifecycleHandler(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectNative = reject
          })
      )
    ]
  })
  const nativeRunning = native.start(background())
  await whenTelemetryAdmitted(native)
  rejectNative(new Error("native down"))
  await expect(nativeRunning).rejects.toThrow("native down")

  let opened: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    opened = resolve
  })
  const racing = newTelemetry({
    propagator: null,
    logHandlers: [
      lifecycleHandler(() => {
        opened()
        return new Promise(() => {})
      })
    ]
  })
  const racingRun = racing.start(background())
  void racingRun.catch(() => {})
  await gate
  await racing.stop(background())
  await expect(racingRun).rejects.toMatchObject({ code: "GO_LIKE_TELEMETRY_ALREADY_STARTED" })

  let rejectDrained: (error: Error) => void = () => {}
  const drained = newTelemetry({
    propagator: null,
    logHandlers: [
      lifecycleHandler(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDrained = reject
          }),
        () => {
          rejectDrained(new Error("closed during drain"))
          return Promise.resolve()
        }
      )
    ]
  })
  const drainedRun = drained.start(background())
  await whenTelemetryAdmitted(drained)
  await drained.stop(background())
  await expect(drainedRun).resolves.toBeUndefined()

  expect(() => withTelemetry(background(), { start() {}, stop() {} } as never)).toThrow(TypeError)
  expect(() => newTelemetry({ tracerProvider: {} as never })).toThrow(TypeError)
  expect(() =>
    newTelemetry({ tracerProvider: { startSpan() {}, lifecycle: null } as never })
  ).toThrow(TypeError)
})

test("a successful config reload records the reloaded event", () => {
  const recorder = newTelemetryRecorder({ completionLogs: "all" })
  const scope = beginCoreUnit(withTelemetry(background(), recorder.telemetry), {
    kind: "config.reload",
    loadLink: null
  })
  scope.end()
  expect(recorder.logs().some((item) => item.record.event === LogEvent.configReloaded)).toBe(true)
})

test("units, logs, metrics, and propagation cover plug faults", async () => {
  const quiet = spanFromContext(background())
  quiet.setAttributes({})
  quiet.addEvent("ignored")
  quiet.setStatus("unset")
  quiet.recordError(new Error("ignored"))
  quiet.end()

  const stored = spanFromContext(withRemoteSpanContext(background(), remote))
  expect(stored.isRecording()).toBe(false)
  stored.setAttributes({})
  stored.addEvent("remote")
  stored.setStatus("error")
  stored.recordError(new Error("remote"))
  stored.end()

  expect(completionAllowed("failures", "rpc.client", "success")).toBe(false)
  expect(completionAllowed("failures", "rpc.client", "failure")).toBe(true)
  expect(classifyUnit("rpc.client", { error: canceled }, background()).level).toBe("debug")

  const propagatorOnly = withTelemetry(background(), newTelemetry({}))
  beginCoreUnit(propagatorOnly, { kind: "app.start" }).end()

  const throwingTracer = newTelemetry({
    propagator: null,
    tracerProvider: {
      startSpan() {
        throw new Error("start failed")
      }
    }
  })
  const failedSpan = beginCoreUnit(withTelemetry(background(), throwingTracer), {
    kind: "app.start"
  })
  failedSpan.end()
  expect(unitSpanContext(failedSpan)).toBeNull()

  const exploding = newTelemetry({
    propagator: null,
    tracerProvider: {
      startSpan() {
        return muteSpan(() => {
          throw new Error("identity")
        })
      }
    }
  })
  const exploded = beginCoreUnit(withTelemetry(background(), exploding), { kind: "config.load" })
  expect(unitSpanContext(exploded)).toBeNull()
  exploded.end()

  const throwingPropagator = newTelemetry({
    propagator: {
      fields: () => ["traceparent"],
      inject() {
        throw new Error("inject")
      },
      extract() {
        throw new Error("extract")
      }
    }
  })
  const propagated = withTelemetry(background(), throwingPropagator)
  beginCoreUnit(
    propagated,
    { kind: "http.server", method: "GET", scheme: "https" },
    { traceparent: "bad" }
  )
  beginCoreUnit(
    propagated,
    { kind: "rpc.server", system: "go_like", method: "Get", stream: false },
    { traceparent: "bad" }
  )
  injectHeaders(propagated, new Headers())
  beginCoreUnit(
    withSpan(
      propagatorOnly,
      muteSpan(() => {
        throw new Error("explicit")
      }),
      null
    ),
    { kind: "rpc.server", system: "go_like", method: "Get", stream: false },
    null
  )

  const remoteThrow = newTelemetry({
    propagator: {
      fields: () => [],
      inject() {},
      extract(ctx) {
        return withSpan(
          ctx,
          muteSpan(() => {
            throw new Error("remote")
          }),
          null
        )
      }
    }
  })
  beginCoreUnit(
    withTelemetry(background(), remoteThrow),
    {
      kind: "messaging.process",
      system: "nats",
      destination: "jobs",
      subscription: "jobs",
      bodySize: 0
    },
    { traceparent: "present" }
  )

  const failingEnd = newTelemetry({
    propagator: null,
    tracerProvider: {
      startSpan() {
        return {
          ...muteSpan(() => remote),
          end() {
            throw new Error("end")
          }
        }
      }
    }
  })
  beginCoreUnit(withTelemetry(background(), failingEnd), {
    kind: "app.stop",
    reason: "requested",
    startLink: null
  }).end({
    error: new Error("stop")
  })

  const yes = newTelemetry({ propagator: null, ignoreRequest: () => true })
  const no = newTelemetry({
    propagator: null,
    ignoreRequest: () => {
      throw new Error("ignore")
    }
  })
  const request = new Request("https://example.test/health")
  expect(ignoredRequest(withTelemetry(background(), yes), request)).toBe(true)
  expect(ignoredRequest(withTelemetry(background(), no), request)).toBe(false)

  const logs = withTelemetry(
    background(),
    newTelemetry({ propagator: null, logHandlers: [plainHandler()] })
  )
  expect(
    logCorrelation(
      withSpan(
        logs,
        muteSpan(() => {
          throw new Error("correlation")
        }),
        null
      )
    )
  ).toBeNull()
  expect(() => withLogAttrs(logs, null as never)).toThrow(TypeError)
  info(withLogAttrs(logs, { request_id: "inline" }), "inline")
  const brokenAttrs = withTelemetry(
    background(),
    newTelemetry({
      propagator: null,
      logHandlers: [
        { ...plainHandler(), withAttrs: () => null as never },
        {
          ...plainHandler(),
          withAttrs() {
            throw new Error("attrs")
          }
        }
      ]
    })
  )
  info(withLogAttrs(brokenAttrs, { request_id: "kept" }), "kept")

  const gated = withTelemetry(
    background(),
    newTelemetry({
      propagator: null,
      logHandlers: [
        {
          enabled() {
            throw new Error("gate")
          },
          handle() {}
        },
        {
          enabled: () => true,
          handle() {
            throw new Error("handle")
          }
        }
      ]
    })
  )
  info(gated, "delivered")
  expect(logLevelEnabled(gated, "info")).toBe(true)
  const silent = withTelemetry(
    background(),
    newTelemetry({ propagator: null, logHandlers: [{ enabled: () => false, handle() {} }] })
  )
  info(silent, "dropped")
  expect(logLevelEnabled(silent, "error")).toBe(false)

  const active = withTelemetry(
    background(),
    newTelemetry({ propagator: null, logHandlers: [plainHandler()] })
  )
  recordEvent(active, { kind: "unknown" } as never)
  recordEvent(
    withSpan(
      active,
      {
        ...muteSpan(() => remote),
        isRecording: () => true,
        addEvent() {
          throw new Error("event")
        }
      },
      null
    ),
    { kind: "server.failed", tier: "server", index: 0, error: new Error("down") }
  )
  const original = console.error
  console.error = () => {
    throw new Error("console")
  }
  try {
    recordEvent(background(), {
      kind: "server.failed",
      tier: "server",
      index: 0,
      error: new Error("down")
    })
    logEvent(background(), "error", "go_like.server.failed", "server failed")
  } finally {
    console.error = original
  }

  const recording = newTelemetry({
    propagator: null,
    meterProviders: [
      {
        instrument() {
          return {
            record() {
              throw new Error("record")
            }
          }
        }
      }
    ]
  })
  newCounter("coverage.records", {
    attributeKeys: ["tags", "word", "flag", "bad", "n", "mixed"] as const
  }).add(withTelemetry(background(), recording), 1, {
    tags: ["a", true, 1],
    word: "ok",
    flag: false,
    bad: { no: true },
    n: Number.POSITIVE_INFINITY,
    mixed: [1, Number.NaN]
  } as never)
  const invalid = newTelemetry({
    propagator: null,
    meterProviders: [
      {
        instrument() {
          return { record: "no" } as never
        }
      }
    ]
  })
  const invalidCounter = newCounter("coverage.invalid")
  invalidCounter.add(withTelemetry(background(), invalid), 1)
  invalidCounter.add(withTelemetry(background(), invalid), 1)

  const bridge = newTelemetry({
    propagator: null,
    tracerProvider: {
      startSpan() {
        return muteSpan(() => remote)
      },
      enter(_ctx, fn) {
        fn()
        throw new Error("enter after")
      }
    }
  })
  expect(() => enterScope(withTelemetry(background(), bridge), () => 1)).toThrow("enter after")
  await inSpan(
    withTelemetry(
      background(),
      newTelemetry({
        propagator: null,
        tracerProvider: {
          startSpan() {
            return {
              ...muteSpan(() => remote),
              isRecording: () => true,
              end() {
                throw new Error("user end")
              }
            }
          }
        }
      })
    ),
    "user",
    () => 1
  )

  const w3c = newTraceContextPropagator()
  w3c.inject(
    withSpan(
      background(),
      muteSpan(() => {
        throw new Error("inject span")
      }),
      null
    ),
    { set() {} }
  )
  expect(
    w3c.extract(background(), {
      get() {
        throw new Error("read")
      },
      keys: () => []
    })
  ).toBeTypeOf("object")
  let reads = 0
  w3c.extract(background(), {
    get(key) {
      reads += 1
      if (key === "tracestate") throw new Error("state")
      return `00-${traceId}-${spanId}-01`
    },
    keys: () => ["traceparent"]
  })
  expect(reads).toBeGreaterThan(0)

  const headers = new Headers({ traceparent: "stale", other: "kept" })
  expect(carrierReader(headers).keys()).toContain("traceparent")
  expect(carrierReader({ Other: 1 as never }).get("other")).toBeNull()
  expect(carrierReader({ Other: "kept" }).get("missing")).toBeNull()
  expect(carrierReader({ Other: "kept" }).keys()).toEqual(["Other"])
})

test("the recorder covers identity faults, reset, and recordError", () => {
  const recorder = newTelemetryRecorder()
  const parent = recorder.tracerProvider.startSpan(background(), { name: "coverage" }, "parent", {
    kind: "internal",
    attributes: {},
    links: [],
    root: true
  })
  parent.recordError(new Error("kept off the message"))
  const valid = parent.spanContext()
  recorder.tracerProvider.startSpan(
    withSpan(
      background(),
      muteSpan(() => {
        throw new Error("carried")
      }),
      null
    ),
    {
      name: "coverage"
    },
    "child",
    { kind: "internal", attributes: {}, links: [], root: false }
  )

  let parentReads = 0
  recorder.tracerProvider.startSpan(
    withSpan(
      background(),
      muteSpan(() => {
        parentReads += 1
        if (parentReads > 1) throw new Error("second")
        return valid
      }),
      null
    ),
    { name: "coverage" },
    "flaky",
    { kind: "internal", attributes: {}, links: [], root: false }
  )
  let activeReads = 0
  info(
    withSpan(
      withTelemetry(background(), recorder.telemetry),
      muteSpan(() => {
        activeReads += 1
        if (activeReads > 2) throw new Error("active")
        return valid
      }),
      null
    ),
    "correlated"
  )
  let implicitReads = 0
  recorder.tracerProvider.enter?.(
    withSpan(
      background(),
      muteSpan(() => {
        implicitReads += 1
        if (implicitReads > 1) throw new Error("implicit")
        return valid
      }),
      null
    ),
    () => {
      expect(
        (recorder as unknown as { implicitSpanContext(): unknown }).implicitSpanContext()
      ).toBeNull()
    }
  )
  recorder.reset()
  expect(recorder.spans()).toEqual([])
  expect(recorderContext().err()).toBeNull()
})

test("resource servers and residents cover drain and wakeup cancellation", async () => {
  expect(closedResourceFailure().code).toBe("GO_LIKE_RESOURCE_CLOSED")
  expect(() =>
    newResourceServer({
      close() {
        return Promise.resolve()
      },
      open: "no" as never
    })
  ).toThrow(TypeError)
  expect(() =>
    newResourceServer({
      close() {
        return Promise.resolve()
      },
      terminal: {} as never
    })
  ).toThrow(TypeError)

  const rejected = newResourceServer({
    async close() {
      throw new Error("close failed")
    }
  })
  await rejected.start(background())
  await expect(rejected.stop(background())).rejects.toThrow("close failed")

  const thrown = newResourceServer({
    close() {
      throw new Error("close threw")
    }
  })
  await thrown.start(background())
  await expect(thrown.stop(background())).rejects.toThrow("close threw")

  const [waitingCtx, cancelWait] = withCancel(background())
  const wakeup = newWakeup()
  const waiting = wakeup.wait(waitingCtx, 10_000)
  cancelWait()
  await expect(waiting).rejects.toBe(canceled)

  const [backoffCtx, cancelBackoff] = withCancel(background())
  setTimeout(cancelBackoff, 5)
  await runResident(
    backoffCtx,
    {
      async poll() {
        throw new Error("retry")
      },
      result() {},
      backoff: () => 50,
      retryable: () => true,
      intervalMs: 0,
      terminal() {}
    },
    newWakeup()
  )

  const [intervalCtx, cancelInterval] = withCancel(background())
  await runResident(
    intervalCtx,
    {
      async poll() {
        return 1
      },
      result() {
        cancelInterval()
      },
      backoff: () => 0,
      retryable: () => false,
      intervalMs: 1_000,
      terminal() {}
    },
    newWakeup()
  )
})

test("body end covers a locked body, a failed pull, and cancellation", async () => {
  const scope = beginCoreUnit(background(), { kind: "http.server", method: "GET", scheme: "http" })
  const locked = new Response(new ReadableStream())
  const body = locked.body
  if (body === null) throw new Error("missing body")
  Object.defineProperty(body, "getReader", {
    value() {
      throw new Error("no reader")
    }
  })
  expect(endAtBodyEnd(scope, locked)).toBe(locked)

  const pulled = endAtBodyEnd(
    beginCoreUnit(background(), { kind: "http.server", method: "GET", scheme: "http" }),
    new Response(
      new ReadableStream({
        pull() {
          throw new Error("pull failed")
        }
      })
    )
  )
  await expect(pulled.text()).rejects.toThrow("pull failed")

  const canceledBody = endAtBodyEnd(
    beginCoreUnit(background(), { kind: "http.server", method: "GET", scheme: "http" }),
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]))
        }
      })
    )
  )
  const reader = canceledBody.body?.getReader()
  if (reader === undefined) throw new Error("missing reader")
  await reader.cancel("bye")

  const aborted = new AbortController()
  aborted.abort(canceled)
  endAtBodyEnd(
    beginCoreUnit(background(), { kind: "http.server", method: "GET", scheme: "http" }),
    new Response(
      new ReadableStream({
        start() {},
        cancel() {
          return Promise.reject(new Error("cancel failed"))
        }
      })
    ),
    { signal: aborted.signal }
  )
})

/** A handler with no child logger and no lifecycle. */
function plainHandler(): LogHandler {
  return { enabled: () => true, handle() {} }
}

/** Rejects on a later turn so the caller can attach a handler first. */
function rejectLater(message: string): Promise<never> {
  return Promise.resolve().then(() => {
    throw new Error(message)
  })
}

/** A lifecycle-only handler. `start` and `stop` default to resolving. */
function lifecycleHandler(
  start: () => Promise<unknown> = () => Promise.resolve(),
  stop: () => Promise<unknown> = () => Promise.resolve()
): LogHandler {
  return {
    enabled: () => false,
    handle() {},
    lifecycle: {
      async start() {
        await start()
      },
      async stop() {
        await stop()
      }
    }
  }
}

/** A span whose only interesting method is `spanContext`. */
function muteSpan(spanContext: () => SpanContext): Span {
  return {
    spanContext,
    isRecording: () => false,
    setAttributes() {},
    addEvent() {},
    setStatus() {},
    recordError() {},
    end() {}
  }
}
