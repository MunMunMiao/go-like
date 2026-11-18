import { expect, test } from "bun:test"

import { newConfig, source, type ConfigSourceWatcher } from "../../src/config"
import { background, cause, type Context } from "../../src/context"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  SemconvValue,
  withTelemetry
} from "../../src/telemetry"
import { newTelemetryRecorder } from "../../src/testing"
import type { RecordedLog } from "../../src/testing"

const secret = "secret-config-detail"

/** Waits until the predicate holds. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("record did not arrive")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Drops trace correlation so the assertion is the unit's own attributes. */
function ownAttrs(log: RecordedLog): RecordedLog["record"]["attrs"] {
  const attrs = { ...log.record.attrs }
  delete attrs.trace_id
  delete attrs.span_id
  delete attrs.trace_flags
  return attrs
}

/** One watcher whose next resolves, rejects, or stops when its Context ends. */
function controllableWatcher(pending: Array<(error?: Error) => void>): ConfigSourceWatcher {
  return {
    next(ctx: Context): Promise<void> {
      return new Promise((resolve, reject) => {
        const signal = ctx.done()
        const abort = (): void => {
          reject(cause(ctx) ?? ctx.err() ?? new Error("watcher closed"))
        }
        if (signal !== null && signal.aborted) {
          abort()
          return
        }
        if (signal !== null) signal.addEventListener("abort", abort, { once: true })
        pending.push((error?: Error) => {
          if (signal !== null) signal.removeEventListener("abort", abort)
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
    stop(): Promise<void> {
      return Promise.resolve()
    }
  }
}

/** One source document. The secret stays in the thrown Error and out of the record. */
function document(loads: { current: number }, failAt: number) {
  return {
    name: "file",
    async load(): Promise<{ value: { ready: boolean }; revision: string }> {
      loads.current += 1
      if (loads.current === failAt) throw new Error(secret)
      return { value: { ready: true }, revision: "1" }
    }
  }
}

test("config load records success and a source failure without the error text", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const loads = { current: 0 }
  const ready = newConfig(source(document(loads, 0)))
  await ready.load(traced)
  try {
    const span = recorder.spans().find((item) => item.name === "config load")
    if (span === undefined) throw new Error("missing config load span")
    expect(span.kind).toBe("internal")
    expect(span.root).toBe(false)
    expect(span.status).toBe("unset")
    expect(span.attributes).toMatchObject({ [AttributeKey.outcome]: SemconvValue.outcomeSuccess })
    expect(span.attributes[AttributeKey.errorType]).toBeUndefined()
    expect(span.attributes[AttributeKey.durationMs]).toEqual(expect.any(Number))
    const logged = recorder.logs().filter((item) => item.record.event === LogEvent.configLoaded)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.record.level).toBe("debug")
    expect(logged[0]?.record.message).toBe(LogEvent.configLoaded)
    expect(ownAttrs(logged[0] as RecordedLog)[AttributeKey.outcome]).toBe(
      SemconvValue.outcomeSuccess
    )
    expect(recorder.measurements()).toEqual([])
  } finally {
    await ready.close(background())
  }

  recorder.reset()
  const failed = newConfig(source(document({ current: 0 }, 1)))
  await expect(failed.load(traced)).rejects.toThrow()
  const span = recorder.spans().find((item) => item.name === "config load")
  if (span === undefined) throw new Error("missing failed config load span")
  expect(span.status).toBe("error")
  expect(span.attributes).toMatchObject({
    [AttributeKey.outcome]: SemconvValue.outcomeFailure,
    [AttributeKey.errorType]: "GO_LIKE_CONFIG_SOURCE"
  })
  expect(JSON.stringify(span.attributes)).not.toContain(secret)
  const logged = recorder.logs().filter((item) => item.record.event === LogEvent.configLoaded)
  expect(logged).toHaveLength(1)
  expect(logged[0]?.record.level).toBe("warn")
  expect(logged[0]?.record.message).toBe(LogEvent.configLoaded)
  expect(logged[0]?.record.message).not.toContain(secret)
  expect(JSON.stringify(ownAttrs(logged[0] as RecordedLog))).not.toContain(secret)
})

test("config reload records success, failure, and the load link", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const loads = { current: 0 }
  const pending: Array<(error?: Error) => void> = []
  const config = newConfig(
    source({
      ...document(loads, 3),
      watch(): Promise<ConfigSourceWatcher> {
        return Promise.resolve(controllableWatcher(pending))
      }
    })
  )
  try {
    await config.load(traced)
    await until(() => pending.length > 0)
    const release = pending.shift()
    if (release === undefined) throw new Error("watcher did not start")
    release()
    await until(() => recorder.spans().some((item) => item.name === "config reload" && item.ended))
    const load = recorder.spans().find((item) => item.name === "config load")
    const reloaded = recorder.spans().filter((item) => item.name === "config reload")
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]?.root).toBe(true)
    expect(reloaded[0]?.kind).toBe("internal")
    expect(reloaded[0]?.status).toBe("unset")
    expect(reloaded[0]?.links.map((link) => link.context)).toEqual(
      load === undefined ? [] : [load.context]
    )
    expect(reloaded[0]?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeSuccess)
    const success = recorder.logs().filter((item) => item.record.event === LogEvent.configReloaded)
    expect(success).toHaveLength(1)
    expect(success[0]?.record.level).toBe("info")
    expect(success[0]?.record.message).toBe(LogEvent.configReloaded)
    const successMetric = recorder
      .measurements()
      .filter((item) => item.descriptor.name === MetricName.configReloads)
    expect(successMetric).toHaveLength(1)
    expect(successMetric[0]?.descriptor.unit).toBe("{reload}")
    expect(successMetric[0]?.descriptor.attributeKeys).toEqual([AttributeKey.errorType])
    expect(successMetric[0]?.attributes).toEqual({})
    expect(successMetric[0]?.value).toBe(1)

    await until(() => pending.length > 0)
    const again = pending.shift()
    if (again === undefined) throw new Error("watcher did not wait for the next change")
    again()
    await until(() =>
      recorder.logs().some((item) => item.record.event === LogEvent.configReloadFailed)
    )
    const failed = recorder.spans().filter((item) => item.name === "config reload" && item.ended)
    expect(failed).toHaveLength(2)
    expect(failed[1]?.status).toBe("error")
    expect(failed[1]?.attributes).toMatchObject({
      [AttributeKey.outcome]: SemconvValue.outcomeFailure,
      [AttributeKey.errorType]: "GO_LIKE_CONFIG_SOURCE"
    })
    expect(JSON.stringify(failed[1]?.attributes)).not.toContain(secret)
    const failure = recorder
      .logs()
      .filter((item) => item.record.event === LogEvent.configReloadFailed)
    expect(failure).toHaveLength(1)
    expect(failure[0]?.record.level).toBe("warn")
    expect(failure[0]?.record.message).toBe("config reload failed")
    expect(failure[0]?.record.message).not.toContain(secret)
    expect(JSON.stringify(ownAttrs(failure[0] as RecordedLog))).not.toContain(secret)
    const failedMetric = recorder
      .measurements()
      .filter((item) => item.descriptor.name === MetricName.configReloads)
    expect(failedMetric[1]?.attributes).toEqual({
      [AttributeKey.errorType]: "GO_LIKE_CONFIG_SOURCE"
    })
  } finally {
    await config.close(background())
  }
})

