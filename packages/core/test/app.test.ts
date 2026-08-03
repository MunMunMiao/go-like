import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import { background, canceled, deadlineExceeded, withCancel, type Context } from "@likego/context"
import type { Registrar, ServiceInstance } from "@likego/registry"
import {
  afterStart,
  afterStop,
  fromContext,
  beforeStart,
  beforeStop,
  context,
  endpoint,
  id,
  metadata,
  name,
  newApp,
  registrar,
  registrarTimeout,
  server,
  startTimeout,
  stopTimeout,
  version,
  newContext,
  type AppInfo,
  type Endpointer,
  type Server
} from "../src/index"
import { runtimeInstaller } from "../src/app"
import { deferred, turn } from "./helpers"

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs = 250
): Promise<PromiseSettledResult<T> | "test-timeout"> {
  const settled = Promise.withResolvers<PromiseSettledResult<T> | "test-timeout">()
  const timer = setTimeout(() => {
    settled.resolve("test-timeout")
  }, timeoutMs)
  operation.then(
    (value) => {
      settled.resolve({ status: "fulfilled", value })
    },
    (reason: unknown) => {
      settled.resolve({ status: "rejected", reason })
    }
  )
  try {
    return await settled.promise
  } finally {
    clearTimeout(timer)
  }
}

test("exposes Kratos-style identity accessors and AppInfo Context values", () => {
  const source = { region: "cn" }
  const app = newApp(
    id("orders-1"),
    name("orders"),
    version("1.0.0"),
    metadata(source),
    endpoint("https://orders.example")
  )
  source.region = "us"

  expect(app.id()).toBe("orders-1")
  expect(app.name()).toBe("orders")
  expect(app.version()).toBe("1.0.0")
  expect(app.metadata()).toEqual({ region: "cn" })
  expect(app.endpoint()).toEqual(["https://orders.example"])
  expect(Object.isFrozen(app.metadata())).toBe(true)
  expect(Object.isFrozen(app.endpoint())).toBe(true)

  const carried = newContext(background(), app)
  const info = fromContext(carried)
  expect(info?.id()).toBe("orders-1")
  expect(info?.name()).toBe("orders")
  expect(info?.metadata()).toEqual({ region: "cn" })
  expect(info?.endpoint()).toEqual(["https://orders.example"])
  expect(fromContext(background())).toBeNull()
})

test("preserves every own metadata key without invoking object prototype setters", () => {
  const source = Object.fromEntries([
    ["__proto__", "sentinel"],
    ["constructor", "factory"],
    ["region", "cn"]
  ])
  const captured = newApp(metadata(source)).metadata()

  expect(Object.keys(captured)).toEqual(["__proto__", "constructor", "region"])
  expect(Object.getOwnPropertyDescriptor(captured, "__proto__")?.value).toBe("sentinel")
  expect(Object.getOwnPropertyDescriptor(captured, "constructor")?.value).toBe("factory")
})

test("starts and stops structural servers concurrently through one App lifecycle", async () => {
  const events: string[] = []
  const startContexts: Context[] = []
  const stopContexts: Context[] = []
  const firstDone = deferred<void>()
  const secondDone = deferred<void>()
  const firstStopEntered = deferred<void>()
  const releaseStops = deferred<void>()
  let secondStopEntered = false
  const first: Server = {
    async start(ctx) {
      events.push("start:first")
      startContexts.push(ctx)
      await firstDone.promise
    },
    async stop(ctx) {
      events.push("stop:first")
      stopContexts.push(ctx)
      expect(ctx.err()).toBeNull()
      firstStopEntered.resolve()
      await releaseStops.promise
      firstDone.resolve()
    }
  }
  const second: Server = {
    async start(ctx) {
      events.push("start:second")
      startContexts.push(ctx)
      await secondDone.promise
    },
    async stop(ctx) {
      events.push("stop:second")
      stopContexts.push(ctx)
      expect(ctx.err()).toBeNull()
      secondStopEntered = true
      await releaseStops.promise
      secondDone.resolve()
    }
  }
  const app = newApp(
    name("orders"),
    stopTimeout(1_000),
    beforeStart(() => {
      events.push("beforeStart")
    }),
    server(first, second),
    afterStart(() => {
      events.push("afterStart")
    }),
    beforeStop(() => {
      events.push("beforeStop")
    }),
    afterStop(() => {
      events.push("afterStop")
    })
  )

  const running = app.run()
  await turn()
  expect(events).toEqual(["beforeStart", "start:first", "start:second", "afterStart"])
  expect(startContexts).toHaveLength(2)
  expect(startContexts[0]).toBe(startContexts[1])
  expect(fromContext(startContexts[0] as Context)?.name()).toBe("orders")

  const stopping = app.stop()
  expect(app.stop()).toBe(stopping)
  await firstStopEntered.promise
  await turn()
  try {
    expect(secondStopEntered).toBe(true)
  } finally {
    releaseStops.resolve()
  }
  await stopping
  await running

  expect(events).toEqual([
    "beforeStart",
    "start:first",
    "start:second",
    "afterStart",
    "beforeStop",
    "stop:first",
    "stop:second",
    "afterStop"
  ])
  expect(stopContexts).toHaveLength(2)
  expect(stopContexts[0]).toBe(stopContexts[1])
  expect(stopContexts[0]?.deadline()[1]).toBe(true)
  expect(startContexts[0]?.err()).not.toBeNull()
})

