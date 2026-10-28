import { background } from "@go-like/context"
import { struct } from "@go-like/struct"
import { endpoint, isServiceError } from "@go-like/transport"
import type { Client as TransportClient, Listener, Options, Transport } from "@go-like/transport"
import { eventStreamContentType } from "@go-like/transport/sse"
import { expect, test } from "bun:test"

import { newClient, withEndpoint, withTransport } from "../src/index"
import { openServerStream } from "../src/stream"

const Item = struct.object({ n: struct.number() })
const encoder = new TextEncoder()

/** Fails when work does not settle inside the bound. */
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>(function expire(_resolve, reject): void {
        timer = setTimeout(function timedOut(): void {
          reject(new Error(`${label} exceeded ${ms}ms`))
        }, ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Builds one event-stream response around a caller-supplied body. */
function streamResponse(body: BodyInit | null): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": eventStreamContentType }
  })
}

/** A cancel promise that stays pending until the test releases it. */
function gatedCancel(): {
  stream: ReadableStream<Uint8Array>
  release: () => void
  cancels: () => number
} {
  let pending = 0
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(
        encoder.encode('data: {"n":1,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n\n')
      )
    },
    cancel(): Promise<void> {
      pending += 1
      return gate
    }
  })
  return {
    stream,
    release,
    cancels: () => pending
  }
}

test("Q7-02 close and return settle while body cancel is still pending", async () => {
  for (const mode of ["close", "return"] as const) {
    let pending = 0
    let release = function noop(): void {}
    const gate = new Promise<void>(function capture(resolve): void {
      release = resolve
    })
    const events = openServerStream(
      streamResponse(
        new ReadableStream<Uint8Array>({
          cancel(): Promise<void> {
            pending += 1
            return gate
          }
        })
      ),
      Item,
      1024,
      background()
    )
    const iterator = events[Symbol.asyncIterator]()
    try {
      const done =
        mode === "close"
          ? events.close().then(() => "closed")
          : iterator.return!().then(() => "returned")
      await expect(within(done, 200, mode)).resolves.toBe(mode === "close" ? "closed" : "returned")
      expect(pending).toBeGreaterThan(0)
    } finally {
      release()
      await events.close()
    }
  }
})

test("Q7-02 resource_exhausted is delivered while source cancel is still pending", async () => {
  const gated = gatedCancel()
  const events = openServerStream(streamResponse(gated.stream), Item, 32, background())
  const iterator = events[Symbol.asyncIterator]()
  try {
    const failure = await within(iterator.next(), 200, "oversize").then(
      function unexpected(): unknown {
        return undefined
      },
      function rejected(error: unknown): unknown {
        return error
      }
    )
    expect(isServiceError(failure)).toBe(true)
    expect(failure).toMatchObject({ code: "resource_exhausted" })
    expect(gated.cancels()).toBeGreaterThan(0)
  } finally {
    gated.release()
    await events.close()
  }
})

test("Q7-02 an unread Response.clone does not block close", async () => {
  const response = new Response('data: {"n":1}\n\nevent: end\ndata: {}\n\n', {
    headers: { "content-type": eventStreamContentType }
  })
  const copy = response.clone()
  const events = openServerStream(response, Item, 1024, background())
  events[Symbol.asyncIterator]()
  try {
    await expect(within(events.close(), 200, "clone close")).resolves.toBeUndefined()
  } finally {
    await copy.text()
    await events.close()
  }
})

test("Q7-02 a wrong stream content type rejects while body cancel is pending", async () => {
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const transportClient: TransportClient = {
    async fetch(): Promise<Response> {
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel(): Promise<void> {
            return gate
          }
        }),
        { status: 200, headers: { "content-type": "text/plain" } }
      )
    },
    async close(): Promise<void> {}
  }
  const transport: Transport = {
    kind: () => "http",
    init(): void {},
    options(): Options {
      throw new Error("unused")
    },
    async dial(): Promise<TransportClient> {
      return transportClient
    },
    async listen(): Promise<Listener> {
      throw new Error("unused")
    },
    string: () => "test"
  }
  const client = newClient(withTransport(transport), withEndpoint("http://127.0.0.1:9/"))
  try {
    await expect(
      within(
        client.stream(background(), endpoint("orders", "Watch", Item, Item, true), { n: 1 }),
        200,
        "content-type"
      )
    ).rejects.toMatchObject({
      message: "server stream response Content-Type must be text/event-stream"
    })
  } finally {
    release()
    await client.close(background())
  }
})
