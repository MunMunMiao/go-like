import { AsyncLocalStorage } from "node:async_hooks"
import { expect, test } from "bun:test"

import { background, canceled, type Context } from "../../src/context"
import { newDiscoveryResolver } from "../../src/registry/resolver"
import type { ServiceInstance, Watcher } from "../../src/registry/types"
import {
  AttributeKey,
  LogEvent,
  LogField,
  MetricName,
  newTelemetry,
  withTelemetry
} from "../../src/telemetry"
import { newTelemetryRecorder } from "../../src/testing"
import { beginCoreUnit } from "../../src/telemetry/internal/instrument"
import { spanFromContext } from "../../src/trace"

const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "1",
  metadata: {},
  endpoints: ["http://127.0.0.1:9/"]
}

const secret = "secret-watch-detail"

/** Waits until the predicate holds. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("watch record did not arrive")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("a watcher stop failure is terminal and is not recorded twice", async () => {
  const discovery = {
    async getService(): Promise<readonly ServiceInstance[]> {
      return [instance]
    },
    async watch(): Promise<{
      next(): Promise<readonly ServiceInstance[]>
      stop(): Promise<void>
    }> {
      return {
        next(): Promise<readonly ServiceInstance[]> {
          return Promise.reject(new Error("watch failed"))
        },
        stop(): Promise<void> {
          return Promise.reject(new Error("stop failed"))
        }
      }
    }
  }
  const resolver = newDiscoveryResolver(discovery)
  await resolver.getService(background(), "orders")
  await new Promise((resolve) => setTimeout(resolve, 20))
  await expect(resolver.close(background())).rejects.toThrow()
})

/** One discovery double whose first watch event updates and whose second fails. */
function watchedDiscovery(fail: boolean): {
  getService(): Promise<readonly ServiceInstance[]>
  watch(): Promise<Watcher>
} {
  let phase = 0
  return {
    async getService(): Promise<readonly ServiceInstance[]> {
      return [instance]
    },
    async watch(): Promise<Watcher> {
      return {
        next(): Promise<readonly ServiceInstance[]> {
          phase += 1
          if (phase === 1) return Promise.resolve([instance])
          if (fail) return Promise.reject(new Error(secret))
          return new Promise(() => {})
        },
        stop(): Promise<void> {
          return Promise.resolve()
        }
      }
    }
  }
}

test("a registry watch records the update and the runtime failure, and no span", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const resolver = newDiscoveryResolver(watchedDiscovery(true))
  try {
    await resolver.getService(traced, "orders")
    await until(() =>
      recorder.logs().some((item) => item.record.event === LogEvent.registryWatchFailed)
    )
    expect(recorder.spans()).toEqual([])
    const updated = recorder
      .logs()
      .filter((item) => item.record.event === LogEvent.registryWatchUpdated)
    expect(updated).toHaveLength(1)
    expect(updated[0]?.record.level).toBe("debug")
    expect(updated[0]?.record.message).toBe("registry watch updated")
    expect(updated[0]?.record.attrs[AttributeKey.registryService]).toBe("orders")
    expect(updated[0]?.record.attrs[AttributeKey.registryInstances]).toBe(1)
    const failed = recorder
      .logs()
      .filter((item) => item.record.event === LogEvent.registryWatchFailed)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.record.level).toBe("warn")
    expect(failed[0]?.record.message).toBe("registry watch failed")
    expect(failed[0]?.record.message).not.toContain(secret)
    expect(failed[0]?.record.attrs[LogField.exception]).toBeInstanceOf(Error)
    expect(JSON.stringify({ message: failed[0]?.record.message })).not.toContain(secret)
    const measured = recorder
      .measurements()
      .filter((item) => item.descriptor.name === MetricName.registryWatchUpdates)
    expect(measured.map((item) => item.attributes)).toEqual([
      { [AttributeKey.registryService]: "orders" },
      { [AttributeKey.registryService]: "orders", [AttributeKey.errorType]: "Error" }
    ])
    expect(measured[0]?.descriptor.unit).toBe("{update}")
    expect(measured[0]?.descriptor.attributeKeys).toEqual([
      AttributeKey.registryService,
      AttributeKey.errorType
    ])
    expect(measured.every((item) => item.value === 1)).toBe(true)
  } finally {
    await resolver.close(background())
  }
})

