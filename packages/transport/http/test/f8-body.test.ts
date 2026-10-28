import { expect, test } from "bun:test"

import { limitResponse, readBoundedBody } from "../src/bounded-body"

test("Q6-05 an oversized read rejects while source cancel is still pending", async () => {
  let cancelStarted = false
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const started = Date.now()
  const failure = await readBoundedBody(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(5))
      },
      cancel(): Promise<void> {
        cancelStarted = true
        return gate
      }
    }),
    new Headers(),
    4,
    "bad length",
    "too big"
  ).then(
    function unexpected(): unknown {
      return undefined
    },
    function failed(error: unknown): unknown {
      return error
    }
  )
  expect(Date.now() - started).toBeLessThan(200)
  expect(cancelStarted).toBe(true)
  expect(failure).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "too big" })
  release()
})

test("Q6-05 an oversized response errors while source cancel is still pending", async () => {
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const started = Date.now()
  const limited = limitResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array(5))
        },
        cancel(): Promise<void> {
          return gate
        }
      })
    ),
    4
  )
  await expect(limited.arrayBuffer()).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL"
  })
  expect(Date.now() - started).toBeLessThan(200)
  release()
})
