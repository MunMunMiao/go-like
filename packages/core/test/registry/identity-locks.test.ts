import { expect, test } from "bun:test"

import { background, withCancelCause } from "../../src/context"
import { newIdentityLocks } from "../../src/registry/locks"

test("grants one identity at a time and counts holders and waiters", async () => {
  const locks = newIdentityLocks()
  expect(locks.size()).toBe(0)
  const first = await locks.acquire(background(), "node-a")
  expect(locks.size()).toBe(1)
  let secondGranted = false
  const second = locks.acquire(background(), "node-a").then((release) => {
    secondGranted = true
    return release
  })
  expect(locks.size()).toBe(1)
  first()
  first()
  const releaseSecond = await second
  expect(secondGranted).toBe(true)
  releaseSecond()
  expect(locks.size()).toBe(0)
})

test("rejects an invalid identity, a canceled context, and a waiter that loses the race", async () => {
  const locks = newIdentityLocks()
  expect(() => locks.acquire(background(), "")).toThrow("identity must be a non-empty string")
  const [ended, cancel] = withCancelCause(background())
  cancel(new Error("closed"))
  await expect(locks.acquire(ended, "node-a")).rejects.toThrow("closed")

  const held = await locks.acquire(background(), "node-b")
  const [waiting, stopWaiting] = withCancelCause(background())
  const pending = locks.acquire(waiting, "node-b")
  stopWaiting(new Error("give up"))
  await expect(pending).rejects.toThrow("give up")
  held()
  expect(locks.size()).toBe(0)
})

test("rejects when the context cannot register cancellation", async () => {
  const locks = newIdentityLocks()
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
  await expect(locks.acquire(hostile as never, "node-c")).rejects.toThrow("listen failed")
  const stringSignal = {
    aborted: false,
    addEventListener(): void {
      throw "listen failed"
    },
    removeEventListener(): void {}
  }
  const stringHostile = {
    deadline: () => [new Date(0), false] as const,
    done: () => stringSignal,
    err: () => null,
    value: () => undefined
  }
  await expect(locks.acquire(stringHostile as never, "node-d")).rejects.toThrow(
    "identity lock acquire failed"
  )
})
