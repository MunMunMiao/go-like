import { background, canceled, withCancel } from "@likego/context"
import type { Context } from "@likego/context"

import type { ConformanceCase } from "./index"

/** Exposes the lifecycle shared by runtime listener implementations under test. */
export interface ListenerConformanceHandle {
  /** Returns the actual bound address. */
  address(): string
  /** Returns one stable terminal PromiseLike. */
  done(): PromiseLike<void>
  /** Idempotently closes the listener while ctx bounds only the caller's wait. */
  close(ctx: Context): PromiseLike<void>
}

/** Adds executable lifecycle probes required by resident listener providers. */
export interface ListenerLifecycleConformanceHandle extends ListenerConformanceHandle {
  /** Waits until the already-bound listener can admit work. */
  ready(): PromiseLike<void>
  /** Requests the provider's real force primitive without implying terminal. */
  force(reason: Error): PromiseLike<void>
  /** Injects one passive provider failure at the real runtime boundary. */
  fail(error: Error): void | PromiseLike<void>
  /** Performs a real rebind of the released listener address. */
  rebind(): PromiseLike<void>
}

/** Creates a fresh bound listener handle for one isolated conformance case. */
export type ListenerFactory = () =>
  | ListenerConformanceHandle
  | PromiseLike<ListenerConformanceHandle>

/** Names the runner-neutral cases produced for one listener factory. */
export type ListenerConformanceCase = ConformanceCase

interface OperationOutcome {
  readonly rejected: boolean
  readonly value: unknown
}

const cleanupTimeoutMs = 1_000

/** Fails one listener conformance assertion with a stable diagnostic. */
function fail(message: string): never {
  throw new Error(message)
}

/** Returns whether an operation is still pending after one microtask checkpoint. */
async function remainsPending(operation: PromiseLike<unknown>): Promise<boolean> {
  let settled = false
  /** Records either terminal outcome through one shared callable. */
  function markSettled(): void {
    settled = true
  }
  void Promise.resolve(operation).then(markSettled, markSettled)
  await Promise.resolve()
  return !settled
}

/** Returns whether value exposes a callable PromiseLike continuation. */
function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof Reflect.get(value, "then") === "function"
    : false
}

/** Captures one complete structural handle and its original method receiver. */
function snapshotHandle(value: unknown): ListenerConformanceHandle {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("listener conformance factory must return an object")
  }
  const address = Reflect.get(value, "address")
  const done = Reflect.get(value, "done")
  const close = Reflect.get(value, "close")
  if (typeof address !== "function") throw new TypeError("listener address must be a function")
  if (typeof done !== "function") throw new TypeError("listener done must be a function")
  if (typeof close !== "function") throw new TypeError("listener close must be a function")
  return Object.freeze({
    /** Calls the captured address method with its original structural receiver. */
    address(): string {
      const result: unknown = Reflect.apply(address, value, [])
      if (typeof result !== "string") {
        throw new TypeError("Listener address must be a stable non-empty string")
      }
      return result
    },
    /** Calls and validates the captured terminal method. */
    done(): PromiseLike<void> {
      const terminal: unknown = Reflect.apply(done, value, [])
      if (!isPromiseLike(terminal)) throw new TypeError("Listener done must return a PromiseLike")
      return terminal
    },
    /** Calls and validates the captured close method. */
    close(ctx: Context): PromiseLike<void> {
      const closing: unknown = Reflect.apply(close, value, [ctx])
      if (!isPromiseLike(closing)) throw new TypeError("Listener close must return a PromiseLike")
      return closing
    }
  })
}

/** Invokes one validated factory and admits its complete structural handle. */
async function createHandle(factory: ListenerFactory): Promise<ListenerConformanceHandle> {
  return snapshotHandle(await factory())
}

