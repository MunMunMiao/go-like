import { expect, test } from "bun:test"

import {
  background,
  canceled,
  deadlineExceeded,
  withCancel,
  withoutCancel,
  type Context
} from "@go-like/context"
import { struct } from "@go-like/struct"
import { endpoint, withTimeout } from "@go-like/transport"
import type { Client } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

import {
  address,
  httpRoute,
  middleware,
  newServer,
  transport,
  type Middleware,
  type Server,
  type ServerOption
} from "../src/index"
import { dispatching } from "./dispatching"

/** Timers shorter than this are unrelated to a 60 second request deadline and never counted. */
const LongTimerMs = 30_000
const Origin = "http://127.0.0.1"
const Count = struct.number()
const count = endpoint("orders", "get", Count, Count)
const Tick = struct.object({ n: struct.number() })
const ticks = endpoint("orders", "ticks", Tick, Tick, true)

/** Holds the Context a registered handler or middleware received. */
interface Seen {
  ctx: Context | null
}

/** Counts request-deadline timers that are armed and neither cleared nor fired. */
interface TimerWatch {
  live(): number
  restore(): void
}

/** Starts counting long timers by wrapping the global timer functions. */
function watchTimers(): TimerWatch {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const armed = new Set<unknown>()
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) => {
    if (typeof callback !== "function" || delay === undefined || delay < LongTimerMs) {
      return originalSetTimeout(callback, delay, ...arguments_)
    }
    const timer = originalSetTimeout(() => {
      armed.delete(timer)
      callback(...arguments_)
    }, delay)
    armed.add(timer)
    return timer
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    armed.delete(timer)
    return originalClearTimeout(timer)
  }) as typeof globalThis.clearTimeout
  return {
    live(): number {
      return armed.size
    },
    restore(): void {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  }
}

/** Polls until predicate holds, failing after timeoutMs. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const limit = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > limit) throw new Error("condition was not met in time")
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

/** Builds one JSON POST that carries a Go-Like-Timeout-Ms deadline. */
function timedPost(base: string, path: string, timeoutMs: string): Request {
  return new Request(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json", "Go-Like-Timeout-Ms": timeoutMs },
    body: "1"
  })
}

/** Checks the deadline Context stays live until terminate ends the body, then is released. */
async function expectReleasedBy(
  seen: Seen,
  watch: TimerWatch,
  terminate: () => Promise<void>
): Promise<void> {
  expect(seen.ctx?.err() ?? null).toBeNull()
  expect(watch.live()).toBe(1)
  await terminate()
  expect(seen.ctx?.err() ?? null).toBe(canceled)
  expect(watch.live()).toBe(0)
}

/** One way a registered endpoint can answer a timed request. */
interface Shape {
  readonly name: string
  readonly path: string
  readonly status: number
  readonly options: readonly ServerOption[]
  register(server: Server, seen: Seen): void
}

const shapes: readonly Shape[] = [
  {
    name: "a raw success",
    path: "/orders/get",
    status: 200,
    options: [],
    register(server, seen): void {
      server.registerHandler("orders", "get", (ctx) => {
        seen.ctx = ctx
        return new Response("ok")
      })
    }
  },
  {
    name: "a typed success",
    path: "/orders/get",
    status: 200,
    options: [],
    register(server, seen): void {
      server.registerHandler(count, (ctx, value) => {
        seen.ctx = ctx
        return value + 1
      })
    }
  },
  {
    name: "a handler that throws",
    path: "/orders/get",
    status: 500,
    options: [],
    register(server, seen): void {
      server.registerHandler("orders", "get", (ctx) => {
        seen.ctx = ctx
        throw new Error("secret")
      })
    }
  },
  {
    name: "a handler that returns no Response",
    path: "/orders/get",
    status: 500,
    options: [],
    register(server, seen): void {
      server.registerHandler("orders", "get", (ctx) => {
        seen.ctx = ctx
        return "nope" as never
      })
    }
  },
  {
    name: "an httpRoute success status rewrite",
    path: "/v1/orders",
    status: 201,
    options: [httpRoute("POST", "/v1/orders", "orders", "get", 201)],
    register(server, seen): void {
      server.registerHandler("orders", "get", (ctx) => {
        seen.ctx = ctx
        return new Response("ok")
      })
    }
  }
]

