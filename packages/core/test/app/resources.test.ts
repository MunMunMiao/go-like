import { expect, test } from "bun:test"

import {
  afterStart,
  beforeStart,
  beforeStop,
  context,
  name,
  newApp,
  readyProbe,
  registrar,
  resources,
  server,
  startTimeout,
  stopTimeout,
  telemetry
} from "../../src/index"
import { background, deadlineExceeded, withCancel } from "../../src/context/index"
import { newProbeRegistry } from "../../src/health/index"
import { newResourceServer } from "../../src/lifecycle/index"
import type { Server } from "../../src/lifecycle/index"
import type { Registrar } from "../../src/registry/index"
import { newTelemetry } from "../../src/telemetry/index"
import { whenTelemetryAdmitted } from "../../src/telemetry/bundle"
import { AttributeKey, LogEvent } from "../../src/telemetry/semconv"
import { spanFromContext } from "../../src/trace/index"
import { newTelemetryRecorder } from "../../src/testing/index"
import { turn } from "../support/helpers"

test("awaited admission starts a worker only after its queue is ready", async () => {
  const order: string[] = []
  let ready = false
  const release = Promise.withResolvers<void>()
  const queue: Server = {
    async start() {
      order.push("queue-start")
      await release.promise
      ready = true
      order.push("queue-ready")
    },
    async stop() {
      order.push("queue-stop")
    }
  }
  const worker: Server = {
    async start() {
      order.push("worker-start")
      if (!ready) {
        const error = new Error("queue is not ready")
        Object.defineProperty(error, "name", { value: "JobStateError" })
        throw error
      }
    },
    async stop() {
      order.push("worker-stop")
    }
  }
  const app = newApp(resources(queue), server(worker))
  const running = app.run()
  await turn()
  expect(order).toEqual(["queue-start"])
  release.resolve()
  await turn()
  await turn()
  expect(order).toEqual(["queue-start", "queue-ready", "worker-start"])
  await app.stop()
  await running
  expect(order).toEqual(["queue-start", "queue-ready", "worker-start", "worker-stop", "queue-stop"])
})

test("a newResourceServer terminal fails the app", async () => {
  const terminal = Promise.withResolvers<Error>()
  let closed = 0
  const resource = newResourceServer({
    async close() {
      closed += 1
    },
    terminal: terminal.promise
  })
  const failure = new Error("connection closed")
  const app = newApp(resources(resource))
  const running = app.run()
  await turn()
  terminal.resolve(failure)
  await expect(running).rejects.toBe(failure)
  expect(closed).toBe(1)
})

test("startTimeout bounds a hanging admission and still stops the resource", async () => {
  let stopped = 0
  const resource: Server = {
    async start() {
      await new Promise(() => {})
    },
    async stop() {
      stopped += 1
    }
  }
  const app = newApp(resources(resource), startTimeout(20))
  await expect(app.run()).rejects.toBe(deadlineExceeded)
  expect(stopped).toBe(1)
})

test("stop during admission ends run", async () => {
  const entered = Promise.withResolvers<void>()
  let stopped = 0
  const resource: Server = {
    async start() {
      entered.resolve()
      await new Promise(() => {})
    },
    async stop() {
      stopped += 1
    }
  }
  const app = newApp(resources(resource))
  const running = app.run()
  await entered.promise
  await app.stop()
  await running
  expect(stopped).toBe(1)
})

test("launch-order failure no longer happens once admission is awaited", async () => {
  let ready = false
  const queue: Server = {
    async start() {
      ready = true
    },
    async stop() {}
  }
  const worker: Server = {
    async start() {
      if (!ready) {
        const error = new Error("queue is not ready")
        Object.defineProperty(error, "name", { value: "JobStateError" })
        throw error
      }
    },
    async stop() {}
  }
  const app = newApp(resources(queue), server(worker))
  const running = app.run()
  await turn()
  await app.stop()
  await running
  expect(ready).toBe(true)
})

