import { expect, test } from "bun:test"

import { background, canceled, withCancel } from "@go-like/context"
import { executor, newHTTPTransport, type HTTPExecutor } from "@go-like/transport-http"

/** Completes a standard callable executor. */
function httpExecutor(run: () => Promise<Response>): HTTPExecutor {
  return Object.assign(run, {
    /** Leaves optional connection warming inert. */
    preconnect(): void {}
  })
}

test("close preserves a synchronous abort failure and an executor close rejection", async () => {
  const native = AbortController
  const abortFailure = new Error("abort threw")
  class HostileAbortController extends native {
    /** Throws from the abort boundary used by client close. */
    override abort(): void {
      throw abortFailure
    }
  }
  let releaseExecutor = null as ((response: Response) => void) | null
  globalThis.AbortController = HostileAbortController
  try {
    const client = await newHTTPTransport(
      executor(
        httpExecutor(function run(): Promise<Response> {
          return new Promise<Response>(function pending(resolve): void {
            releaseExecutor = resolve
          })
        })
      )
    ).dial(background(), "example.test:8080")
    const pending = client.fetch(
      background(),
      new Request("http://example.test:8080/orders/Create", { method: "POST", body: "x" })
    )
    await Promise.resolve()
    await expect(client.close(background())).rejects.toBe(abortFailure)
    releaseExecutor?.(new Response(null, { status: 204 }))
    await expect(pending).rejects.toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
  } finally {
    globalThis.AbortController = native
  }

  const closeFailure = new Error("executor close rejected")
  const { newHTTPTransportWithDialExecutor } = await import("../src/transport")
  const throwing = await newHTTPTransportWithDialExecutor(
    function factory(_target, _common, _dial, fallback) {
      return {
        executor: fallback,
        close(): Promise<void> {
          throw closeFailure
        }
      }
    }
  ).dial(background(), "example.test:8080")
  await expect(throwing.close(background())).rejects.toBe(closeFailure)

  const rejecting = await newHTTPTransportWithDialExecutor(
    function factory(_target, _common, _dial, fallback) {
      return {
        executor: fallback,
        close(): Promise<void> {
          return Promise.reject(closeFailure)
        }
      }
    }
  ).dial(background(), "example.test:8080")
  await expect(rejecting.close(background())).rejects.toBe(closeFailure)

  const owned = await newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(null, { status: 204 }))
      })
    )
  ).dial(background(), "example.test:8080")
  await owned.fetch(
    background(),
    new Request("http://example.test:8080/orders/Create", { method: "POST" })
  )
  const [ctx, cancel] = withCancel(background())
  const closing = owned.close(ctx)
  cancel()
  await expect(closing).rejects.toBe(canceled)
  await owned.close(background())
})