test("returns the handler's own Response when the transport Context is cancelable", async () => {
  const produced = new Response("ok")
  const seen: Seen = { ctx: null }
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return produced
    })
  })
  const [transportCtx, cancelTransport] = withCancel(background())
  try {
    const response = await serving.dispatch(transportCtx, timedPost(Origin, "/orders/get", "60000"))
    expect(response).toBe(produced)
  } finally {
    cancelTransport()
    await serving.stop()
  }
})

for (const shape of shapes) {
  test(`leaves deadline release to a cancelable transport Context: ${shape.name}`, async () => {
    const seen: Seen = { ctx: null }
    const serving = await dispatching((server) => shape.register(server, seen), ...shape.options)
    const [transportCtx, cancelTransport] = withCancel(background())
    const watch = watchTimers()
    try {
      const response = await serving.dispatch(transportCtx, timedPost(Origin, shape.path, "60000"))
      expect(response.status).toBe(shape.status)
      // Reading the body to EOF must not release the deadline: only the transport's cancel does.
      await response.arrayBuffer()
      expect(seen.ctx?.err() ?? null).toBeNull()
      expect(watch.live()).toBe(1)
      cancelTransport()
      expect(seen.ctx?.err() ?? null).toBe(canceled)
      expect(watch.live()).toBe(0)
    } finally {
      watch.restore()
      cancelTransport()
      await serving.stop()
    }
  })

  test(`releases the deadline itself without a cancelable transport Context: ${shape.name}`, async () => {
    const seen: Seen = { ctx: null }
    const serving = await dispatching((server) => shape.register(server, seen), ...shape.options)
    const watch = watchTimers()
    try {
      const response = await serving.dispatch(background(), timedPost(Origin, shape.path, "60000"))
      expect(response.status).toBe(shape.status)
      await expectReleasedBy(seen, watch, async () => {
        await response.arrayBuffer()
      })
    } finally {
      watch.restore()
      await serving.stop()
    }
  })
}

test("releases the deadline itself when the body is canceled without a cancelable transport Context", async () => {
  const seen: Seen = { ctx: null }
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return new Response(new ReadableStream<Uint8Array>())
    })
  })
  const watch = watchTimers()
  try {
    const response = await serving.dispatch(background(), timedPost(Origin, "/orders/get", "60000"))
    await expectReleasedBy(seen, watch, async () => {
      await response.body?.cancel(new Error("stop"))
    })
  } finally {
    watch.restore()
    await serving.stop()
  }
})

test("treats a withoutCancel transport Context as not cancelable", async () => {
  const seen: Seen = { ctx: null }
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return new Response("ok")
    })
  })
  const [parent, cancelParent] = withCancel(background())
  const watch = watchTimers()
  try {
    const response = await serving.dispatch(
      withoutCancel(parent),
      timedPost(Origin, "/orders/get", "60000")
    )
    await expectReleasedBy(seen, watch, async () => {
      await response.arrayBuffer()
    })
  } finally {
    watch.restore()
    cancelParent()
    await serving.stop()
  }
})

test("arms no timer for a zero timeout on a cancelable transport Context", async () => {
  const seen: Seen = { ctx: null }
  const produced = new Response(null, { status: 204 })
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return produced
    })
  })
  const [transportCtx, cancelTransport] = withCancel(background())
  const watch = watchTimers()
  try {
    const response = await serving.dispatch(transportCtx, timedPost(Origin, "/orders/get", "0"))
    expect(response.status).toBe(204)
    expect(seen.ctx?.err()).toBe(deadlineExceeded)
    expect(watch.live()).toBe(0)
    cancelTransport()
    expect(seen.ctx?.err()).toBe(deadlineExceeded)
  } finally {
    watch.restore()
    cancelTransport()
    await serving.stop()
  }
})

test("leaves no timer behind when the cancelable transport Context is already canceled", async () => {
  const seen: Seen = { ctx: null }
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return new Response("ok")
    })
  })
  const [transportCtx, cancelTransport] = withCancel(background())
  cancelTransport()
  const watch = watchTimers()
  try {
    await serving.dispatch(transportCtx, timedPost(Origin, "/orders/get", "60000"))
    expect(seen.ctx?.err()).toBe(canceled)
    expect(watch.live()).toBe(0)
  } finally {
    watch.restore()
    await serving.stop()
  }
})

interface Served {
  readonly wire: Client
  readonly location: string
  stop(): Promise<void>
}