test("readyProbe reports created, starting, ready, and stopping", async () => {
  const registry = newProbeRegistry()
  const started = Promise.withResolvers<void>()
  const releaseStart = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>()
  const releaseStop = Promise.withResolvers<void>()
  const app = newApp(
    readyProbe(registry, "app"),
    beforeStart(async () => {
      started.resolve()
      await releaseStart.promise
    }),
    beforeStop(async () => {
      stopping.resolve()
      await releaseStop.promise
    })
  )
  expect((await registry.check(background(), "ready")).checks[0]?.error?.name).toBe(
    "AppNotReadyError"
  )
  expect((await registry.check(background(), "ready")).checks[0]?.error).toMatchObject({
    code: "GO_LIKE_APP_NOT_READY",
    phase: "created"
  })
  const running = app.run()
  await started.promise
  expect((await registry.check(background(), "ready")).checks[0]?.error).toMatchObject({
    phase: "starting"
  })
  releaseStart.resolve()
  await turn()
  await turn()
  expect((await registry.check(background(), "ready")).ok).toBe(true)
  const stop = app.stop()
  await stopping.promise
  expect((await registry.check(background(), "ready")).checks[0]?.error).toMatchObject({
    phase: "stopping"
  })
  releaseStop.resolve()
  await stop
  await running
  expect((await registry.check(background(), "ready")).checks).toEqual([])
})

test("the same participant cannot be both a resource and a server", () => {
  const subject: Server = { async start() {}, async stop() {} }
  expect(() => newApp(resources(subject), server(subject))).toThrow(TypeError)
  expect(() => server(newTelemetry() as never)).toThrow("pass telemetry with telemetry(...)")
  expect(() => resources(newTelemetry() as never)).toThrow("pass telemetry with telemetry(...)")
  expect(() => newApp((() => {}) as never)).toThrow(TypeError)
})

test("kernel units record app lifecycle, registry, and server failure", async () => {
  const recorder = newTelemetryRecorder()
  let recording = false
  let spanName = ""
  const registry: Registrar = {
    async register() {},
    async deregister() {}
  }
  const ready = Promise.withResolvers<void>()
  const app = newApp(
    telemetry(recorder.telemetry),
    name("orders"),
    beforeStart((ctx) => {
      const span = spanFromContext(ctx)
      recording = span.isRecording()
      spanName = recorder.spans().at(-1)?.name ?? ""
    }),
    afterStart(() => {
      ready.resolve()
    }),
    registrar(registry),
    server({
      async start() {},
      async stop() {}
    })
  )
  const running = app.run()
  await ready.promise
  await turn()
  await app.stop()
  await running
  expect(recording).toBe(true)
  expect(spanName).toBe("app start")
  const events = recorder.logs().map((item) => item.record.event)
  expect(events).toContain(LogEvent.appStarted)
  expect(events).toContain(LogEvent.appReady)
  expect(events).toContain(LogEvent.appStopping)
  expect(events).toContain(LogEvent.appStopped)
  const readyGauge = recorder
    .measurements()
    .filter((item) => item.descriptor.name === "go_like.app.ready")
  expect(readyGauge.map((item) => item.value)).toEqual([1, 0])
  const registered = recorder.spans().find((span) => span.name === "registry register")
  expect(registered?.attributes[AttributeKey.registryService]).toBe("orders")
  expect(recorder.spans().some((span) => span.name === "registry deregister")).toBe(true)
})

test("a server failure records its tier", async () => {
  const recorder = newTelemetryRecorder()
  const failure = new Error("listener failed")
  const app = newApp(
    telemetry(recorder.telemetry),
    server({
      async start() {
        throw failure
      },
      async stop() {}
    })
  )
  await expect(app.run()).rejects.toBe(failure)
  const failed = recorder.logs().find((item) => item.record.event === LogEvent.serverFailed)
  expect(failed?.record.attrs[AttributeKey.lifecycleTier]).toBe("server")
  expect(failed?.record.attrs[AttributeKey.serverIndex]).toBe(0)
})

test("telemetry admission failure and a late terminal stay inside the lifecycle", async () => {
  const admitted = newTelemetry({
    propagator: null,
    logHandlers: [
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => rejectLater("admit failed"),
          stop: () => Promise.resolve()
        }
      }
    ]
  })
  await expect(newApp(telemetry(admitted)).run()).rejects.toThrow("admit failed")

  let rejectStart: (error: Error) => void = () => {}
  const pending = newTelemetry({
    propagator: null,
    logHandlers: [
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => {
            const pending = new Promise<void>((_resolve, reject) => {
              rejectStart = reject
            })
            void pending.catch(() => {})
            return pending
          },
          stop: () => Promise.resolve()
        }
      }
    ]
  })
  const app = newApp(telemetry(pending))
  const running = app.run()
  await whenTelemetryAdmitted(pending)
  const stopping = app.stop()
  rejectStart(new Error("late terminal"))
  await expectStop(stopping, "late terminal")
  await expectStop(running, "late terminal")
})