test("a registry watch records nothing when telemetry is not installed", async () => {
  const recorder = newTelemetryRecorder()
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(" "))
  }
  const resolver = newDiscoveryResolver(watchedDiscovery(true))
  try {
    await resolver.getService(background(), "orders")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(recorder.spans()).toEqual([])
    expect(recorder.logs()).toEqual([])
    expect(recorder.measurements()).toEqual([])
    expect(lines.join("\n")).not.toContain(secret)
    expect(lines.join("\n")).not.toContain(LogEvent.registryWatchFailed)
  } finally {
    console.error = original
    await resolver.close(background())
  }
})

test("resolver admission clears the caller's implicit span for the whole owner open", async () => {
  const storage = new AsyncLocalStorage<string | null>()
  const recorder = newTelemetryRecorder()
  const tel = newTelemetry({
    tracerProvider: {
      ...recorder.tracerProvider,
      enter(ctx, fn) {
        return storage.run(explicitSpan(ctx), fn)
      }
    },
    meterProviders: [recorder.meterProvider],
    logHandlers: [recorder.logHandler],
    completionLogs: "all"
  })
  const seen: Array<{ stage: string; explicit: string | null; implicit: string | null }> = []
  /** Records the explicit Context span and the implicit store at one admission step. */
  function note(stage: string, ctx: Context): void {
    seen.push({ stage, explicit: explicitSpan(ctx), implicit: storage.getStore() ?? null })
  }
  let watches = 0
  const resolver = newDiscoveryResolver({
    async watch(ctx: Context): Promise<Watcher> {
      watches += 1
      note("watch.open", ctx)
      await Promise.resolve()
      note("watch.after-await", ctx)
      return {
        next(nextCtx: Context): Promise<readonly ServiceInstance[]> {
          note("watch.next", nextCtx)
          return new Promise((_resolve, reject) => {
            const signal = nextCtx.done()
            if (signal?.aborted === true) {
              reject(canceled)
              return
            }
            signal?.addEventListener("abort", () => reject(canceled), { once: true })
          })
        },
        async stop(): Promise<void> {}
      }
    },
    async getService(ctx: Context): Promise<readonly ServiceInstance[]> {
      note("getService", ctx)
      return []
    }
  })
  const traced = withTelemetry(background(), tel)
  const outer = beginCoreUnit(traced, {
    kind: "rpc.client",
    system: "go_like",
    method: "orders/get",
    stream: false
  })
  const caller = "caller-span"
  try {
    await storage.run(caller, async function underCaller(): Promise<void> {
      await outer.run(async function call(): Promise<void> {
        await resolver.getService(outer.ctx, "orders")
        await resolver.getService(outer.ctx, "orders")
      })
      expect(storage.getStore()).toBe(caller)
    })
    expect(storage.getStore()).toBeUndefined()
    await until(() => seen.some((item) => item.stage === "watch.next"))
    expect(watches).toBe(1)
    expect(seen.map((item) => item.stage)).toEqual([
      "watch.open",
      "watch.after-await",
      "getService",
      "watch.next"
    ])
    for (const item of seen) {
      expect(item.explicit).toBeNull()
      expect(item.implicit).toBeNull()
    }
    expect(explicitSpan(outer.ctx)).not.toBeNull()
  } finally {
    outer.end()
    await resolver.close(background())
  }
})

/** Reads a real span id, treating the all-zero placeholder as no span. */
function explicitSpan(ctx: Context): string | null {
  const id = spanFromContext(ctx).spanContext().spanId
  return /^0+$/.test(id) ? null : id
}