/** Captures one required executable lifecycle probe. */
function lifecycleCallable(value: object, name: string): Function {
  const method: unknown = Reflect.get(value, name)
  if (typeof method !== "function") {
    throw new TypeError(`listener lifecycle ${name} must be a function`)
  }
  return method
}

/** Captures the extended resident-listener lifecycle with original receivers. */
function snapshotLifecycleHandle(value: unknown): ListenerLifecycleConformanceHandle {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("listener conformance factory must return an object")
  }
  const receiver = value
  const base = snapshotHandle(receiver)
  const ready = lifecycleCallable(receiver, "ready")
  const force = lifecycleCallable(receiver, "force")
  const failProvider = lifecycleCallable(receiver, "fail")
  const rebind = lifecycleCallable(receiver, "rebind")
  return Object.freeze({
    address: base.address,
    done: base.done,
    close: base.close,
    /** Calls and validates the provider readiness probe. */
    ready(): PromiseLike<void> {
      const result: unknown = Reflect.apply(ready, receiver, [])
      if (!isPromiseLike(result))
        throw new TypeError("listener lifecycle ready must return a PromiseLike")
      return result
    },
    /** Calls and validates the provider force probe. */
    force(reason: Error): PromiseLike<void> {
      const result: unknown = Reflect.apply(force, receiver, [reason])
      if (!isPromiseLike(result))
        throw new TypeError("listener lifecycle force must return a PromiseLike")
      return result
    },
    /** Calls the provider's passive-failure injection boundary. */
    fail(error: Error): void | PromiseLike<void> {
      const result: unknown = Reflect.apply(failProvider, receiver, [error])
      if (result !== undefined && !isPromiseLike(result)) {
        throw new TypeError("listener lifecycle fail must return void or a PromiseLike")
      }
      return result
    },
    /** Calls and validates the provider's real port-rebind proof. */
    rebind(): PromiseLike<void> {
      const result: unknown = Reflect.apply(rebind, receiver, [])
      if (!isPromiseLike(result))
        throw new TypeError("listener lifecycle rebind must return a PromiseLike")
      return result
    }
  })
}

/** Creates one extended lifecycle handle for an isolated conformance case. */
async function createLifecycleHandle(
  factory: ListenerFactory
): Promise<ListenerLifecycleConformanceHandle> {
  return snapshotLifecycleHandle(await factory())
}

/** Captures fulfillment or rejection without losing non-Error identities. */
async function outcome(operation: PromiseLike<void>): Promise<OperationOutcome> {
  try {
    await operation
    return Object.freeze({ rejected: false, value: undefined })
  } catch (failure) {
    return Object.freeze({ rejected: true, value: failure })
  }
}

