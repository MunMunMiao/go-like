import { expect, test } from "bun:test"

import { background, withCancelCause } from "../../src/context"
import { newSnapshotWatcher } from "../../src/registry/snapshot-watcher"
import type { ServiceInstance } from "../../src/registry/types"

const instance: ServiceInstance = {
  id: "a",
  name: "orders",
  version: "1",
  metadata: {},
  endpoints: ["http://127.0.0.1:8080/"]
}

const replacement: ServiceInstance = {
  ...instance,
  id: "b",
  endpoints: ["http://127.0.0.1:8081/"]
}

test("queues the initial snapshot, drops duplicates, and overflows", async () => {
  const watcher = newSnapshotWatcher(background(), { initial: [instance], bufferSize: 1 })
  expect((await watcher.watcher.next(background()))[0]?.id).toBe("a")
  watcher.publish([instance])
  watcher.publish([replacement])
  watcher.publish([{ ...replacement, version: "2" }])
  await expect(watcher.watcher.next(background())).rejects.toThrow("watcher")
  await expect(watcher.watcher.next(background())).rejects.toThrow()
  watcher.wake()
  watcher.fail(new Error("again"))
  await watcher.watcher.stop(background())
})

test("publishes to a waiter, polls, and releases once", async () => {
  let polls = 0
  let released = 0
  const watcher = newSnapshotWatcher(background(), {
    initial: [],
    bufferSize: 2,
    intervalMs: 0,
    poll: async () => {
      polls += 1
      if (polls === 1) throw new Error("retry")
      if (polls === 2) return null
      return [instance]
    },
    backoff: () => 1,
    retryable: (error) => error instanceof Error && error.message === "retry",
    release: async () => {
      released += 1
      throw new Error("release failed")
    }
  })
  try {
    const next = watcher.watcher.next(background())
    watcher.wake()
    expect((await next)[0]?.id).toBe("a")
    const signal = {
      aborted: false,
      addEventListener(): void {
        throw new Error("listen failed")
      },
      removeEventListener(): void {}
    }
    const hostile = {
      deadline: () => [new Date(0), false] as const,
      done: () => signal,
      err: () => null,
      value: () => undefined
    }
    await expect(watcher.watcher.next(hostile as never)).rejects.toThrow("listen failed")
    watcher.fail("later" as never)
  } finally {
    await expect(watcher.watcher.stop(background())).rejects.toThrow("release failed")
    await expect(watcher.watcher.stop(background())).rejects.toThrow("release failed")
  }
  expect(released).toBe(1)
  expect(polls).toBeGreaterThan(1)
})

test("rejects invalid watcher options and an ended context", async () => {
  const [ctx, cancel] = withCancelCause(background())
  cancel(new Error("ended"))
  expect(() => newSnapshotWatcher(ctx, { initial: [], bufferSize: 1 })).toThrow("ended")
  expect(() => newSnapshotWatcher(background(), { initial: [], bufferSize: 0 })).toThrow(RangeError)
  expect(() =>
    newSnapshotWatcher(background(), { initial: [], bufferSize: 1, poll: "no" as never })
  ).toThrow(TypeError)
  expect(() =>
    newSnapshotWatcher(background(), {
      initial: [],
      bufferSize: 1,
      poll: async () => null,
      backoff: "no" as never
    })
  ).toThrow("backoff")
  expect(() =>
    newSnapshotWatcher(background(), {
      initial: [],
      bufferSize: 1,
      retryable: "no" as never
    })
  ).toThrow("retryable")
  expect(() =>
    newSnapshotWatcher(background(), { initial: [], bufferSize: 1, release: "no" as never })
  ).toThrow("release")
  expect(() =>
    newSnapshotWatcher(background(), { initial: [], bufferSize: 1, intervalMs: -1 })
  ).toThrow(RangeError)

  const [leaveCtx, leave] = withCancelCause(background())
  const leaving = newSnapshotWatcher(background(), { initial: [], bufferSize: 1 })
  const abandoned = leaving.watcher.next(leaveCtx)
  leave(new Error("leave"))
  await expect(abandoned).rejects.toThrow("leave")
  const waiting = leaving.watcher.next(background())
  leaving.fail(new Error("down"))
  await expect(waiting).rejects.toThrow("down")
  await leaving.watcher.stop(background())

  const invalid = newSnapshotWatcher(background(), {
    initial: [],
    bufferSize: 1,
    intervalMs: 0,
    poll: async () => "no" as never,
    backoff: () => 1,
    retryable: () => false
  })
  await expect(invalid.watcher.next(background())).rejects.toThrow("array")
  await invalid.watcher.stop(background())

  const ended = newSnapshotWatcher(background(), {
    initial: [],
    bufferSize: 1,
    intervalMs: 0,
    poll: async () => {
      throw new Error("gone")
    },
    backoff: () => 1,
    retryable: () => false
  })
  await expect(ended.watcher.next(background())).rejects.toThrow("gone")
  await ended.watcher.stop(background())

  const exploded = newSnapshotWatcher(background(), {
    initial: [],
    bufferSize: 1,
    intervalMs: 0,
    poll: async () => {
      throw new Error("poll")
    },
    backoff: () => 1,
    retryable: () => {
      throw new Error("retryable exploded")
    }
  })
  await expect(exploded.watcher.next(background())).rejects.toThrow("retryable exploded")
  await exploded.watcher.stop(background())

  const unretried = newSnapshotWatcher(background(), {
    initial: [],
    bufferSize: 1,
    intervalMs: 0,
    poll: async () => {
      throw new Error("once")
    },
    backoff: () => 1
  })
  await expect(unretried.watcher.next(background())).rejects.toThrow("once")
  await unretried.watcher.stop(background())
})
