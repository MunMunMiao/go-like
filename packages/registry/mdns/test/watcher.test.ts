import { describe, expect, test } from "bun:test"

import { background, canceled, withCancelCause, type Context } from "@go-like/context"
import type { ServiceInstance } from "@go-like/registry"

import { newSnapshotQueue } from "../src/watcher"

/** Creates one normalized watcher snapshot fixture. */
function instance(id: string, port = 8080): ServiceInstance {
  return {
    id,
    name: "orders",
    version: "v1",
    metadata: { id },
    endpoints: [`http://127.0.0.1:${port}/`]
  }
}

/** Creates one open custom Context with an explicit afterFunc stop seam. */
function customContext(
  after: (callback: () => void) => () => boolean,
  error: () => Error | null = () => null
): Context {
  const controller = new AbortController()
  return {
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    done(): AbortSignal {
      return controller.signal
    },
    err(): Error | null {
      return error()
    },
    value(): unknown {
      return null
    },
    afterFunc(callback: () => void): () => boolean {
      return after(callback)
    }
  } as Context
}

describe("mDNS watcher snapshot queue", () => {
  test("validates the bounded capacity", () => {
    expect(() => newSnapshotQueue(0)).toThrow(RangeError)
    expect(() => newSnapshotQueue(4_097)).toThrow(RangeError)
    expect(() => newSnapshotQueue(1.5)).toThrow(RangeError)
  })

  test("delivers immutable defensive snapshots in FIFO order", async () => {
    const queue = newSnapshotQueue(2)
    const first = instance("one", 8080)
    const second = instance("two", 8081)
    const mutable = [first]
    expect(queue.push(mutable)).toBeNull()
    mutable[0] = second
    expect(queue.push([second])).toBeNull()

    const receivedFirst = await queue.next(background())
    const receivedSecond = await queue.next(background())
    expect(receivedFirst).toEqual([first])
    expect(receivedSecond).toEqual([second])
    expect(Object.isFrozen(receivedFirst)).toBe(true)
    expect(Object.isFrozen(receivedFirst[0])).toBe(true)
    queue.stop()
    await queue.settled()
  })

  test("delivers directly to an admitted waiter", async () => {
    const queue = newSnapshotQueue(1)
    const pending = queue.next(background())
    const current = instance("direct")
    expect(queue.push([current])).toBeNull()
    await expect(pending).resolves.toEqual([current])
    queue.stop()
    await queue.settled()
  })

  test("preserves the exact caller cancellation cause", async () => {
    const queue = newSnapshotQueue(1)
    const [ctx, cancel] = withCancelCause(background())
    const pending = queue.next(ctx)
    const failure = new Error("caller canceled")
    cancel(failure)
    await expect(pending).rejects.toBe(failure)
    expect(queue.push([instance("retained")])).toBeNull()
    await expect(queue.next(background())).resolves.toEqual([instance("retained")])
    queue.stop()
    await queue.settled()
  })

  test("overflow fails closed and rejects pending and future operations consistently", async () => {
    const queue = newSnapshotQueue(1)
    expect(queue.push([instance("first")])).toBeNull()
    const overflow = queue.push([instance("second")])
    if (overflow === null) throw new Error("expected watcher overflow")
    expect(overflow).toMatchObject({
      code: "GO_LIKE_WATCHER_OVERFLOW",
      bufferSize: 1
    })
    expect(queue.push([])).toBe(overflow)
    await expect(queue.next(background())).rejects.toBe(overflow)
    await expect(queue.settled()).rejects.toBe(overflow)
    expect(queue.fail(new Error("late"))).toBe(overflow)
    expect(queue.stop()).not.toBe(overflow)
  })

  test("passive failure rejects a waiter and owns the terminal reason", async () => {
    const queue = newSnapshotQueue(1)
    const pending = queue.next(background())
    const failure = new Error("socket failed")
    expect(queue.fail(failure)).toBe(failure)
    await expect(pending).rejects.toBe(failure)
    await expect(queue.next(background())).rejects.toBe(failure)
    await expect(queue.settled()).rejects.toBe(failure)
    expect(queue.fail(new Error("late"))).toBe(failure)
  })

  test("normal stop rejects pending and future next calls with the stable stopped error", async () => {
    const queue = newSnapshotQueue(1)
    const terminal = queue.settled()
    expect(queue.settled()).toBe(terminal)
    const pending = queue.next(background())
    const stopped = queue.stop()
    expect(stopped).toMatchObject({ code: "GO_LIKE_WATCHER_STOPPED" })
    expect(queue.stop()).toBe(stopped)
    await expect(pending).rejects.toBe(stopped)
    await expect(queue.next(background())).rejects.toBe(stopped)
    await expect(terminal).resolves.toBeUndefined()
  })

  test("rejects malformed snapshots without changing queue ownership", async () => {
    const queue = newSnapshotQueue(1)
    expect(() => queue.push(null as never)).toThrow(TypeError)
    expect(() => queue.fail(null as never)).toThrow(TypeError)
    expect(queue.push([])).toBeNull()
    await expect(queue.next(background())).resolves.toEqual([])
    queue.stop()
    await queue.settled()
  })

  test("treats a throwing Context StopFunc as a delivery winner", async () => {
    const queue = newSnapshotQueue(1)
    const ctx = customContext(() => () => {
      throw new Error("stop failed after winning")
    })
    const pending = queue.next(ctx)
    expect(queue.push([instance("winner")])).toBeNull()
    await expect(pending).resolves.toEqual([instance("winner")])
    queue.stop()
    await queue.settled()
  })

  test("lets caller cancellation win when a custom StopFunc reports false", async () => {
    const failedQueue = newSnapshotQueue(1)
    const failedPending = failedQueue.next(customContext(() => () => false))
    const failure = new Error("owner failed")
    failedQueue.fail(failure)
    await expect(failedPending).rejects.toBe(canceled)
    await expect(failedQueue.settled()).rejects.toBe(failure)

    const deliveredQueue = newSnapshotQueue(1)
    const deliveredPending = deliveredQueue.next(customContext(() => () => false))
    expect(deliveredQueue.push([instance("queued")])).toBeNull()
    await expect(deliveredPending).rejects.toBe(canceled)
    await expect(deliveredQueue.next(background())).resolves.toEqual([instance("queued")])
    deliveredQueue.stop()
    await deliveredQueue.settled()
  })

  test("observes owner termination that reenters through a custom StopFunc", async () => {
    const queue = newSnapshotQueue(1)
    const pending = queue.next(
      customContext(() => () => {
        queue.stop()
        return true
      })
    )
    const stopped = queue.push([instance("lost-race")])
    expect(stopped).toMatchObject({ code: "GO_LIKE_WATCHER_STOPPED" })
    await expect(pending).rejects.toBe(stopped)
    await queue.settled()
  })

  test("preserves Context inspection and afterFunc setup failures", async () => {
    const inspectionFailure = new Error("Context inspection failed")
    const throwingContext: Context = {
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): null {
        return null
      },
      err(): Error | null {
        throw inspectionFailure
      },
      value(): unknown {
        return null
      }
    }
    await expect(newSnapshotQueue(1).next(throwingContext)).rejects.toBe(inspectionFailure)

    const setupFailure = new Error("afterFunc setup failed")
    await expect(
      newSnapshotQueue(1).next(
        customContext(() => {
          throw setupFailure
        })
      )
    ).rejects.toBe(setupFailure)
  })

  test("preserves a Context failure thrown after cancellation admission", async () => {
    let admit: (() => void) | null = null
    let throwNow = false
    const failure = new Error("late Context inspection failed")
    const ctx = customContext(
      (callback) => {
        admit = callback
        return () => false
      },
      () => {
        if (throwNow) throw failure
        return null
      }
    )
    const pending = newSnapshotQueue(1).next(ctx)
    throwNow = true
    if (admit === null) throw new Error("custom cancellation callback was not registered")
    ;(admit as () => void)()
    await expect(pending).rejects.toBe(failure)
  })
})