test("stop awaits afterStop under a live cleanup Context and reports its failure", async () => {
  const entered = deferred<Context>()
  const release = deferred<void>()
  const afterStopFailure = new Error("afterStop failed")
  const app = newApp(
    afterStop(async (ctx) => {
      entered.resolve(ctx)
      await release.promise
      throw afterStopFailure
    })
  )
  const running = app.run()
  void running.catch(() => {})
  await turn()

  let stopSettled = false
  const stopping = app.stop().finally(() => {
    stopSettled = true
  })
  void stopping.catch(() => {})
  const cleanupContext = await entered.promise

  try {
    expect(cleanupContext.err()).toBeNull()
    await turn()
    expect(stopSettled).toBe(false)
  } finally {
    release.resolve()
  }

  await expect(stopping).rejects.toBe(afterStopFailure)
  await expect(running).rejects.toBe(afterStopFailure)
})

test("registers one Kratos-style ServiceInstance around the Server lifecycle", async () => {
  const events: string[] = []
  const done = deferred<void>()
  const instances: ServiceInstance[] = []
  const subject: Server & Endpointer = {
    async endpoint() {
      events.push("endpoint")
      return "http://127.0.0.1:43210"
    },
    async start() {
      events.push("start")
      await done.promise
    },
    async stop() {
      events.push("stop")
      done.resolve()
    }
  }
  const registry: Registrar = {
    async register(_ctx, instance) {
      events.push("register")
      instances.push(instance)
    },
    async deregister(_ctx, instance) {
      events.push("deregister")
      expect(instance).toBe(instances[0] as ServiceInstance)
    }
  }
  const app = newApp(
    id("orders-1"),
    name("orders"),
    version("v1"),
    metadata({ region: "cn" }),
    registrar(registry),
    registrarTimeout(1_000),
    server(subject),
    afterStart(() => {
      events.push("afterStart")
    }),
    beforeStop(() => {
      events.push("beforeStop")
    })
  )

  const running = app.run()
  for (let index = 0; index < 4 && events.length < 4; index += 1) await turn()
  expect(events).toEqual(["start", "endpoint", "register", "afterStart"])
  expect(instances).toEqual([
    {
      id: "orders-1",
      name: "orders",
      version: "v1",
      metadata: { region: "cn" },
      endpoints: ["http://127.0.0.1:43210/"]
    }
  ])
  expect(app.endpoint()).toEqual(["http://127.0.0.1:43210/"])

  await app.stop()
  await running
  expect(events).toEqual([
    "start",
    "endpoint",
    "register",
    "afterStart",
    "beforeStop",
    "deregister",
    "stop"
  ])
})

test("finishes beforeStart before preparing registrar endpoints", async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const done = deferred<void>()
  const registered = deferred<void>()
  const events: string[] = []
  const subject: Server & Endpointer = {
    async endpoint() {
      events.push("endpoint")
      return "http://127.0.0.1:43210"
    },
    async start() {
      events.push("start")
      await done.promise
    },
    async stop() {
      events.push("stop")
      done.resolve()
    }
  }
  const registry: Registrar = {
    async register() {
      events.push("register")
      registered.resolve()
    },
    async deregister() {
      events.push("deregister")
    }
  }
  const app = newApp(
    name("orders"),
    registrar(registry),
    beforeStart(async () => {
      events.push("beforeStart:enter")
      entered.resolve()
      await release.promise
      events.push("beforeStart:done")
    }),
    server(subject)
  )
  const running = app.run()
  void running.catch(() => {})

  try {
    await entered.promise
    await turn()
    expect(events).toEqual(["beforeStart:enter"])

    release.resolve()
    await registered.promise
    expect(events).toEqual([
      "beforeStart:enter",
      "beforeStart:done",
      "start",
      "endpoint",
      "register"
    ])
  } finally {
    release.resolve()
    await app.stop()
    await running
  }
})