let sequence = 0

/** Serves register's handlers on the memory transport and dials one raw wire client. */
async function memoryServed(
  register: (server: Server) => void,
  ...options: readonly ServerOption[]
): Promise<Served> {
  sequence += 1
  const location = `memory://deadline-release-${sequence}`
  const memory = newMemoryTransport()
  const server = newServer(transport(memory), address(location), ...options)
  register(server)
  const running = server.start(background())
  await server.endpoint(background())
  const wire = await memory.dial(background(), location, withTimeout(0))
  return {
    wire,
    location,
    async stop(): Promise<void> {
      await wire.close(background())
      await server.stop(background())
      await running
    }
  }
}

for (const shape of shapes) {
  test(`keeps the deadline live until the memory Response body ends: ${shape.name}`, async () => {
    const seen: Seen = { ctx: null }
    const served = await memoryServed((server) => shape.register(server, seen), ...shape.options)
    const watch = watchTimers()
    try {
      const response = await served.wire.fetch(
        background(),
        timedPost(served.location, shape.path, "60000")
      )
      expect(response.status).toBe(shape.status)
      await expectReleasedBy(seen, watch, async () => {
        await response.arrayBuffer()
      })
    } finally {
      watch.restore()
      await served.stop()
    }
  })
}

test("releases the deadline when the client cancels a memory Response body", async () => {
  const seen: Seen = { ctx: null }
  const gate = Promise.withResolvers<void>()
  const served = await memoryServed((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Stays open until the test releases the gate or the consumer cancels. */
          async pull(controller): Promise<void> {
            await gate.promise
            try {
              controller.close()
            } catch {
              // Consumer cancellation already terminated the body.
            }
          }
        })
      )
    })
  })
  const watch = watchTimers()
  try {
    const response = await served.wire.fetch(
      background(),
      timedPost(served.location, "/orders/get", "60000")
    )
    await expectReleasedBy(seen, watch, async () => {
      await response.body?.cancel(new Error("stop"))
    })
  } finally {
    gate.resolve()
    watch.restore()
    await served.stop()
  }
})

test("releases the deadline when a memory Response body errors", async () => {
  const seen: Seen = { ctx: null }
  const served = await memoryServed((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Fails the first read. */
          start(controller): void {
            controller.error(new Error("broke"))
          }
        })
      )
    })
  })
  const watch = watchTimers()
  try {
    const response = await served.wire.fetch(
      background(),
      timedPost(served.location, "/orders/get", "60000")
    )
    await expectReleasedBy(seen, watch, async () => {
      await expect(response.text()).rejects.toThrow("broke")
    })
  } finally {
    watch.restore()
    await served.stop()
  }
})

test("releases the deadline when the caller aborts an in-flight memory exchange", async () => {
  const seen: Seen = { ctx: null }
  const gate = Promise.withResolvers<void>()
  const served = await memoryServed((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Stays open until the test releases the gate or the exchange aborts. */
          async pull(controller): Promise<void> {
            await gate.promise
            try {
              controller.close()
            } catch {
              // The aborted exchange already terminated the body.
            }
          }
        })
      )
    })
  })
  const [caller, abort] = withCancel(background())
  const watch = watchTimers()
  try {
    const response = await served.wire.fetch(
      caller,
      timedPost(served.location, "/orders/get", "60000")
    )
    expect(seen.ctx?.err() ?? null).toBeNull()
    expect(watch.live()).toBe(1)
    abort()
    await until(() => (seen.ctx?.err() ?? null) !== null)
    expect(watch.live()).toBe(0)
    await response.body?.cancel().catch(function ignore(): void {})
  } finally {
    gate.resolve()
    watch.restore()
    await served.stop()
  }
})

test("a zero timeout cancels the memory handler Context at once and arms no timer", async () => {
  const seen: Seen = { ctx: null }
  let atCall: unknown = "unset"
  const served = await memoryServed((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      atCall = ctx.err()
      return new Response(null, { status: 204 })
    })
  })
  const watch = watchTimers()
  try {
    const response = await served.wire.fetch(
      background(),
      timedPost(served.location, "/orders/get", "0")
    )
    expect(response.status).toBe(204)
    expect(atCall).toBe(deadlineExceeded)
    expect(watch.live()).toBe(0)
    await response.arrayBuffer()
    expect(seen.ctx?.err()).toBe(deadlineExceeded)
    expect(watch.live()).toBe(0)
  } finally {
    watch.restore()
    await served.stop()
  }
})

