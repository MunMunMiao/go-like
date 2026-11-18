import { expect, test } from "bun:test"

import { background, withCancelCause } from "../../src/context"
import { newSourceWatcher } from "../../src/config/source-watcher"

test("resolves a dirty watcher immediately and rejects a second waiter", async () => {
  const watcher = newSourceWatcher(background(), { dirty: true })
  await watcher.watcher.next(background())
  const pending = watcher.watcher.next(background())
  watcher.changed()
  await pending
  const busy = watcher.watcher.next(background())
  await expect(watcher.watcher.next(background())).rejects.toThrow("already waiting")
  watcher.fail(new Error("terminal"))
  await expect(busy).rejects.toThrow("terminal")
  await expect(watcher.watcher.next(background())).rejects.toThrow("terminal")
  watcher.changed()
  watcher.fail(new Error("again"))
  await watcher.watcher.stop(background())
})

test("polls until a change, then stop runs release once", async () => {
  let polls = 0
  let released = 0
  const watcher = newSourceWatcher(background(), {
    intervalMs: 0,
    poll: async () => {
      polls += 1
      if (polls === 1) throw new Error("retry")
      return polls > 2
    },
    backoff: () => 1,
    retryable: (error) => error instanceof Error && error.message === "retry",
    release: async () => {
      released += 1
      throw new Error("release failed")
    }
  })
  try {
    const pending = watcher.watcher.next(background())
    watcher.wake()
    await pending
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
    await watcher.watcher.stop(background())
    await watcher.watcher.stop(background())
  }
  expect(released).toBe(1)
})

test("stop rejects a pending next and invalid options throw", async () => {
  const watcher = newSourceWatcher(background())
  const pending = watcher.watcher.next(background())
  await watcher.watcher.stop(background())
  await expect(pending).rejects.toThrow("stopped")
  await expect(watcher.watcher.next(background())).rejects.toThrow("stopped")
  watcher.changed()

  const [ctx, cancel] = withCancelCause(background())
  cancel(new Error("ended"))
  expect(() => newSourceWatcher(ctx)).toThrow("ended")
  await expect(newSourceWatcher(background()).watcher.next(ctx)).rejects.toThrow("ended")
  expect(() => newSourceWatcher(background(), { poll: "no" as never })).toThrow(TypeError)
  expect(() =>
    newSourceWatcher(background(), { poll: async () => false, backoff: "no" as never })
  ).toThrow("backoff")
  expect(() => newSourceWatcher(background(), { retryable: "no" as never })).toThrow("retryable")
  expect(() => newSourceWatcher(background(), { release: "no" as never })).toThrow("release")
  expect(() => newSourceWatcher(background(), { intervalMs: -1 })).toThrow(RangeError)

  let polls = 0
  const terminal = newSourceWatcher(background(), {
    poll: async () => {
      polls += 1
      throw new Error("terminal")
    },
    backoff: () => 1,
    retryable: () => false
  })
  await expect(terminal.watcher.next(background())).rejects.toThrow("terminal")
  await terminal.watcher.stop(background())
  expect(polls).toBe(1)

  const [leaveCtx, leave] = withCancelCause(background())
  const leaving = newSourceWatcher(background())
  const abandoned = leaving.watcher.next(leaveCtx)
  leave(new Error("leave"))
  await expect(abandoned).rejects.toThrow("leave")
  await leaving.watcher.stop(background())

  const exploded = newSourceWatcher(background(), {
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

  const unretried = newSourceWatcher(background(), {
    intervalMs: 0,
    poll: async () => {
      throw new Error("once")
    },
    backoff: () => 1
  })
  await expect(unretried.watcher.next(background())).rejects.toThrow("once")
  await unretried.watcher.stop(background())
})