test("deregisters before canceling the Server runtime Context and stopping", async () => {
  const events: string[] = []
  const registered = deferred<void>()
  let runtimeContext: Context | null = null
  const subject: Server = {
    async start(ctx) {
      runtimeContext = ctx
      events.push("start")
      await new Promise<void>((resolve) => {
        ctx.done()?.addEventListener(
          "abort",
          () => {
            events.push("cancel")
            resolve()
          },
          { once: true }
        )
      })
    },
    async stop() {
      events.push("stop")
      expect(runtimeContext?.err()).not.toBeNull()
    }
  }
  const registry: Registrar = {
    async register() {
      events.push("register")
      registered.resolve()
    },
    async deregister() {
      events.push("deregister")
      expect(runtimeContext?.err()).toBeNull()
    }
  }
  const app = newApp(
    name("orders"),
    endpoint("http://127.0.0.1:43210"),
    registrar(registry),
    server(subject),
    beforeStop(() => {
      events.push("beforeStop")
      expect(runtimeContext?.err()).toBeNull()
    })
  )

  const running = app.run()
  await registered.promise
  await app.stop()
  await running

  expect(events).toEqual(["start", "register", "beforeStop", "deregister", "cancel", "stop"])
})

test("parent Context cancellation requests the same App stop operation", async () => {
  const [parent, cancel] = withCancel(background())
  const events: string[] = []
  const registered = deferred<void>()
  let runtimeContext: Context | null = null
  let stops = 0
  const subject: Server = {
    async start(ctx) {
      runtimeContext = ctx
      events.push("start")
      await new Promise<void>((resolve) => {
        ctx.done()?.addEventListener(
          "abort",
          () => {
            events.push("cancel")
            resolve()
          },
          { once: true }
        )
      })
    },
    async stop() {
      events.push("stop")
      stops += 1
      expect(runtimeContext?.err()).not.toBeNull()
    }
  }
  const registry: Registrar = {
    async register() {
      events.push("register")
      registered.resolve()
    },
    async deregister() {
      events.push("deregister")
      expect(runtimeContext?.err()).toBeNull()
    }
  }
  const app = newApp(
    context(parent),
    name("orders"),
    endpoint("http://127.0.0.1:43210"),
    registrar(registry),
    server(subject),
    beforeStop(() => {
      events.push("beforeStop")
      expect(runtimeContext?.err()).toBeNull()
    })
  )
  const running = app.run()
  await registered.promise

  cancel()
  await running
  expect(stops).toBe(1)
  expect(events).toEqual(["start", "register", "beforeStop", "deregister", "cancel", "stop"])
  await expect(app.run()).rejects.toThrow("only be called once")
})

test("stop before run keeps the stable stop Promise and never launches servers", async () => {
  let starts = 0
  let stops = 0
  const app = newApp(
    server({
      async start() {
        starts += 1
      },
      async stop() {
        stops += 1
      }
    })
  )

  const stopping = app.stop()
  expect(app.stop()).toBe(stopping)
  await stopping
  await app.run()

  expect(starts).toBe(0)
  expect(stops).toBe(0)
  expect(app.stop()).toBe(stopping)
})

test("stop cancels a blocking beforeStart Context before awaiting startup", async () => {
  const entered = deferred<void>()
  let hookCanceled = false
  let starts = 0
  let stops = 0
  const app = newApp(
    beforeStart(async (ctx) => {
      entered.resolve()
      const signal = ctx.done()
      if (signal === null) throw new Error("beforeStart Context must be cancelable")
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
      hookCanceled = ctx.err() !== null
    }),
    beforeStop(() => {
      expect(hookCanceled).toBe(true)
    }),
    server({
      async start() {
        starts += 1
      },
      async stop() {
        stops += 1
      }
    })
  )

  const running = app.run()
  await entered.promise
  await app.stop()
  await running

  expect(hookCanceled).toBe(true)
  expect(starts).toBe(0)
  expect(stops).toBe(0)
})

test("stop waits for beforeStart cleanup and never launches servers", async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  let resourceOpen = false
  let stopSettled = false
  let starts = 0
  let stops = 0
  const app = newApp(
    beforeStart(async () => {
      entered.resolve()
      await release.promise
      resourceOpen = true
    }),
    beforeStop(() => {
      expect(resourceOpen).toBe(true)
      resourceOpen = false
    }),
    server({
      async start() {
        starts += 1
      },
      async stop() {
        stops += 1
      }
    })
  )

  const running = app.run()
  await entered.promise
  const stopOwner = app.stop()
  const stopping = stopOwner.finally(() => {
    stopSettled = true
  })
  await turn()
  expect(stopSettled).toBe(false)
  release.resolve()
  await stopping
  await running

  expect(resourceOpen).toBe(false)
  expect(starts).toBe(0)
  expect(stops).toBe(0)
  expect(app.stop()).toBe(stopOwner)
})

test("stop during endpoint preparation drains the launched resource before resolving", async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  let bound = false
  let starts = 0
  let stops = 0
  const subject: Server & Endpointer = {
    async endpoint() {
      entered.resolve()
      await release.promise
      bound = true
      return "http://127.0.0.1:43210"
    },
    async start() {
      starts += 1
    },
    async stop() {
      if (bound) stops += 1
    }
  }
  const registry: Registrar = {
    async register() {},
    async deregister() {}
  }
  const app = newApp(name("orders"), registrar(registry), server(subject))

  const running = app.run()
  await entered.promise
  const stopping = app.stop()
  await turn()
  expect(stops).toBe(0)
  release.resolve()
  await stopping
  await running

  expect(starts).toBe(1)
  expect(stops).toBe(1)
})