test("keeps delivering a memory Response body after the deadline fired", async () => {
  const seen: Seen = { ctx: null }
  const gate = Promise.withResolvers<void>()
  const served = await memoryServed((server) => {
    server.registerHandler("orders", "get", (ctx) => {
      seen.ctx = ctx
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Emits the body only after the test saw the deadline fire. */
          async pull(controller): Promise<void> {
            await gate.promise
            controller.enqueue(new TextEncoder().encode("late"))
            controller.close()
          }
        })
      )
    })
  })
  try {
    const response = await served.wire.fetch(
      background(),
      timedPost(served.location, "/orders/get", "25")
    )
    await until(() => (seen.ctx?.err() ?? null) !== null)
    expect(seen.ctx?.err()).toBe(deadlineExceeded)
    gate.resolve()
    expect(await response.text()).toBe("late")
    expect(seen.ctx?.err()).toBe(deadlineExceeded)
  } finally {
    gate.resolve()
    await served.stop()
  }
})

/** Records the deadline Context every routed handler receives, including stream handlers. */
function capture(seen: Seen): Middleware {
  return (next) => (ctx, request) => {
    seen.ctx = ctx
    return next(ctx, request)
  }
}

/** Posts one raw SSE request and returns its body reader. */
async function openStream(
  served: Served,
  timeoutMs: string
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await served.wire.fetch(
    background(),
    new Request(new URL("/orders/ticks", served.location), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "Go-Like-Timeout-Ms": timeoutMs
      },
      body: '{"n":1}'
    })
  )
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("stream response has no body")
  return reader
}

/** Reads a stream reader to EOF as UTF-8 text. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  for (let step = await reader.read(); !step.done; step = await reader.read()) {
    text += decoder.decode(step.value, { stream: true })
  }
  return text + decoder.decode()
}

test("releases the deadline at the end of a memory stream and runs the generator finally once", async () => {
  const seen: Seen = { ctx: null }
  const finals: unknown[] = []
  const served = await memoryServed(
    (server) => {
      server.registerHandler(ticks, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
        try {
          yield { n: 1 }
          yield { n: 2 }
        } finally {
          finals.push(ctx.err() ?? null)
        }
      })
    },
    middleware(capture(seen))
  )
  const watch = watchTimers()
  try {
    const reader = await openStream(served, "60000")
    let text = ""
    await expectReleasedBy(seen, watch, async () => {
      text = await drain(reader)
    })
    expect(text).toContain("event: end")
    expect(finals).toEqual([null])
  } finally {
    watch.restore()
    await served.stop()
  }
})

test("releases the deadline and returns the iterator when the consumer cancels a memory stream", async () => {
  const seen: Seen = { ctx: null }
  const finals: unknown[] = []
  const served = await memoryServed(
    (server) => {
      server.registerHandler(ticks, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
        try {
          yield { n: 1 }
          yield { n: 2 }
          yield { n: 3 }
        } finally {
          finals.push(ctx.err() ?? null)
        }
      })
    },
    middleware(capture(seen))
  )
  const watch = watchTimers()
  try {
    const reader = await openStream(served, "60000")
    await reader.read()
    await reader.read()
    await expectReleasedBy(seen, watch, async () => {
      await reader.cancel(new Error("stop"))
    })
    await until(() => finals.length > 0)
    expect(finals).toEqual([canceled])
  } finally {
    watch.restore()
    await served.stop()
  }
})

test("reports deadline_exceeded and returns the iterator when the deadline fires mid-stream", async () => {
  const seen: Seen = { ctx: null }
  const finals: unknown[] = []
  const served = await memoryServed(
    (server) => {
      server.registerHandler(ticks, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 200))
          yield { n: 1 }
        } finally {
          finals.push(ctx.err() ?? null)
        }
      })
    },
    middleware(capture(seen))
  )
  try {
    const reader = await openStream(served, "40")
    const text = await drain(reader)
    expect(text).toContain("event: error")
    expect(text).toContain('"code":"deadline_exceeded"')
    expect(seen.ctx?.err()).toBe(deadlineExceeded)
    await until(() => finals.length > 0)
    expect(finals).toEqual([deadlineExceeded])
  } finally {
    await served.stop()
  }
})
