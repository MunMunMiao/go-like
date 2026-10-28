import vm from "node:vm"

import { expect, test } from "bun:test"

import { limitResponse, readBoundedBody } from "../src/bounded-body"

test("Q5-06 an oversized request body cancels its source with the original protocol error", async () => {
  const reasons: unknown[] = []
  await expect(
    readBoundedBody(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array(5))
        },
        cancel(reason): void {
          reasons.push(reason)
        }
      }),
      new Headers(),
      4,
      "bad length",
      "too big"
    )
  ).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "too big" })
  expect(reasons).toHaveLength(1)
  expect(reasons[0]).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "too big" })

  let cancelFailed = false
  const rejected = await readBoundedBody(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(5))
      },
      cancel(): Promise<void> {
        cancelFailed = true
        return Promise.reject(new Error("cancel failed"))
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
  expect(cancelFailed).toBe(true)
  expect(rejected).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "too big" })
  expect((rejected as Error).message).not.toBe("cancel failed")

  const released = {
    async read(): Promise<{ done: false; value: Uint8Array }> {
      return { done: false, value: new Uint8Array(5) }
    },
    async cancel(): Promise<void> {},
    releaseLock(): void {
      throw new TypeError("reader already released")
    }
  }
  const fake = {
    getReader: (): typeof released => released
  } as unknown as ReadableStream<Uint8Array>
  await expect(
    readBoundedBody(fake, new Headers(), 4, "bad length", "too big")
  ).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_PROTOCOL",
    message: "too big"
  })
})

test("Q5-07 request and response reads keep a cross-realm Error as cause", async () => {
  const reason = vm.runInNewContext(
    'new Error("upstream read failed", { cause: { marker: 1 } })'
  ) as Error
  const isCrossRealmError = Object.getOwnPropertyDescriptor(Error, "isError")?.value as
    | ((value: unknown) => boolean)
    | undefined
  expect(typeof isCrossRealmError).toBe("function")
  expect(isCrossRealmError?.(reason)).toBe(true)
  expect(reason instanceof Error).toBe(false)

  const request = await readBoundedBody(
    new ReadableStream<Uint8Array>({
      pull(controller): void {
        controller.error(reason)
      }
    }),
    new Headers(),
    8,
    "bad length",
    "bad body"
  ).then(
    function unexpected(): unknown {
      return undefined
    },
    function failed(error: unknown): unknown {
      return error
    }
  )
  expect(request).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL", message: "bad body" })
  expect((request as { cause?: unknown }).cause).toBe(reason)

  const limited = limitResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller): void {
          controller.error(reason)
        }
      })
    ),
    64
  )
  const response = await limited.arrayBuffer().then(
    function unexpected(): unknown {
      return undefined
    },
    function failed(error: unknown): unknown {
      return error
    }
  )
  expect(response).toMatchObject({ code: "GO_LIKE_TRANSPORT_PROTOCOL" })
  expect((response as { cause?: unknown }).cause).toBe(reason)
})