test("treats app-owned startup cancellation as a clean shutdown", async () => {
  const endpointEntered = deferred<void>()
  let stops = 0
  const subject: Server & Endpointer = {
    async endpoint(ctx) {
      endpointEntered.resolve()
      const signal = ctx.done()
      if (signal === null) throw new Error("endpoint Context must be cancelable")
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
      throw canceled
    },
    async start(ctx) {
      const signal = ctx.done()
      if (signal === null) throw new Error("server Context must be cancelable")
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    },
    async stop() {
      stops += 1
    }
  }
  const registry: Registrar = {
    async register() {},
    async deregister() {}
  }
  const app = newApp(name("orders"), registrar(registry), server(subject))

  const running = app.run()
  await endpointEntered.promise
  const stopping = app.stop()

  await expect(stopping).resolves.toBeUndefined()
  await expect(running).resolves.toBeUndefined()
  expect(stops).toBe(1)
})

test("stop waits for in-flight registration and deregisters before resolving", async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const done = deferred<void>()
  const events: string[] = []
  let stopSettled = false
  const registry: Registrar = {
    async register() {
      events.push("register:enter")
      entered.resolve()
      await release.promise
      events.push("register:done")
    },
    async deregister() {
      events.push("deregister")
    }
  }
  const subject: Server = {
    async start() {
      events.push("start")
      await done.promise
    },
    async stop() {
      events.push("stop")
      done.resolve()
    }
  }
  const app = newApp(
    name("orders"),
    endpoint("http://127.0.0.1:43210"),
    registrar(registry),
    server(subject)
  )

  const running = app.run()
  await entered.promise
  const stopping = app.stop().finally(() => {
    stopSettled = true
    events.push("stop:resolved")
  })
  await turn()
  expect(stopSettled).toBe(false)
  release.resolve()
  await stopping
  await running

  expect(events).toEqual([
    "start",
    "register:enter",
    "register:done",
    "deregister",
    "stop",
    "stop:resolved"
  ])
})

test("a server start failure stops every launched server and remains primary", async () => {
  const primary = new Error("worker failed")
  const events: string[] = []
  const healthyDone = deferred<void>()
  const healthy: Server = {
    async start() {
      events.push("start:healthy")
      await healthyDone.promise
    },
    async stop() {
      events.push("stop:healthy")
      healthyDone.resolve()
    }
  }
  const failed: Server = {
    start() {
      events.push("start:failed")
      throw primary
    },
    async stop() {
      events.push("stop:failed")
    }
  }
  const app = newApp(server(healthy, failed))

  await expect(app.run()).rejects.toBe(primary)
  expect(events).toEqual(["start:healthy", "start:failed", "stop:healthy", "stop:failed"])
})