test("a telemetry stop failure and a timed-out terminal are reported", async () => {
  const stopping = newTelemetry({
    propagator: null,
    logHandlers: [
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => Promise.resolve(),
          async stop() {
            throw new Error("telemetry stop failed")
          }
        }
      }
    ]
  })
  const stopApp = newApp(telemetry(stopping))
  const stopRun = stopApp.run()
  await whenTelemetryAdmitted(stopping)
  await expectStop(stopApp.stop(), "telemetry stop failed")
  await expectStop(stopRun, "telemetry stop failed")

  const hanging = newTelemetry({
    propagator: null,
    logHandlers: [
      {
        enabled: () => false,
        handle() {},
        lifecycle: {
          start: () => new Promise(() => {}),
          stop: () => Promise.resolve()
        }
      }
    ]
  })
  const hangApp = newApp(telemetry(hanging), stopTimeout(20))
  const hangRun = hangApp.run()
  await whenTelemetryAdmitted(hanging)
  await expectStop(hangApp.stop(), "context deadline exceeded")
  await expectStop(hangRun, "context deadline exceeded")
})

test("resource start and stop failures stay on the lifecycle", async () => {
  await expect(
    newApp(
      resources({
        async start() {
          throw new Error("async resource")
        },
        async stop() {}
      })
    ).run()
  ).rejects.toThrow("async resource")
  await expect(
    newApp(
      resources({
        start() {
          throw "sync resource"
        },
        async stop() {}
      })
    ).run()
  ).rejects.toThrow("resource[0] start rejected with a non-Error value")

  const rejectedStop = newApp(
    resources({
      async start() {},
      async stop() {
        throw new Error("async stop")
      }
    })
  )
  const rejectedRun = rejectedStop.run()
  await turn()
  await expectStop(rejectedStop.stop(), "async stop")
  await expectStop(rejectedRun, "async stop")

  const thrownStop = newApp(
    resources({
      async start() {},
      stop() {
        throw "sync stop"
      }
    })
  )
  const thrownRun = thrownStop.run()
  await turn()
  await expectStop(thrownStop.stop(), "resource[0] stop rejected with a non-Error value")
  await expectStop(thrownRun, "resource[0] stop rejected with a non-Error value")
})

/** Asserts that a promise rejects with a message, attaching the handler immediately. */
async function expectStop(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    if (error instanceof Error) expect(error.message).toContain(message)
    return
  }
  throw new Error(`expected rejection: ${message}`)
}

test("a fulfilled resource start on an already canceled parent is still owned", async () => {
  const [parent, cancel] = withCancel(background())
  let stopped = 0
  const app = newApp(
    context(parent),
    resources({
      start() {
        cancel()
        return Promise.resolve()
      },
      async stop() {
        stopped += 1
      }
    })
  )
  await app.run()
  expect(stopped).toBe(1)
})

test("a bounded stop joins a resource start that outlives admission", async () => {
  const app = newApp(
    resources({
      start: () => new Promise(() => {}),
      async stop() {}
    }),
    startTimeout(20),
    stopTimeout(20)
  )
  await expect(app.run()).rejects.toBeTruthy()
})

test("a rejecting resource terminal fails the app", async () => {
  const terminal = Promise.withResolvers<Error | void>()
  const resource = newResourceServer({
    async close() {},
    terminal: terminal.promise
  })
  const running = newApp(resources(resource)).run()
  await turn()
  terminal.reject(new Error("terminal rejected"))
  await expect(running).rejects.toThrow("terminal rejected")
})

/** Rejects on a later turn so the caller can attach a handler first. */
function rejectLater(message: string): Promise<never> {
  return Promise.resolve().then(() => {
    throw new Error(message)
  })
}

test("readyProbe rejects an invalid registry and a failed registration", () => {
  expect(() => readyProbe(null as never)).toThrow(TypeError)
  expect(() => readyProbe({ register() {} } as never, "")).toThrow(TypeError)
  expect(() =>
    newApp(
      readyProbe({
        register() {
          throw new Error("probe failed")
        }
      } as never)
    )
  ).toThrow("probe failed")
})
