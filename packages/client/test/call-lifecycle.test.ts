import { background, canceled, deadlineExceeded, withCancel, withTimeout } from "@go-like/context"
import { struct } from "@go-like/struct"
import { endpoint, type Transport } from "@go-like/transport"
import { executor, newHTTPTransport } from "@go-like/transport-http"
import { newMemoryTransport } from "@go-like/transport-memory"
import { expect, test } from "bun:test"

import { newClient, poolSize, withEndpoint, withTransport } from "../src/index"

const Empty = struct.object({})
const read = endpoint("test.v1", "read", Empty, Empty)

/** Resolves after the given number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(function wait(resolve): void {
    setTimeout(resolve, ms)
  })
}

test("Q2-02 raw call releases a zero-size pool only after the body is read", async () => {
  let closes = 0
  const transport: Transport = {
    kind(): string {
      return "script"
    },
    init(): void {},
    options(): never {
      throw new Error("unused options")
    },
    async dial(): Promise<{
      fetch: () => Promise<Response>
      close: () => Promise<void>
    }> {
      return {
        /** Returns one buffered body the caller can finish. */
        async fetch(): Promise<Response> {
          return new Response(new Uint8Array([1, 2, 3]))
        },
        /** Counts connection release. */
        async close(): Promise<void> {
          closes += 1
        }
      }
    },
    async listen(): Promise<never> {
      throw new Error("unused listen")
    },
    string(): string {
      return "script"
    }
  }
  const client = newClient(
    withEndpoint("http://127.0.0.1:9/"),
    withTransport(transport),
    poolSize(0)
  )
  const response = await client.call(background(), {
    service: "test.v1",
    endpoint: "read",
    headers: {},
    body: null
  })
  expect(closes).toBe(0)
  expect(response.bodyUsed).toBe(false)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  await pause(20)
  expect(closes).toBe(1)
  await client.close(background())
})

test("Q2-02 raw HTTP pool does not cancel the body before the caller reads it", async () => {
  let canceledBodies = 0
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Records executor-body cancellation. */
          cancel(): void {
            canceledBodies += 1
          }
        })
      )
    })
  )
  const client = newClient(
    withEndpoint("http://127.0.0.1:9/"),
    withTransport(transport),
    poolSize(0)
  )
  const response = await client.call(background(), {
    service: "test.v1",
    endpoint: "read",
    headers: {},
    body: null
  })
  expect(canceledBodies).toBe(0)
  expect(response.bodyUsed).toBe(false)
  await response.body?.cancel()
  await client.close(background())
})

test("Q2-08 typed body deadline stays DeadlineExceeded", async () => {
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "application/json" }
      })
    })
  )
  const client = newClient(withEndpoint("http://127.0.0.1:9/"), withTransport(transport))
  const [ctx, cancel] = withTimeout(background(), 20)
  let observed: unknown
  try {
    await client.call(ctx, read, {})
  } catch (error) {
    observed = error
  } finally {
    cancel()
    await client.close(background())
  }
  expect(observed).toBe(deadlineExceeded)
})

test("Q2-08 typed body cancellation stays Canceled", async () => {
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "application/json" }
      })
    })
  )
  const client = newClient(withEndpoint("http://127.0.0.1:9/"), withTransport(transport))
  const [ctx, cancel] = withCancel(background())
  const pending = client.call(ctx, read, {})
  await pause(20)
  cancel()
  await expect(pending).rejects.toBe(canceled)
  await client.close(background())
})

test("F5 raw text/plain deadline rejects a partial body", async () => {
  const transport = newMemoryTransport()
  const address = "memory://f5-plain-deadline"
  const listener = await transport.listen(background(), address)
  const serving = listener.serve(background(), function respond(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        /** Publishes one chunk and leaves the tail open until the deadline. */
        start(controller): void {
          controller.enqueue(new TextEncoder().encode("hello"))
        }
      }),
      { headers: { "content-type": "text/plain" } }
    )
  })
  const client = newClient(withEndpoint(address), withTransport(transport))
  const [ctx, cancel] = withTimeout(background(), 80)
  try {
    const response = await client.call(ctx, {
      service: "test.v1",
      endpoint: "read",
      headers: {},
      body: null
    })
    await expect(response.text()).rejects.toBe(deadlineExceeded)
  } finally {
    cancel()
    await client.close(background())
    await listener.close(background())
    await serving
  }
})

test("Q3-01 memory typed unary cancel and deadline reject with the context singleton", async () => {
  const modes = ["cancel", "deadline", "deadline-buffered"] as const
  for (const mode of modes) {
    const transport = newMemoryTransport()
    const address = `memory://q3-01-${mode}`
    const listener = await transport.listen(background(), address)
    const buffered = mode === "deadline-buffered"
    const serving = listener.serve(background(), function respond(): Response {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            if (buffered) controller.enqueue(new TextEncoder().encode("{}"))
          }
        }),
        { headers: { "content-type": "application/json" } }
      )
    })
    const client = newClient(withEndpoint(address), withTransport(transport))
    const [ctx, cancel] =
      mode === "cancel" ? withCancel(background()) : withTimeout(background(), 30)
    const pending = client.call(ctx, read, {})
    if (mode === "cancel") {
      await pause(10)
      cancel()
    }
    let observed: unknown
    try {
      observed = await pending
    } catch (error) {
      observed = error
    } finally {
      cancel()
      await client.close(background())
      await listener.close(background())
      await serving
    }
    expect(observed).toBe(mode === "cancel" ? canceled : deadlineExceeded)
  }
})