test("retains every Server.start failure settled before the terminal join deadline", async () => {
  const firstFailure = new Error("first server failed")
  const secondFailure = new Error("second server failed")
  const lateFailure = new Error("late server failure")
  const blocked = Promise.withResolvers<void>()
  const unhandled: unknown[] = []
  const observeUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on("unhandledRejection", observeUnhandled)
  let stops = 0
  const app = newApp(
    stopTimeout(5),
    server(
      {
        async start() {
          throw firstFailure
        },
        async stop() {
          stops += 1
        }
      },
      {
        async start() {
          throw secondFailure
        },
        async stop() {
          stops += 1
        }
      },
      {
        async start() {
          await blocked.promise
        },
        async stop() {
          stops += 1
        }
      }
    )
  )
  const running = app.run()

  try {
    const outcome = await settleWithin(running)
    expect(outcome).not.toBe("test-timeout")
    if (outcome === "test-timeout" || outcome.status === "fulfilled") {
      throw new Error("run must reject")
    }
    expect(outcome.reason).toBeInstanceOf(AggregateError)
    expect((outcome.reason as AggregateError).errors).toEqual([
      firstFailure,
      deadlineExceeded,
      secondFailure
    ])
    expect(stops).toBe(3)

    blocked.reject(lateFailure)
    await turn()
    expect(unhandled).toEqual([])
    expect(await settleWithin(running)).toEqual(outcome)
  } finally {
    blocked.reject(lateFailure)
    await app.stop().catch(() => {})
    await running.catch(() => {})
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("preserves a cross-realm Error rejected by a lifecycle boundary", async () => {
  const failure = runInNewContext('new Error("foreign lifecycle failure")') as Error
  const app = newApp(
    beforeStart(() => {
      throw failure
    })
  )

  expect(failure instanceof Error).toBe(false)
  await expect(app.run()).rejects.toBe(failure)
})

test("observes a server rejection while later startup phases are pending", async () => {
  const failure = new Error("start failed")
  const unhandled: unknown[] = []
  const observeUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on("unhandledRejection", observeUnhandled)
  try {
    const app = newApp(
      server({
        async start() {
          throw failure
        },
        async stop() {}
      }),
      afterStart(() => Bun.sleep(25))
    )
    await expect(app.run()).rejects.toBe(failure)
    await turn()
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("server failure interrupts blocking startup before endpoint registration", async () => {
  const failure = new Error("server failed during startup")
  const timeout = new Error("server failure did not interrupt startup")
  const events: string[] = []
  const subject: Server & Endpointer = {
    async endpoint() {
      events.push("endpoint")
      return "http://127.0.0.1:43210"
    },
    async start() {
      events.push("start")
      throw failure
    },
    async stop() {
      events.push("stop")
    }
  }
  const registry: Registrar = {
    async register() {
      events.push("register")
    },
    async deregister() {
      events.push("deregister")
    }
  }
  const app = newApp(
    name("orders"),
    registrar(registry),
    server(subject),
    afterStart(async (ctx) => {
      events.push("afterStart")
      const signal = ctx.done()
      if (signal === null) throw new Error("afterStart Context must be cancelable")
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    })
  )
  const running = app.run()
  void running.catch(() => {})

  try {
    const outcome = await Promise.race([
      running.then(
        () => null,
        (error: unknown) => error
      ),
      Bun.sleep(50).then(() => timeout)
    ])
    expect(outcome).toBe(failure)
    expect(events).toEqual(["start", "stop"])
  } finally {
    await app.stop()
    await running.catch(() => {})
  }
})

test("startTimeout bounds a beforeStart hook that never settles", async () => {
  const entered = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  const app = newApp(
    startTimeout(5),
    beforeStart(async () => {
      entered.resolve()
      await blocked.promise
    })
  )
  const running = app.run()

  try {
    await entered.promise
    expect(await settleWithin(running)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
  } finally {
    blocked.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("startTimeout bounds endpoint preparation that never settles", async () => {
  const endpointEntered = Promise.withResolvers<void>()
  const endpointBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  let registrations = 0
  const registry: Registrar = {
    async register() {
      registrations += 1
    },
    async deregister() {}
  }
  const subject: Server & Endpointer = {
    async endpoint() {
      endpointEntered.resolve()
      await endpointBlocked.promise
      return "http://127.0.0.1:43210"
    },
    async start() {
      await serverDone.promise
    },
    async stop() {
      serverDone.resolve()
    }
  }
  const app = newApp(name("orders"), startTimeout(5), registrar(registry), server(subject))
  const running = app.run()

  try {
    await endpointEntered.promise
    expect(await settleWithin(running)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
    expect(registrations).toBe(0)
  } finally {
    endpointBlocked.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("startTimeout bounds an afterStart hook that never settles", async () => {
  const afterStartEntered = Promise.withResolvers<void>()
  const afterStartBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  const app = newApp(
    startTimeout(5),
    server({
      async start() {
        await serverDone.promise
      },
      async stop() {
        serverDone.resolve()
      }
    }),
    afterStart(async () => {
      afterStartEntered.resolve()
      await afterStartBlocked.promise
    })
  )
  const running = app.run()

  try {
    await afterStartEntered.promise
    expect(await settleWithin(running)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
  } finally {
    afterStartBlocked.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("startTimeout does not treat Server.start as readiness", async () => {
  const startBlocked = Promise.withResolvers<void>()
  const afterStartEntered = Promise.withResolvers<void>()
  const app = newApp(
    startTimeout(5),
    server({
      async start() {
        await startBlocked.promise
      },
      async stop() {
        startBlocked.resolve()
      }
    }),
    afterStart(() => {
      afterStartEntered.resolve()
    })
  )
  const running = app.run()

  expect(await settleWithin(afterStartEntered.promise)).toEqual({
    status: "fulfilled",
    value: undefined
  })
  await app.stop()
  await running
})

test("observes a startup rejection that arrives after startTimeout", async () => {
  const entered = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  const lateFailure = new Error("late startup failure")
  const unhandled: unknown[] = []
  const observeUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on("unhandledRejection", observeUnhandled)
  const app = newApp(
    startTimeout(5),
    beforeStart(async () => {
      entered.resolve()
      await blocked.promise
    })
  )
  const running = app.run()

  try {
    await entered.promise
    const runOutcome = await settleWithin(running)
    expect(runOutcome).toEqual({ status: "rejected", reason: deadlineExceeded })
    blocked.reject(lateFailure)
    await turn()
    expect(unhandled).toEqual([])
    expect(await settleWithin(running)).toEqual(runOutcome)
  } finally {
    blocked.reject(lateFailure)
    await app.stop().catch(() => {})
    await running.catch(() => {})
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("registrarTimeout bounds caller wait when register ignores its Context", async () => {
  const registerEntered = Promise.withResolvers<void>()
  const registerBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  const registry: Registrar = {
    async register() {
      registerEntered.resolve()
      await registerBlocked.promise
    },
    async deregister() {}
  }
  const app = newApp(
    name("orders"),
    endpoint("http://127.0.0.1:43210"),
    registrar(registry),
    registrarTimeout(5),
    server({
      async start() {
        await serverDone.promise
      },
      async stop() {
        serverDone.resolve()
      }
    })
  )
  const running = app.run()

  try {
    await registerEntered.promise
    const outcome = await settleWithin(running)
    expect(outcome).toEqual({ status: "rejected", reason: deadlineExceeded })
  } finally {
    registerBlocked.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("compensates one late successful register with the same ServiceInstance", async () => {
  const registered = Promise.withResolvers<ServiceInstance>()
  const releaseRegister = Promise.withResolvers<void>()
  const compensated = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  let deregistrations = 0
  const registry: Registrar = {
    async register(_ctx, instance) {
      registered.resolve(instance)
      await releaseRegister.promise
    },
    async deregister(_ctx, instance) {
      expect(instance).toBe(await registered.promise)
      deregistrations += 1
      compensated.resolve()
    }
  }
  const app = newApp(
    name("orders"),
    endpoint("http://127.0.0.1:43210"),
    registrar(registry),
    registrarTimeout(5),
    server({
      async start() {
        await serverDone.promise
      },
      async stop() {
        serverDone.resolve()
      }
    })
  )
  const running = app.run()

  try {
    await registered.promise
    const runOutcome = await settleWithin(running)
    expect(runOutcome).toEqual({ status: "rejected", reason: deadlineExceeded })

    releaseRegister.resolve()
    expect(await settleWithin(compensated.promise)).toEqual({
      status: "fulfilled",
      value: undefined
    })
    expect(deregistrations).toBe(1)
    expect(await settleWithin(running)).toEqual(runOutcome)
  } finally {
    releaseRegister.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("observes a late register rejection without changing the settled App result", async () => {
  const registerEntered = Promise.withResolvers<void>()
  const registerBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  const lateFailure = new Error("late register failure")
  const unhandled: unknown[] = []
  const observeUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on("unhandledRejection", observeUnhandled)
  const registry: Registrar = {
    async register() {
      registerEntered.resolve()
      await registerBlocked.promise
    },
    async deregister() {}
  }
  const app = newApp(
    name("orders"),
    endpoint("http://127.0.0.1:43210"),
    registrar(registry),
    registrarTimeout(5),
    server({
      async start() {
        await serverDone.promise
      },
      async stop() {
        serverDone.resolve()
      }
    })
  )
  const running = app.run()

  try {
    await registerEntered.promise
    const runOutcome = await settleWithin(running)
    expect(runOutcome).toEqual({ status: "rejected", reason: deadlineExceeded })
    registerBlocked.reject(lateFailure)
    await turn()
    expect(unhandled).toEqual([])
    expect(await settleWithin(running)).toEqual(runOutcome)
  } finally {
    registerBlocked.reject(lateFailure)
    await app.stop().catch(() => {})
    await running.catch(() => {})
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("uses one stop deadline after beforeStop consumes part of the budget", async () => {
  const beforeStopEntered = Promise.withResolvers<void>()
  const releaseBeforeStop = Promise.withResolvers<void>()
  const stopEntered = Promise.withResolvers<void>()
  const stopBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  let beforeStopContext: Context | null = null
  let serverStopContext: Context | null = null
  const app = newApp(
    stopTimeout(30),
    beforeStop(async (ctx) => {
      beforeStopContext = ctx
      beforeStopEntered.resolve()
      await releaseBeforeStop.promise
    }),
    server({
      async start() {
        await serverDone.promise
      },
      async stop(ctx) {
        serverStopContext = ctx
        stopEntered.resolve()
        serverDone.resolve()
        await stopBlocked.promise
      }
    })
  )
  const running = app.run()
  await turn()
  const stopping = app.stop()
  const releaseTimer = setTimeout(() => {
    releaseBeforeStop.resolve()
  }, 10)

  try {
    await beforeStopEntered.promise
    await stopEntered.promise
    const outcome = await settleWithin(stopping)
    expect(outcome).toEqual({ status: "rejected", reason: deadlineExceeded })
    expect(serverStopContext).toBe(beforeStopContext)
  } finally {
    clearTimeout(releaseTimer)
    releaseBeforeStop.resolve()
    stopBlocked.resolve()
    await stopping.catch(() => {})
    await running.catch(() => {})
  }
})

test("stop deadline bounds startup join before calling remaining cleanup", async () => {
  const beforeStartEntered = Promise.withResolvers<void>()
  const beforeStartBlocked = Promise.withResolvers<void>()
  let beforeStops = 0
  let afterStops = 0
  const app = newApp(
    stopTimeout(5),
    beforeStart(async () => {
      beforeStartEntered.resolve()
      await beforeStartBlocked.promise
    }),
    beforeStop((ctx) => {
      expect(ctx.err()).toBe(deadlineExceeded)
      beforeStops += 1
    }),
    afterStop((ctx) => {
      expect(ctx.err()).toBe(deadlineExceeded)
      afterStops += 1
    })
  )
  const running = app.run()
  await beforeStartEntered.promise
  const stopping = app.stop()

  try {
    const stopOutcome = await settleWithin(stopping)
    expect(stopOutcome).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
    const runOutcome = await settleWithin(running)
    expect(runOutcome).toEqual(stopOutcome)
    expect(beforeStops).toBe(1)
    expect(afterStops).toBe(1)
  } finally {
    beforeStartBlocked.resolve()
    await stopping.catch(() => {})
    await running.catch(() => {})
  }
})

test("calls remaining cleanup once with the terminal stop Context after deadline", async () => {
  const beforeStopEntered = Promise.withResolvers<void>()
  const beforeStopBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  let stops = 0
  let afterStops = 0
  const app = newApp(
    stopTimeout(5),
    beforeStop(async () => {
      beforeStopEntered.resolve()
      await beforeStopBlocked.promise
    }),
    server({
      async start() {
        await serverDone.promise
      },
      async stop(ctx) {
        expect(ctx.err()).toBe(deadlineExceeded)
        stops += 1
        serverDone.resolve()
      }
    }),
    afterStop((ctx) => {
      expect(ctx.err()).toBe(deadlineExceeded)
      afterStops += 1
    })
  )
  const running = app.run()
  await turn()
  const stopping = app.stop()

  try {
    await beforeStopEntered.promise
    expect(await settleWithin(stopping)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
    expect(stops).toBe(1)
    expect(afterStops).toBe(1)
  } finally {
    beforeStopBlocked.resolve()
    serverDone.resolve()
    await stopping.catch(() => {})
    await running.catch(() => {})
  }
})

test("stop deadline includes every Server.start terminal join", async () => {
  const startEntered = Promise.withResolvers<void>()
  const startBlocked = Promise.withResolvers<void>()
  const stopEntered = Promise.withResolvers<void>()
  const app = newApp(
    stopTimeout(5),
    server({
      async start() {
        startEntered.resolve()
        await startBlocked.promise
      },
      async stop() {
        stopEntered.resolve()
      }
    })
  )
  const running = app.run()

  try {
    await startEntered.promise
    const stopping = app.stop()
    await stopEntered.promise
    expect(await settleWithin(stopping)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
    expect(await settleWithin(running)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
  } finally {
    startBlocked.resolve()
    await app.stop().catch(() => {})
    await running.catch(() => {})
  }
})

test("stop deadline bounds an afterStop hook that never settles", async () => {
  const afterStopEntered = Promise.withResolvers<void>()
  const afterStopBlocked = Promise.withResolvers<void>()
  const app = newApp(
    stopTimeout(5),
    afterStop(async () => {
      afterStopEntered.resolve()
      await afterStopBlocked.promise
    })
  )
  const running = app.run()
  await turn()
  const stopping = app.stop()

  try {
    await afterStopEntered.promise
    expect(await settleWithin(stopping)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
  } finally {
    afterStopBlocked.resolve()
    await stopping.catch(() => {})
    await running.catch(() => {})
  }
})

test("keeps ordered stop failures ahead of a later deadline", async () => {
  const beforeStopFailure = new Error("beforeStop failed before deadline")
  const stopBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  const app = newApp(
    stopTimeout(5),
    beforeStop(() => {
      throw beforeStopFailure
    }),
    server({
      async start() {
        await serverDone.promise
      },
      async stop() {
        serverDone.resolve()
        await stopBlocked.promise
      }
    })
  )
  const running = app.run()
  await turn()
  const stopping = app.stop()

  try {
    const outcome = await settleWithin(stopping)
    expect(outcome).not.toBe("test-timeout")
    if (outcome === "test-timeout" || outcome.status === "fulfilled") {
      throw new Error("stop must reject")
    }
    expect(outcome.reason).toBeInstanceOf(AggregateError)
    expect((outcome.reason as AggregateError).errors).toEqual([beforeStopFailure, deadlineExceeded])
  } finally {
    stopBlocked.resolve()
    await stopping.catch(() => {})
    await running.catch(() => {})
  }
})

test("observes a Server.stop rejection that arrives after the stop deadline", async () => {
  const stopEntered = Promise.withResolvers<void>()
  const stopBlocked = Promise.withResolvers<void>()
  const serverDone = Promise.withResolvers<void>()
  const lateFailure = new Error("late server stop failure")
  const unhandled: unknown[] = []
  const observeUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on("unhandledRejection", observeUnhandled)
  const app = newApp(
    stopTimeout(5),
    server({
      async start() {
        await serverDone.promise
      },
      async stop() {
        stopEntered.resolve()
        serverDone.resolve()
        await stopBlocked.promise
        throw lateFailure
      }
    })
  )
  const running = app.run()
  await turn()
  const stopping = app.stop()

  try {
    await stopEntered.promise
    expect(await settleWithin(stopping)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
    stopBlocked.resolve()
    await turn()
    expect(unhandled).toEqual([])
    expect(await settleWithin(stopping)).toEqual({
      status: "rejected",
      reason: deadlineExceeded
    })
  } finally {
    stopBlocked.resolve()
    await stopping.catch(() => {})
    await running.catch(() => {})
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("validates public application options without introducing compatibility aliases", () => {
  expect(() => context(null as never)).toThrow(TypeError)
  expect(() => metadata(null as never)).toThrow(TypeError)
  expect(() => metadata({ invalid: 1 as never })).toThrow(TypeError)
  expect(() => endpoint("")).toThrow(TypeError)
  expect(() => server({} as never)).toThrow(TypeError)
  expect(() => registrar({} as never)).toThrow(TypeError)
  for (const value of [-1, 1.5, Number.NaN, 2_147_483_648]) {
    expect(() => startTimeout(value)).toThrow(RangeError)
    expect(() => stopTimeout(value)).toThrow(RangeError)
    expect(() => registrarTimeout(value)).toThrow(RangeError)
  }
  expect(() => startTimeout(0)).not.toThrow()
  expect(() => stopTimeout(0)).not.toThrow()
  expect(() => registrarTimeout(0)).not.toThrow()
})

test("later server option replaces the earlier server list like Kratos", async () => {
  let replacedStarts = 0
  const done = deferred<void>()
  const replaced: Server = {
    async start() {
      replacedStarts += 1
    },
    async stop() {}
  }
  const retained: Server = {
    async start() {
      await done.promise
    },
    async stop() {
      done.resolve()
    }
  }
  const app = newApp(server(replaced), server(retained))
  const running = app.run()
  await turn()
  await app.stop()
  await running
  expect(replacedStarts).toBe(0)
})

test("AppInfo is a structural accessor contract", () => {
  const info: AppInfo = {
    id: () => "id",
    name: () => "name",
    version: () => "version",
    metadata: () => ({}),
    endpoint: () => []
  }
  expect(fromContext(newContext(background(), info))?.version()).toBe("version")
})

test("normalizes and aggregates startup, stop, and cleanup boundary failures", async () => {
  const events: string[] = []
  const rawStart = { phase: "afterStart" }
  const rawStop = { phase: "stop" }
  const beforeStopFailure = new Error("beforeStop failed")
  const deregisterFailure = new Error("deregister failed")
  const afterStopFailure = new Error("afterStop failed")
  const registry: Registrar = {
    async register() {},
    async deregister() {
      events.push("deregister")
      throw deregisterFailure
    }
  }
  const subject: Server = {
    async start(ctx) {
      events.push("start")
      await new Promise<void>((resolve) => {
        ctx.done()?.addEventListener(
          "abort",
          () => {
            events.push("cancel")
            resolve()
          },
          { once: true }
        )
      })
    },
    stop() {
      events.push("stop")
      throw rawStop
    }
  }
  const app = newApp(
    name("orders"),
    endpoint("https://orders.example"),
    registrar(registry),
    server(subject),
    afterStart(() => {
      throw rawStart
    }),
    beforeStop(() => {
      throw beforeStopFailure
    }),
    afterStop(() => {
      throw afterStopFailure
    })
  )

  const failure = await app.run().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  const errors = (failure as AggregateError).errors as Error[]
  expect(errors[0]?.cause).toBe(rawStart)
  expect(errors[1]).toBeInstanceOf(AggregateError)
  expect((errors[1] as AggregateError).errors[0]).toBe(beforeStopFailure)
  expect((errors[1] as AggregateError).errors[1]).toBe(deregisterFailure)
  expect(((errors[1] as AggregateError).errors[2] as Error).cause).toBe(rawStop)
  expect((errors[1] as AggregateError).errors[3]).toBe(afterStopFailure)
  expect(events).toEqual(["start", "deregister", "cancel", "stop"])
})

test("rejects an invalid internal runtime cleanup contract", async () => {
  const app = newApp(runtimeInstaller(() => null as never))
  await expect(app.run()).rejects.toThrow("must return a cleanup function")
})

test("reports runtime listener cleanup failures after App stop", async () => {
  const cleanupFailure = new Error("listener cleanup failed")
  const app = newApp(
    runtimeInstaller(() => () => {
      throw cleanupFailure
    })
  )
  const running = app.run()
  await turn()
  await app.stop()
  await expect(running).rejects.toBe(cleanupFailure)
})
