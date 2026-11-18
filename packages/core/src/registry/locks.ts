import { afterFunc, cause, canceled, type Context } from "../context"

/** FIFO mutex keyed by registration identity. One set belongs to one registry instance. */
export interface IdentityLocks {
  /**
   * Resolves with an idempotent release once every earlier holder of `identity` released.
   * When `ctx` ends first it rejects with `ctx`'s cause and the abandoned position is skipped.
   */
  acquire(ctx: Context, identity: string): Promise<() => void>
  /** Identities that currently have a holder or a waiter. */
  size(): number
}

interface Waiter {
  readonly identity: string
  readonly queue: Waiter[]
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  stop: () => void
  granted: boolean
}

/** Creates identity locks. Do not share one set across registry instances. */
export function newIdentityLocks(): IdentityLocks {
  const queues = new Map<string, Waiter[]>()
  const held = new Set<string>()

  /** Grants the next waiter when the identity is free. */
  function grant(identity: string): void {
    if (held.has(identity)) return
    const queue = queues.get(identity)
    if (queue === undefined || queue.length === 0) {
      queues.delete(identity)
      return
    }
    const waiter = queue.shift()
    if (waiter === undefined) return
    if (queue.length === 0) queues.delete(identity)
    held.add(identity)
    waiter.granted = true
    waiter.stop()
    let released = false
    /** Releases this identity and admits the next waiter. A second call does nothing. */
    const release = (): void => {
      if (released) return
      released = true
      held.delete(identity)
      grant(identity)
    }
    waiter.resolve(release)
  }

  return {
    /** Waits for `identity` or rejects when `ctx` ends before the lock is granted. */
    acquire(ctx: Context, identity: string): Promise<() => void> {
      if (typeof identity !== "string" || identity.length === 0 || !identity.isWellFormed()) {
        throw new TypeError("identity must be a non-empty string")
      }
      const failure = cause(ctx)
      if (failure !== null) return Promise.reject(failure)
      const queue = queues.get(identity) ?? []
      if (!queues.has(identity)) queues.set(identity, queue)
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = {
          identity,
          queue,
          resolve,
          reject,
          stop: () => {},
          granted: false
        }
        queue.push(waiter)
        /** Drops an ungranted waiter and rejects with the Context cause. */
        const abandon = (): void => {
          if (waiter.granted) return
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
          if (queue.length === 0 && !held.has(identity)) queues.delete(identity)
          reject(cause(ctx) ?? ctx.err() ?? canceled)
          if (!held.has(identity)) grant(identity)
        }
        try {
          waiter.stop = afterFunc(ctx, abandon)
        } catch (error) {
          waiter.stop()
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
          if (queue.length === 0 && !held.has(identity)) queues.delete(identity)
          reject(error instanceof Error ? error : new TypeError("identity lock acquire failed"))
          return
        }
        grant(identity)
      })
    },
    /** Counts identities with a current holder or at least one waiter. */
    size(): number {
      const names = new Set<string>(held)
      for (const name of queues.keys()) names.add(name)
      return names.size
    }
  }
}