/** Waits a bounded interval for one already-observed started-operation outcome. */
async function boundStartedOutcome(
  operation: PromiseLike<OperationOutcome>
): Promise<OperationOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), cleanupTimeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve(operation), timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Bounds one cleanup item without allowing a broken implementation to hang the suite. */
async function boundCleanup(
  operation: () => void | PromiseLike<void>,
  label: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} cleanup exceeded ${cleanupTimeoutMs}ms`))
    }, cleanupTimeoutMs)
  })
  const running = Promise.resolve().then(operation)
  try {
    await Promise.race([running, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Closes one listener and observes its terminal as independently bounded cleanup items. */
async function closeHandle(handle: ListenerConformanceHandle): Promise<void> {
  const failures: unknown[] = []
  const closing = await outcome(boundCleanup(() => handle.close(background()), "listener close"))
  if (closing.rejected) failures.push(closing.value)
  const terminal = await outcome(boundCleanup(() => handle.done(), "listener done"))
  if (terminal.rejected) failures.push(terminal.value)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "listener cleanup failed")
}

/** Runs one assertion and still closes the listener before returning its failure. */
async function verifyWithClose(
  handle: ListenerConformanceHandle,
  verify: () => void | Promise<void>
): Promise<void> {
  let primaryRejected = false
  let primary: unknown
  try {
    await verify()
  } catch (failure) {
    primaryRejected = true
    primary = failure
  }
  let cleanupRejected = false
  let cleanup: unknown
  try {
    await closeHandle(handle)
  } catch (failure) {
    cleanupRejected = true
    cleanup = failure
  }
  if (primaryRejected && cleanupRejected) {
    const failures: unknown[] = [primary]
    if (cleanup instanceof AggregateError) {
      for (const failure of cleanup.errors) failures.push(failure)
    } else {
      failures.push(cleanup)
    }
    throw new AggregateError(failures, "listener conformance assertion and cleanup failed")
  }
  if (primaryRejected) throw primary
  if (cleanupRejected) throw cleanup
}

/** Verifies that address is a stable non-empty string before and after close. */
async function exposesStableAddress(factory: ListenerFactory): Promise<void> {
  const handle = await createHandle(factory)
  let address = ""
  await verifyWithClose(handle, () => {
    const first = handle.address()
    const second = handle.address()
    if (
      typeof first !== "string" ||
      typeof second !== "string" ||
      first.length === 0 ||
      first !== second
    ) {
      fail("Listener address must be a stable non-empty string")
    }
    address = first
  })
  if (handle.address() !== address) fail("Listener address must remain stable after close")
}

/** Verifies that done returns one stable terminal Promise. */
async function exposesStableDone(factory: ListenerFactory): Promise<void> {
  const handle = await createHandle(factory)
  await verifyWithClose(handle, () => {
    if (handle.done() !== handle.done()) fail("Listener done must return the same Promise")
  })
}

/** Verifies that concurrent close calls join one cleanup and settle done. */
async function closeIsIdempotent(factory: ListenerFactory): Promise<void> {
  const handle = await createHandle(factory)
  const stableDone = handle.done()
  const done = Promise.resolve(stableDone)
  await verifyWithClose(handle, async () => {
    await Promise.all([handle.close(background()), handle.close(background())])
    if (await remainsPending(done)) {
      fail("Listener.close must not resolve before Listener.done settles")
    }
    await done
    await handle.close(background())
    if (handle.done() !== stableDone) fail("Listener done changed after close")
  })
}

/** Verifies that pre-canceled and started-canceled callers cannot cancel owner cleanup. */
async function callerCancellationIsScoped(factory: ListenerFactory): Promise<void> {
  const handle = await createHandle(factory)
  await verifyWithClose(handle, async () => {
    const [ctx, cancel] = withCancel(background())
    cancel()
    let observed: unknown = null
    try {
      await handle.close(ctx)
    } catch (failure) {
      observed = failure
    }
    if (observed !== canceled) {
      fail("a pre-canceled Listener.close caller must receive context canceled")
    }

    const terminal = Promise.resolve(handle.done())
    const [startedCtx, cancelStarted] = withCancel(background())
    const started = outcome(Promise.resolve().then(() => handle.close(startedCtx)))
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    const pending = await remainsPending(started)
    if (pending) cancelStarted()
    const startedResult = pending ? await boundStartedOutcome(started) : await started
    if (!pending) cancelStarted()
    let startedAssertion: Error | null = null
    if (startedResult === null) {
      startedAssertion = new Error(
        `started Listener.close cancellation did not settle within ${cleanupTimeoutMs}ms`
      )
    } else if (
      (pending && !startedResult.rejected) ||
      (startedResult.rejected && startedResult.value !== canceled)
    ) {
      startedAssertion = new Error("a started Listener.close caller must receive context canceled")
    }

    const joining = outcome(Promise.resolve().then(() => handle.close(background())))
    if (startedAssertion !== null) {
      throw startedAssertion
    }
    const joined = await joining
    if (joined.rejected) {
      throw new Error("a later Listener.close caller must join owner cleanup", {
        cause: joined.value
      })
    }
    if (await remainsPending(terminal)) {
      fail("a later Listener.close must not resolve before Listener.done settles")
    }
    await terminal
  })
}

/** Verifies that readiness follows a real bind and retains the actual address. */
async function readinessFollowsBind(factory: ListenerFactory): Promise<void> {
  const handle = await createLifecycleHandle(factory)
  const before = handle.address()
  await handle.ready()
  if (before.length === 0 || handle.address() !== before) {
    fail("listener readiness must retain one actual bound address")
  }
  await closeHandle(handle)
}

/** Verifies force convergence without treating force invocation as terminal. */
async function forceConverges(factory: ListenerFactory): Promise<void> {
  const handle = await createLifecycleHandle(factory)
  await handle.ready()
  const stableDone = handle.done()
  await handle.force(new Error("listener conformance force"))
  await boundCleanup(
    /** Returns the already-captured forced terminal for bounded observation. */
    function waitForcedTerminal(): PromiseLike<void> {
      return stableDone
    },
    "listener force terminal"
  )
  if (handle.done() !== stableDone) fail("listener force replaced the stable done Promise")
}

/** Verifies a passive provider failure keeps its exact Error identity. */
async function passiveFailurePreservesIdentity(factory: ListenerFactory): Promise<void> {
  const handle = await createLifecycleHandle(factory)
  await handle.ready()
  const expected = new Error("listener conformance passive failure")
  const triggered = handle.fail(expected)
  if (triggered !== undefined) await triggered
  const terminal = await outcome(handle.done())
  if (!terminal.rejected || terminal.value !== expected) {
    fail("passive listener failure must preserve Error identity")
  }
}

/** Verifies terminal cleanup by executing the provider's real rebind probe. */
async function terminalReleasesPort(factory: ListenerFactory): Promise<void> {
  const handle = await createLifecycleHandle(factory)
  await handle.ready()
  await closeHandle(handle)
  await boundCleanup(
    /** Executes the provider's exact-port rebind after terminal cleanup. */
    function rebindReleasedPort(): PromiseLike<void> {
      return handle.rebind()
    },
    "listener port rebind"
  )
}

/** Builds isolated, runner-neutral black-box cases for one listener lifecycle. */
export function listenerConformanceCases(
  factory: ListenerFactory
): readonly ListenerConformanceCase[] {
  if (typeof factory !== "function") {
    throw new TypeError("listener conformance factory must be a function")
  }
  return Object.freeze([
    Object.freeze({
      name: "listener exposes one stable non-empty address",
      /** Runs the stable-address assertion. */
      run: async () => exposesStableAddress(factory)
    }),
    Object.freeze({
      name: "listener exposes one stable done promise",
      /** Runs the stable-terminal-Promise assertion. */
      run: async () => exposesStableDone(factory)
    }),
    Object.freeze({
      name: "listener close is idempotent and resolves done",
      /** Runs the idempotent-close assertion. */
      run: async () => closeIsIdempotent(factory)
    }),
    Object.freeze({
      name: "pre-canceled and started close callers do not cancel shared listener cleanup",
      /** Runs the caller-scoped cancellation assertion. */
      run: async () => callerCancellationIsScoped(factory)
    }),
    Object.freeze({
      name: "listener readiness follows real bind",
      /** Runs the executable bind-to-readiness assertion. */
      run: async () => readinessFollowsBind(factory)
    }),
    Object.freeze({
      name: "listener force converges on stable done",
      /** Runs the executable force-to-terminal assertion. */
      run: async () => forceConverges(factory)
    }),
    Object.freeze({
      name: "passive listener failure preserves Error identity",
      /** Runs the executable passive-failure assertion. */
      run: async () => passiveFailurePreservesIdentity(factory)
    }),
    Object.freeze({
      name: "listener terminal releases its bound port",
      /** Runs the executable true-port-rebind assertion. */
      run: async () => terminalReleasesPort(factory)
    })
  ])
}
