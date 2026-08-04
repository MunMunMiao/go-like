import { describe, expect, test } from "bun:test"

import { background, canceled, withCancelCause, type Context } from "@go-like/context"
import { waitForContext } from "../src/lifecycle"

interface CustomAfterContext extends Context {
  afterFunc(callback: () => void): () => boolean
}

async function settleWithin<T>(
  operation: Promise<T>
): Promise<PromiseSettledResult<T> | "test-timeout"> {
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve("test-timeout")
    }, 100)
    operation.then(
      (value) => {
        clearTimeout(timeout)
        resolve({ status: "fulfilled", value })
      },
      (reason: unknown) => {
        clearTimeout(timeout)
        resolve({ status: "rejected", reason })
      }
    )
  })
}

describe("waitForContext", () => {
  test("rejects an already-canceled caller with its cause", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const cancellationCause = new Error("caller canceled")
    cancel(cancellationCause)

    await expect(
      waitForContext(ctx, Promise.reject(new Error("ignored operation failure")))
    ).rejects.toBe(cancellationCause)
  })

  test("preserves a winning operation value or Error identity and releases the listener", async () => {
    let listener: EventListenerOrEventListenerObject | null = null
    let removals = 0
    const signal = {
      aborted: false,
      addEventListener(_type: string, next: EventListenerOrEventListenerObject) {
        listener = next
      },
      removeEventListener() {
        removals += 1
        listener = null
      }
    }
    const ctx: Context = {
      deadline: () => [new Date(0), false],
      done: () => signal as never,
      err: () => null,
      value: () => null
    }
    const operationFailure = new Error("operation failed")

    await expect(waitForContext(ctx, Promise.resolve(42))).resolves.toBe(42)
    expect(removals).toBe(1)
    await expect(waitForContext(ctx, Promise.reject(operationFailure))).rejects.toBe(
      operationFailure
    )
    expect(removals).toBe(2)
  })

  test("cancels only the caller wait while the losing operation continues", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const cancellationCause = new Error("stop waiting")
    let resolveOperation!: (value: string) => void
    const observation: { value: string | null } = { value: null }
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve
    })
    void operation.then((value) => {
      observation.value = value
    })
    const waiting = waitForContext(ctx, operation)

    cancel(cancellationCause)
    await expect(waiting).rejects.toBe(cancellationCause)
    resolveOperation("continued")
    await operation
    expect(observation.value).toBe("continued")
  })

  test("falls back to the canceled sentinel for an external canceled Context", async () => {
    const ctx: Context = {
      deadline: () => [new Date(0), false],
      done: () =>
        ({
          aborted: true,
          addEventListener() {},
          removeEventListener() {}
        }) as never,
      err: () => canceled,
      value: () => null
    }

    await expect(waitForContext(ctx, new Promise<never>(() => {}))).rejects.toBe(canceled)
  })

  test("preserves Context inspection and listener-registration failures", async () => {
    const inspectionFailure = new Error("err inspection failed")
    const inspectionContext: Context = {
      deadline: () => [new Date(0), false],
      done: () => null,
      err() {
        throw inspectionFailure
      },
      value: () => null
    }
    await expect(
      waitForContext(
        inspectionContext,
        Promise.reject(new Error("ignored inspection operation failure"))
      )
    ).rejects.toBe(inspectionFailure)

    const registrationFailure = new Error("listener registration failed")
    const registrationContext: Context = {
      deadline: () => [new Date(0), false],
      done: () =>
        ({
          aborted: false,
          addEventListener() {
            throw registrationFailure
          },
          removeEventListener() {}
        }) as never,
      err: () => null,
      value: () => null
    }
    await expect(
      waitForContext(
        registrationContext,
        Promise.reject(new Error("ignored registration operation failure"))
      )
    ).rejects.toBe(registrationFailure)
  })

  test("preserves a winning operation value or Error when a custom StopFunc throws", async () => {
    const cleanupFailure = new Error("custom StopFunc failed")
    const signal = new AbortController().signal
    const context = {
      deadline: () => [new Date(0), false] as const,
      done: () => signal,
      err: () => null,
      value: () => null,
      afterFunc() {
        return () => {
          throw cleanupFailure
        }
      }
    } satisfies CustomAfterContext
    const operationFailure = new Error("operation failed")

    const fulfilled = await settleWithin(waitForContext(context, Promise.resolve("winner")))
    expect(fulfilled).toEqual({ status: "fulfilled", value: "winner" })
    const rejected = await settleWithin(waitForContext(context, Promise.reject(operationFailure)))
    expect(rejected).toEqual({ status: "rejected", reason: operationFailure })
  })

  test("settles with a cancellationError throw when cancellation wins an operation race", async () => {
    const cancellationFailure = new Error("cancellation error lookup failed")
    let canceled = false
    let admit!: () => void
    let resolveOperation!: (value: string) => void
    const signal = new AbortController().signal
    const context = {
      deadline: () => [new Date(0), false] as const,
      done: () => signal,
      err() {
        if (canceled) throw cancellationFailure
        return null
      },
      value: () => null,
      afterFunc(callback: () => void) {
        admit = callback
        return () => true
      }
    } satisfies CustomAfterContext
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve
    })
    const waiting = waitForContext(context, operation)

    canceled = true
    admit()
    resolveOperation("operation settled after cancellation admission")

    const result = await settleWithin(waiting)
    expect(result).toEqual({ status: "rejected", reason: cancellationFailure })
  })
})