test("a terminal watcher failure records config.terminal and falls back without telemetry", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const terminalPending: Array<(error?: Error) => void> = []
  const installed = newConfig(
    source({
      name: "file",
      async load(): Promise<{ value: { ready: boolean }; revision: string }> {
        return { value: { ready: true }, revision: "1" }
      },
      watch(): Promise<ConfigSourceWatcher> {
        return Promise.resolve(controllableWatcher(terminalPending))
      }
    })
  )
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(" "))
  }
  try {
    await installed.load(traced)
    const fail = terminalPending.shift()
    if (fail === undefined) throw new Error("watcher did not start")
    fail(new Error(secret))
    await until(() => recorder.logs().some((item) => item.record.event === LogEvent.configTerminal))
    const logged = recorder.logs().filter((item) => item.record.event === LogEvent.configTerminal)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.record.level).toBe("error")
    expect(logged[0]?.record.message).toBe("config terminal")
    expect(logged[0]?.record.message).not.toContain(secret)
    expect(logged[0]?.record.attrs.exception).toBeInstanceOf(Error)
    expect(JSON.stringify({ message: logged[0]?.record.message })).not.toContain(secret)
    expect(lines.join("\n")).not.toContain(LogEvent.configTerminal)
  } finally {
    console.error = original
    await installed.close(background()).catch(() => {})
  }

  recorder.reset()
  const silent = newConfig(
    source({
      name: "file",
      async load(): Promise<{ value: { ready: boolean }; revision: null }> {
        return { value: { ready: true }, revision: null }
      }
    })
  )
  await silent.load(background())
  await silent.close(background())
  const failing = newConfig(
    source({
      name: "file",
      load(): Promise<never> {
        return Promise.reject(new Error(secret))
      }
    })
  )
  await expect(failing.load(background())).rejects.toThrow()
  expect(recorder.spans()).toEqual([])
  expect(recorder.logs()).toEqual([])
  expect(recorder.measurements()).toEqual([])

  const fallbackLines: string[] = []
  console.error = (...args: unknown[]): void => {
    fallbackLines.push(args.map((item) => String(item)).join(" "))
  }
  const fallbackPending: Array<(error?: Error) => void> = []
  const terminal = newConfig(
    source({
      name: "file",
      async load(): Promise<{ value: { ready: boolean }; revision: null }> {
        return { value: { ready: true }, revision: null }
      },
      watch(): Promise<ConfigSourceWatcher> {
        return Promise.resolve(controllableWatcher(fallbackPending))
      }
    })
  )
  try {
    await terminal.load(background())
    const fail = fallbackPending.shift()
    if (fail === undefined) throw new Error("watcher did not start")
    fail(new Error(secret))
    await until(() => fallbackLines.some((line) => line.includes(LogEvent.configTerminal)))
    const line = fallbackLines.find((item) => item.includes(LogEvent.configTerminal))
    if (line === undefined) throw new Error("missing terminal fallback")
    expect(JSON.parse(line)).toEqual({
      "event.name": LogEvent.configTerminal,
      "error.type": "GO_LIKE_CONFIG_SOURCE",
      "go_like.operation": SemconvValue.other
    })
    expect(line).not.toContain(secret)
    expect(recorder.logs()).toEqual([])
  } finally {
    console.error = original
    await terminal.close(background()).catch(() => {})
  }
})
