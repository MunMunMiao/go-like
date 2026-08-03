import { runInNewContext } from "node:vm"

import { expect, test } from "bun:test"

import {
  background,
  canceled,
  cause,
  deadlineExceeded,
  withCancel,
  withCancelCause,
  type Context
} from "@likego/context"
import { get } from "@likego/metadata"
import {
  codec,
  secure,
  fromServerContext,
  timeout,
  tlsConfig,
  withConnClose,
  type Client,
  type Listener,
  type Message,
  type MessageCodec,
  type TransportInfo
} from "@likego/transport"
import { endpoint, request } from "@likego/transport/headers"

import { newMemoryTransport } from "../src/index"
import { failMemoryListener } from "../src/testing"

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

/** Creates one externally released Promise. */
function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  const promise = new Promise<T>(function capture(resolve): void {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value)
    }
  }
}

/** Returns a rejected Error without accepting a fulfilled operation. */
async function rejected(work: PromiseLike<unknown>): Promise<Error> {
  try {
    await work
  } catch (failure) {
    if (failure instanceof Error) return failure
    throw new Error("operation rejected with a non-Error", { cause: failure })
  }
  throw new Error("operation unexpectedly fulfilled")
}

/** Reads one stable structural error code. */
function errorCode(value: Error): unknown {
  return "code" in value ? value.code : null
}

/** Runs one send/recv exchange. */
async function exchange(ctx: Context, client: Client, message: Message): Promise<Message> {
  await client.send(ctx, message)
  return await client.recv(ctx)
}

/** Starts one echo accept loop and returns its terminal Promise. */
function echo(listener: Listener, ctx: Context): Promise<void> {
  return listener.accept(ctx, async function handle(handlerContext, socket): Promise<void> {
    const message = await socket.recv(handlerContext)
    await socket.send(handlerContext, message)
  })
}

test("owns an exact private address map and releases only the closing listener", async () => {
  const first = newMemoryTransport()
  const isolated = newMemoryTransport()
  const alpha = await first.listen(background(), "memory://ALPHA")
  const beta = await first.listen(background(), "memory://beta")
  expect(alpha.addr()).toBe("memory://alpha/")
  expect(beta.addr()).toBe("memory://beta/")

  expect(errorCode(await rejected(first.listen(background(), "memory://alpha/")))).toBe(
    "LIKEGO_TRANSPORT_STATE"
  )
  expect(errorCode(await rejected(first.dial(background(), "memory://missing")))).toBe(
    "LIKEGO_TRANSPORT_STATE"
  )
  expect(errorCode(await rejected(isolated.dial(background(), alpha.addr())))).toBe(
    "LIKEGO_TRANSPORT_STATE"
  )

  const alphaAccept = echo(alpha, background())
  const betaAccept = echo(beta, background())
  const alphaClient = await first.dial(background(), alpha.addr())
  const betaClient = await first.dial(background(), beta.addr())
  expect(
    (
      await exchange(background(), betaClient, {
        header: { route: "beta" },
        body: new Uint8Array([2])
      })
    ).header.route
  ).toBe("beta")

  await alpha.close(background())
  await alphaAccept
  expect(
    errorCode(
      await rejected(alphaClient.send(background(), { header: {}, body: new Uint8Array() }))
    )
  ).toBe("LIKEGO_TRANSPORT_CLOSED")
  expect(
    (
      await exchange(background(), betaClient, {
        header: { route: "still-beta" },
        body: new Uint8Array([3])
      })
    ).header.route
  ).toBe("still-beta")

  const rebound = await first.listen(background(), "memory://alpha")
  const reboundAccept = echo(rebound, background())
  const reboundClient = await first.dial(background(), rebound.addr())
  expect(
    (
      await exchange(background(), reboundClient, {
        header: { route: "new" },
        body: new Uint8Array([4])
      })
    ).header.route
  ).toBe("new")

  await reboundClient.close(background())
  await rebound.close(background())
  await reboundAccept
  await betaClient.close(background())
  await beta.close(background())
  await betaAccept
})

test("preserves concurrent FIFO replies, defensive Message copies, and server TransportInfo", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://orders")
  const releaseFirst = deferred<void>()
  const secondSent = deferred<void>()
  const infos: TransportInfo[] = []
  const accept = listener.accept(background(), async function handle(ctx, socket): Promise<void> {
    const message = await socket.recv(ctx)
    const info = fromServerContext(ctx)
    if (info === null) throw new Error("server TransportInfo is missing")
    infos.push(info)
    const sequence = message.header.sequence
    if (sequence === undefined) throw new Error("sequence header is missing")
    if (sequence === "first") await releaseFirst.promise
    const responseHeader = { sequence, observed: "yes" }
    const responseBody = message.body
    await socket.send(ctx, { header: responseHeader, body: responseBody })
    responseHeader.observed = "changed"
    responseBody[0] = 99
    if (sequence === "second") secondSent.resolve(undefined)
  })
  const client = await transport.dial(background(), listener.addr())
  expect(client.local()).toBe("memory://client/1")
  expect(client.remote()).toBe(listener.addr())
  const firstHeader = {
    [request]: "orders",
    [endpoint]: "Orders.Get",
    sequence: "first"
  }
  const firstBody = new Uint8Array([1])
  const firstSend = client.send(background(), { header: firstHeader, body: firstBody })
  firstHeader.sequence = "mutated"
  firstBody[0] = 88
  const secondSend = client.send(background(), {
    header: { [request]: "orders", [endpoint]: "Orders.Get", sequence: "second" },
    body: new Uint8Array([2])
  })
  await secondSent.promise
  releaseFirst.resolve(undefined)
  await Promise.all([firstSend, secondSend])

  const first = await client.recv(background())
  const second = await client.recv(background())
  expect(first.header).toEqual({ sequence: "first", observed: "yes" })
  expect(first.body).toEqual(new Uint8Array([1]))
  expect(second.header.sequence).toBe("second")
  expect(second.body).toEqual(new Uint8Array([2]))
  expect(infos).toHaveLength(2)
  for (const info of infos) {
    expect(info.kind()).toBe("memory")
    expect(info.endpoint()).toBe(listener.addr())
    expect(info.operation()).toBe("orders/Orders.Get")
    expect(get(info.requestHeaders(), request)).toBe("orders")
    expect(get(info.replyHeaders(), "observed")).toBe("yes")
  }

  await client.close(background())
  await listener.close(background())
  await accept
})

test("cancels one active exchange without closing its Client", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://cancel")
  const blocked = deferred<void>()
  const started = deferred<void>()
  const accept = listener.accept(background(), async function handle(ctx, socket): Promise<void> {
    const message = await socket.recv(ctx)
    expect(socket.local()).toBe(listener.addr())
    expect(socket.remote()).toBe(client.local())
    if (message.header.mode === "blocked") {
      started.resolve(undefined)
      await blocked.promise
      const failure = ctx.err()
      if (failure !== null) throw failure
    }
    await socket.send(ctx, message)
  })
  const client = await transport.dial(background(), listener.addr())
  const operation = withCancel(background())
  const sending = client.send(operation[0], {
    header: { mode: "blocked" },
    body: new Uint8Array([1])
  })
  await started.promise
  operation[1]()
  expect(await rejected(sending)).toBe(canceled)
  blocked.resolve(undefined)

  const healthy = await exchange(background(), client, {
    header: { mode: "healthy" },
    body: new Uint8Array([2])
  })
  expect(healthy.header.mode).toBe("healthy")

  await client.close(background())
  await listener.close(background())
  await accept
})

test("rechecks client admission after hostile request getters close or cancel synchronously", async () => {
  const closingTransport = newMemoryTransport()
  const closingListener = await closingTransport.listen(background(), "memory://getter-close")
  let handled = 0
  const closingAccept = closingListener.accept(
    background(),
    async function handle(ctx, socket): Promise<void> {
      handled += 1
      await socket.send(ctx, await socket.recv(ctx))
    }
  )
  const closingClient = await closingTransport.dial(background(), closingListener.addr())
  let closeWork: Promise<void> | null = null
  const closingMessage: Message = {
    /** Closes the listener inside the transport Message snapshot. */
    get header(): Readonly<Record<string, string>> {
      closeWork = closingListener.close(background())
      return {}
    },
    body: new Uint8Array()
  }
  expect(errorCode(await rejected(closingClient.send(background(), closingMessage)))).toBe(
    "LIKEGO_TRANSPORT_CLOSED"
  )
  await closeWork
  await closingAccept
  expect(handled).toBe(0)

  const cancelingTransport = newMemoryTransport()
  const cancelingListener = await cancelingTransport.listen(background(), "memory://getter-cancel")
  const cancelingAccept = echo(cancelingListener, background())
  const cancelingClient = await cancelingTransport.dial(background(), cancelingListener.addr())
  const operation = withCancelCause(background())
  const operationCause = new Error("request getter canceled the operation")
  const cancelingMessage: Message = {
    /** Cancels the caller inside the transport Message snapshot. */
    get header(): Readonly<Record<string, string>> {
      operation[1](operationCause)
      return {}
    },
    body: new Uint8Array()
  }
  expect(await rejected(cancelingClient.send(operation[0], cancelingMessage))).toBe(operationCause)
  expect(
    (
      await exchange(background(), cancelingClient, {
        header: { phase: "healthy" },
        body: new Uint8Array([1])
      })
    ).header.phase
  ).toBe("healthy")
  await cancelingClient.close(background())
  await cancelingListener.close(background())
  await cancelingAccept
})

test("rolls back failed provisional accept admission without leaving a ghost handler", async () => {
  /** Proves one rejected provisional Context leaves the Listener reusable and handler-free. */
  async function proveRollback(
    ctx: Context,
    expected: Error | null,
    address: string
  ): Promise<void> {
    const transport = newMemoryTransport()
    const listener = await transport.listen(background(), address)
    let handled = 0
    const rejectedAccept = listener.accept(
      ctx,
      async function ghost(handlerContext, socket): Promise<void> {
        handled += 1
        const message = await socket.recv(handlerContext)
        await socket.send(handlerContext, message)
      }
    )
    const admissionFailure = await rejected(rejectedAccept)
    if (expected === null) expect(admissionFailure).toBeInstanceOf(TypeError)
    else expect(admissionFailure).toBe(expected)

    const client = await transport.dial(background(), listener.addr())
    expect(
      errorCode(
        await rejected(
          client.send(background(), { header: { phase: "ghost" }, body: new Uint8Array() })
        )
      )
    ).toBe("LIKEGO_TRANSPORT_STATE")
    expect(handled).toBe(0)

    const accepting = echo(listener, background())
    expect(
      (
        await exchange(background(), client, {
          header: { phase: "retry" },
          body: new Uint8Array([1])
        })
      ).header.phase
    ).toBe("retry")
    await client.close(background())
    await listener.close(background())
    await accepting
  }

  const parent = background()
  const doneFailure = new Error("accept Context done failed")
  let doneReads = 0
  const doneContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal | null {
      doneReads += 1
      if (doneReads === 1) throw doneFailure
      return null
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  await proveRollback(doneContext, doneFailure, "memory://accept-done-rollback")

  const addFailure = new Error("accept signal add failed")
  let adds = 0
  let removes = 0
  const hostileSignal = {
    addEventListener(): void {
      adds += 1
      throw addFailure
    },
    removeEventListener(): void {
      removes += 1
    }
  }
  const addContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return hostileSignal as never
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  await proveRollback(addContext, addFailure, "memory://accept-add-rollback")
  expect([adds, removes]).toEqual([1, 1])

  const errFailure = new Error("accept Context final err failed")
  let errReads = 0
  const errContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): null {
      return null
    },
    err(): null {
      errReads += 1
      if (errReads === 2) throw errFailure
      return null
    },
    value: parent.value
  })
  await proveRollback(errContext, errFailure, "memory://accept-err-rollback")

  let abortAdds = 0
  let abortRemoves = 0
  const abortingSignal = {
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
      abortAdds += 1
      if (typeof listener === "function") listener(new Event("abort"))
      else listener.handleEvent(new Event("abort"))
    },
    removeEventListener(): void {
      abortRemoves += 1
    }
  }
  const abortingContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return abortingSignal as never
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  await proveRollback(abortingContext, canceled, "memory://accept-abort-rollback")
  expect([abortAdds, abortRemoves]).toEqual([1, 1])

  const invalidSignalContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return Object.freeze({}) as never
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  await proveRollback(invalidSignalContext, null, "memory://accept-signal-shape")
})

test("removes provisional cancellation listeners and reports terminal removal failure", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://accept-add-close")
  const parent = background()
  let adds = 0
  let removes = 0
  let closeWork: Promise<void> | null = null
  const closingSignal = {
    addEventListener(): void {
      adds += 1
      closeWork = listener.close(background())
    },
    removeEventListener(): void {
      removes += 1
    }
  }
  const closingContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return closingSignal as never
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  expect(
    errorCode(await rejected(listener.accept(closingContext, function unreachable(): void {})))
  ).toBe("LIKEGO_TRANSPORT_CLOSED")
  await closeWork
  expect([adds, removes]).toEqual([1, 1])

  const failedTransport = newMemoryTransport()
  const failedListener = await failedTransport.listen(
    background(),
    "memory://accept-remove-failure"
  )
  const removalFailure = new Error("accept cancellation removal failed")
  const failingSignal = {
    addEventListener(): void {},
    removeEventListener(): never {
      throw removalFailure
    }
  }
  const failingContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return failingSignal as never
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  const accepting = failedListener.accept(failingContext, function unreachable(): void {})
  const firstClose = rejected(failedListener.close(background()))
  expect(await firstClose).toBe(removalFailure)
  expect(await rejected(accepting)).toBe(removalFailure)
  expect(await rejected(failedListener.close(background()))).toBe(removalFailure)

  const aggregateTransport = newMemoryTransport()
  const aggregateListener = await aggregateTransport.listen(
    background(),
    "memory://accept-admission-cleanup-failure"
  )
  const addFailure = new Error("accept add failed after registration")
  const admissionRemovalFailure = new Error("accept provisional removal failed")
  const aggregateSignal = {
    addEventListener(): never {
      throw addFailure
    },
    removeEventListener(): never {
      throw admissionRemovalFailure
    }
  }
  const aggregateContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return aggregateSignal as never
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  const aggregate = await rejected(
    aggregateListener.accept(aggregateContext, function unreachable(): void {})
  )
  expect(aggregate).toBeInstanceOf(AggregateError)
  expect((aggregate as AggregateError).errors).toEqual([addFailure, admissionRemovalFailure])
  await aggregateListener.close(background())

  /** Builds a Context whose listener registration cancels its true owner before throwing. */
  function cancelingRegistrationContext(
    cancellationCause: Error,
    registrationFailure: Error,
    removalFailure: Error | null
  ): Context {
    const operation = withCancelCause(background())
    const signal = operation[0].done()
    if (signal === null) throw new Error("cancelable Context signal is missing")
    const wrappedSignal = {
      get aborted(): boolean {
        return signal.aborted
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions | boolean
      ): never {
        signal.addEventListener(type, listener, options)
        operation[1](cancellationCause)
        throw registrationFailure
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions | boolean
      ): void {
        signal.removeEventListener(type, listener, options)
        if (removalFailure !== null) throw removalFailure
      }
    }
    return Object.freeze({
      deadline(): readonly [Date, boolean] {
        return operation[0].deadline()
      },
      done(): AbortSignal {
        return wrappedSignal as never
      },
      err(): ReturnType<Context["err"]> {
        return operation[0].err()
      },
      value(key: unknown): unknown {
        return operation[0].value(key)
      }
    })
  }

  const canceledAddTransport = newMemoryTransport()
  const canceledAddListener = await canceledAddTransport.listen(
    background(),
    "memory://accept-cancel-add-failure"
  )
  const canceledAddCause = new Error("accept registration canceled owner")
  const canceledAddFailure = new Error("accept registration failed after cancellation")
  expect(
    await rejected(
      canceledAddListener.accept(
        cancelingRegistrationContext(canceledAddCause, canceledAddFailure, null),
        function unreachable(): void {}
      )
    )
  ).toBe(canceledAddCause)
  const canceledAddAccept = echo(canceledAddListener, background())
  await canceledAddListener.close(background())
  await canceledAddAccept

  const canceledAggregateTransport = newMemoryTransport()
  const canceledAggregateListener = await canceledAggregateTransport.listen(
    background(),
    "memory://accept-cancel-add-remove-failure"
  )
  const canceledAggregateCause = new Error("accept aggregate canceled owner")
  const canceledAggregateAdd = new Error("accept aggregate registration failed")
  const canceledAggregateRemoval = new Error("accept aggregate listener removal failed")
  const canceledAggregate = await rejected(
    canceledAggregateListener.accept(
      cancelingRegistrationContext(
        canceledAggregateCause,
        canceledAggregateAdd,
        canceledAggregateRemoval
      ),
      function unreachable(): void {}
    )
  )
  expect(canceledAggregate).toBeInstanceOf(AggregateError)
  expect((canceledAggregate as AggregateError).errors).toEqual([
    canceledAggregateCause,
    canceledAggregateRemoval
  ])
  await canceledAggregateListener.close(background())

  const observationTransport = newMemoryTransport()
  const observationListener = await observationTransport.listen(
    background(),
    "memory://accept-abort-observation-failure"
  )
  const observationFailure = new Error("accept cancellation observation failed")
  const abortSlot: { listener: EventListener | null } = { listener: null }
  const observationSignal = {
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
      if (typeof listener === "function") abortSlot.listener = listener
    },
    removeEventListener(): void {
      abortSlot.listener = null
    }
  }
  let observationErrReads = 0
  const observationContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return observationSignal as never
    },
    err(): null {
      observationErrReads += 1
      if (observationErrReads === 3) throw observationFailure
      return null
    },
    value: parent.value
  })
  const observing = observationListener.accept(observationContext, function unreachable(): void {})
  abortSlot.listener?.(new Event("abort"))
  expect(await rejected(observing)).toBe(observationFailure)
  await observationListener.close(background())
})

test("isolates caller wait-listener cleanup failures from every winning outcome", async () => {
  /** Creates one externally canceled Context whose observer removal always fails. */
  function hostileWaitContext(removalFailure: Error): {
    readonly ctx: Context
    cancel(failure: Error): void
    removals(): number
  } {
    const parent = background()
    let terminal: Error | null = null
    let listener: EventListener | null = null
    let removalCalls = 0
    const signal = {
      get aborted(): boolean {
        return terminal !== null
      },
      addEventListener(_type: string, candidate: EventListenerOrEventListenerObject): void {
        if (typeof candidate === "function") listener = candidate
      },
      removeEventListener(): never {
        removalCalls += 1
        listener = null
        throw removalFailure
      }
    }
    const ctx: Context = Object.freeze({
      deadline: parent.deadline,
      done(): AbortSignal {
        return signal as never
      },
      err(): Error | null {
        return terminal
      },
      value: parent.value
    })
    return Object.freeze({
      ctx,
      cancel(failure: Error): void {
        if (terminal !== null) return
        terminal = failure
        listener?.(new Event("abort"))
      },
      removals(): number {
        return removalCalls
      }
    })
  }

  const resolvedTransport = newMemoryTransport()
  const resolvedListener = await resolvedTransport.listen(background(), "memory://wait-resolved")
  const resolvedRemoval = new Error("resolved wait listener removal failed")
  const resolvedContext = hostileWaitContext(resolvedRemoval)
  await resolvedListener.close(resolvedContext.ctx)
  expect(resolvedContext.removals()).toBe(1)

  const inspectionTransport = newMemoryTransport()
  const inspectionListener = await inspectionTransport.listen(
    background(),
    "memory://wait-inspection-failure"
  )
  const inspectionFailure = new Error("wait Context inspection failed")
  let inspectionReads = 0
  const inspectionParent = background()
  const inspectionContext: Context = Object.freeze({
    deadline: inspectionParent.deadline,
    done(): null {
      return null
    },
    err(): null {
      inspectionReads += 1
      if (inspectionReads === 2) throw inspectionFailure
      return null
    },
    value: inspectionParent.value
  })
  expect(await rejected(inspectionListener.close(inspectionContext))).toBe(inspectionFailure)

  const registrationTransport = newMemoryTransport()
  const registrationListener = await registrationTransport.listen(
    background(),
    "memory://wait-registration-failure"
  )
  const registrationFailure = new Error("wait cancellation registration failed")
  const registrationSignal = {
    aborted: false,
    addEventListener(): never {
      throw registrationFailure
    },
    removeEventListener(): void {}
  }
  const registrationContext: Context = Object.freeze({
    deadline: inspectionParent.deadline,
    done(): AbortSignal {
      return registrationSignal as never
    },
    err(): null {
      return null
    },
    value: inspectionParent.value
  })
  expect(await rejected(registrationListener.close(registrationContext))).toBe(registrationFailure)

  const reinspectionTransport = newMemoryTransport()
  const reinspectionListener = await reinspectionTransport.listen(
    background(),
    "memory://wait-reinspection-failure"
  )
  const reinspectionRegistrationFailure = new Error("wait registration remained primary")
  const reinspectionFailure = new Error("wait Context reinspection also failed")
  let reinspectionReads = 0
  const reinspectionSignal = {
    aborted: false,
    addEventListener(): never {
      throw reinspectionRegistrationFailure
    },
    removeEventListener(): void {}
  }
  const reinspectionContext: Context = Object.freeze({
    deadline: inspectionParent.deadline,
    done(): AbortSignal {
      return reinspectionSignal as never
    },
    err(): null {
      reinspectionReads += 1
      if (reinspectionReads === 3) throw reinspectionFailure
      return null
    },
    value: inspectionParent.value
  })
  expect(await rejected(reinspectionListener.close(reinspectionContext))).toBe(
    reinspectionRegistrationFailure
  )

  const stopTransport = newMemoryTransport()
  const stopListener = await stopTransport.listen(background(), "memory://wait-stop-failure")
  const stopFailure = new Error("wait StopFunc failed")
  const stopSignal = new AbortController().signal
  const stopContext: Context & { afterFunc(callback: () => void): () => boolean } = Object.freeze({
    deadline: inspectionParent.deadline,
    done(): AbortSignal {
      return stopSignal
    },
    err(): null {
      return null
    },
    value: inspectionParent.value,
    afterFunc(): () => boolean {
      return function hostileStop(): never {
        throw stopFailure
      }
    }
  })
  await stopListener.close(stopContext)

  const rejectedTransport = newMemoryTransport()
  const rejectedListener = await rejectedTransport.listen(background(), "memory://wait-rejected")
  const ownerRemoval = new Error("accept owner removal failed")
  const ownerSignal = {
    aborted: false,
    addEventListener(): void {},
    removeEventListener(): never {
      throw ownerRemoval
    }
  }
  const parent = background()
  const ownerContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return ownerSignal as never
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  const accepting = rejectedListener.accept(ownerContext, function unreachable(): void {})
  const rejectedRemoval = new Error("rejected wait listener removal failed")
  const rejectedContext = hostileWaitContext(rejectedRemoval)
  expect(await rejected(rejectedListener.close(rejectedContext.ctx))).toBe(ownerRemoval)
  expect(await rejected(accepting)).toBe(ownerRemoval)
  expect(rejectedContext.removals()).toBe(1)

  const observationTransport = newMemoryTransport()
  const observationListener = await observationTransport.listen(
    background(),
    "memory://wait-cancellation-observation-failure"
  )
  const observationStarted = deferred<void>()
  const observationRelease = deferred<void>()
  const observationAccept = observationListener.accept(
    background(),
    async function blocked(ctx, socket): Promise<void> {
      await socket.recv(ctx)
      observationStarted.resolve(undefined)
      await observationRelease.promise
    }
  )
  const observationClient = await observationTransport.dial(
    background(),
    observationListener.addr()
  )
  const observationSending = rejected(
    observationClient.send(background(), { header: {}, body: new Uint8Array() })
  )
  await observationStarted.promise
  const observationFailure = new Error("wait cancellation observation failed")
  const observationAbortSlot: { listener: EventListener | null } = { listener: null }
  let observationAborted = false
  const observationSignal = {
    get aborted(): boolean {
      return observationAborted
    },
    addEventListener(_type: string, candidate: EventListenerOrEventListenerObject): void {
      if (typeof candidate === "function") observationAbortSlot.listener = candidate
    },
    removeEventListener(): void {
      observationAbortSlot.listener = null
    }
  }
  const observationContext: Context = Object.freeze({
    deadline: parent.deadline,
    done(): AbortSignal {
      return observationSignal as never
    },
    err(): null {
      if (observationAborted) throw observationFailure
      return null
    },
    value: parent.value
  })
  const observationClosing = rejected(observationListener.close(observationContext))
  observationAborted = true
  const admittedAbort = observationAbortSlot.listener
  if (admittedAbort === null) throw new Error("wait cancellation observer is missing")
  admittedAbort(new Event("abort"))
  expect(await observationClosing).toBe(observationFailure)
  expect(errorCode(await observationSending)).toBe("LIKEGO_TRANSPORT_CLOSED")
  observationRelease.resolve(undefined)
  await observationAccept
  await observationClient.close(background())

  const canceledTransport = newMemoryTransport()
  const canceledListener = await canceledTransport.listen(background(), "memory://wait-canceled")
  const started = deferred<void>()
  const release = deferred<void>()
  const canceledAccept = canceledListener.accept(
    background(),
    async function blocked(ctx, socket): Promise<void> {
      await socket.recv(ctx)
      started.resolve(undefined)
      await release.promise
    }
  )
  const client = await canceledTransport.dial(background(), canceledListener.addr())
  const canceledRemoval = new Error("canceled wait listener removal failed")
  const canceledContext = hostileWaitContext(canceledRemoval)
  const sending = client.send(canceledContext.ctx, { header: {}, body: new Uint8Array() })
  await started.promise
  const exactCancellation = new Error("exact wait cancellation")
  canceledContext.cancel(exactCancellation)
  expect(await rejected(sending)).toBe(exactCancellation)
  expect(canceledContext.removals()).toBe(1)
  release.resolve(undefined)
  await client.close(background())
  await canceledListener.close(background())
  await canceledAccept
})

test("rechecks Context after listen and dial option reducers before resource admission", async () => {
  const transport = newMemoryTransport()
  const listenOperation = withCancelCause(background())
  const listenCause = new Error("listen option canceled admission")
  expect(
    await rejected(
      transport.listen(
        listenOperation[0],
        "memory://option-context",
        function cancelListen(options) {
          listenOperation[1](listenCause)
          return options
        }
      )
    )
  ).toBe(listenCause)

  const listener = await transport.listen(background(), "memory://option-context")
  const accepting = echo(listener, background())
  const dialOperation = withCancelCause(background())
  const dialCause = new Error("dial option canceled admission")
  expect(
    await rejected(
      transport.dial(dialOperation[0], listener.addr(), function cancelDial(options) {
        dialOperation[1](dialCause)
        return options
      })
    )
  ).toBe(dialCause)

  const client = await transport.dial(background(), listener.addr())
  expect(client.local()).toBe("memory://client/1")
  await client.close(background())
  await listener.close(background())
  await accepting
})

test("does not start a handler when its Client closes during dispatch admission", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://client-dispatch-close")
  const parent = background()
  let doneReads = 0
  let client: Client | null = null
  const owner: Context = Object.freeze({
    deadline: parent.deadline,
    done(): null {
      doneReads += 1
      if (doneReads === 2 && client !== null) void client.close(background())
      return null
    },
    err(): null {
      return null
    },
    value: parent.value
  })
  let handled = 0
  const accepting = listener.accept(owner, function unreachable(): void {
    handled += 1
  })
  client = await transport.dial(background(), listener.addr())

  expect(
    errorCode(
      await rejected(
        client.send(background(), { header: { phase: "close" }, body: new Uint8Array() })
      )
    )
  ).toBe("LIKEGO_TRANSPORT_CLOSED")
  await Promise.resolve()
  expect(handled).toBe(0)
  await listener.close(background())
  await accepting
})

test("dispatch stays closed when a hostile accept Context closes its listener", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://dispatch-reentry")
  const parent = background()
  let doneReads = 0
  let closeWork: Promise<void> | null = null
  const owner: Context = Object.freeze({
    deadline(): readonly [Date, boolean] {
      return parent.deadline()
    },
    done(): AbortSignal | null {
      doneReads += 1
      if (doneReads === 2) closeWork = listener.close(background())
      return null
    },
    err() {
      return null
    },
    value(key: unknown): unknown {
      return parent.value(key)
    }
  })
  let handled = 0
  const accepting = listener.accept(owner, function unreachable(): void {
    handled += 1
  })
  const client = await transport.dial(background(), listener.addr())
  expect(
    errorCode(await rejected(client.send(background(), { header: {}, body: new Uint8Array() })))
  ).toBe("LIKEGO_TRANSPORT_CLOSED")
  await closeWork
  await accepting
  expect(handled).toBe(0)
})

test("rechecks Socket state after a hostile response getter closes its listener", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://socket-getter-close")
  const socketFailure = deferred<Error>()
  let closeWork: Promise<void> | null = null
  const accepting = listener.accept(
    background(),
    async function handle(ctx, socket): Promise<void> {
      await socket.recv(ctx)
      const response: Message = {
        header: {},
        /** Closes the owner while Socket snapshots the response. */
        get body(): Uint8Array {
          closeWork = listener.close(background())
          return new Uint8Array()
        }
      }
      socketFailure.resolve(await rejected(socket.send(ctx, response)))
    }
  )
  const client = await transport.dial(background(), listener.addr())
  expect(
    errorCode(
      await rejected(
        client.send(background(), { header: { phase: "close" }, body: new Uint8Array() })
      )
    )
  ).toBe("LIKEGO_TRANSPORT_CLOSED")
  expect(await socketFailure.promise).toBe(canceled)
  await closeWork
  await accepting
})

test("client close cancels a handler after its consumed response", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://active-after-recv")
  const handlerContext = deferred<Context>()
  const accepting = listener.accept(
    background(),
    async function handle(ctx, socket): Promise<void> {
      handlerContext.resolve(ctx)
      const message = await socket.recv(ctx)
      await socket.send(ctx, message)
      const signal = ctx.done()
      if (signal === null) throw new Error("handler Context must be cancelable")
      if (ctx.err() === null) {
        await new Promise<void>(function wait(resolve): void {
          signal.addEventListener("abort", function aborted(): void {
            resolve()
          })
        })
      }
    }
  )
  const client = await transport.dial(background(), listener.addr())
  await client.send(background(), { header: { phase: "reply-first" }, body: new Uint8Array() })
  await client.recv(background())
  const activeContext = await handlerContext.promise
  expect(activeContext.err()).toBeNull()

  await client.close(background())
  const clientCloseCause = cause(activeContext)
  await listener.close(background())
  await accepting
  expect(clientCloseCause).toBe(canceled)
})

test("enforces timeouts, connection-close, and unsupported capability boundaries", async () => {
  const timed = newMemoryTransport()
  timed.init(timeout(5))
  const timedListener = await timed.listen(background(), "memory://timeout")
  const timedAccept = timedListener.accept(background(), async function neverReply(ctx, socket) {
    await socket.recv(ctx)
    await new Promise<void>(function wait(resolve): void {
      const signal = ctx.done()
      if (ctx.err() !== null || signal === null) {
        resolve()
        return
      }
      signal.addEventListener(
        "abort",
        function aborted(): void {
          resolve()
        },
        { once: true }
      )
    })
  })
  const timedClient = await timed.dial(background(), timedListener.addr())
  expect(
    await rejected(
      timedClient.send(background(), { header: { timeout: "yes" }, body: new Uint8Array() })
    )
  ).toBe(deadlineExceeded)
  await timedClient.close(background())
  await timedListener.close(background())
  await timedAccept

  const oneShot = newMemoryTransport()
  const oneShotListener = await oneShot.listen(background(), "memory://one-shot")
  const oneShotAccept = echo(oneShotListener, background())
  const oneShotClient = await oneShot.dial(background(), oneShotListener.addr(), withConnClose())
  await exchange(background(), oneShotClient, { header: {}, body: new Uint8Array([1]) })
  expect(
    errorCode(
      await rejected(oneShotClient.send(background(), { header: {}, body: new Uint8Array() }))
    )
  ).toBe("LIKEGO_TRANSPORT_CLOSED")
  await oneShotListener.close(background())
  await oneShotAccept

  const unsupported = [
    codec(
      Object.freeze<MessageCodec>({
        marshal(): Uint8Array {
          return new Uint8Array()
        },
        unmarshal(): Message {
          return { header: {}, body: new Uint8Array() }
        }
      })
    ),
    secure(true),
    tlsConfig({
      serverName: null,
      caCertificate: null,
      certificateChain: null,
      privateKey: null
    })
  ]
  for (const option of unsupported) {
    const subject = newMemoryTransport()
    subject.init(option)
    expect(errorCode(await rejected(subject.listen(background(), "memory://unsupported")))).toBe(
      "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY"
    )
  }
})

test("validates public structural boundaries and passive failure ownership", async () => {
  const transport = newMemoryTransport()
  expect(transport.kind()).toBe("memory")
  expect(transport.string()).toBe("memory")
  expect(transport.options()).not.toBe(transport.options())
  expect(Object.isFrozen(transport.options())).toBeTrue()

  for (const address of [
    "",
    "not-an-absolute-url",
    "http://orders",
    "memory://user:pass@orders",
    "memory://orders#x",
    "memory://orders#"
  ]) {
    expect(await rejected(transport.listen(background(), address))).toBeInstanceOf(TypeError)
  }

  const malformedCommon = function malformed(): never {
    throw new Error("malformed common option")
  }
  expect(() => transport.init(malformedCommon)).toThrow("malformed common option")
  expect(
    (
      await rejected(
        transport.listen(background(), "memory://bad-listen", function badListen(): never {
          throw new Error("bad listen option")
        })
      )
    ).message
  ).toBe("bad listen option")

  const listener = await transport.listen(background(), "memory://failure")
  const invalidAccept = Reflect.apply(listener.accept, listener, [background(), null])
  expect(await rejected(invalidAccept)).toBeInstanceOf(TypeError)
  await listener.close(background())

  const foreign = await newMemoryTransport().listen(background(), "memory://foreign")
  expect(() =>
    Reflect.apply(failMemoryListener, undefined, [background(), foreign, "invalid"])
  ).toThrow("failure cause must be an Error")
  const borrowed = {
    addr: foreign.addr,
    close: foreign.close,
    accept: foreign.accept
  }
  expect(() => failMemoryListener(background(), borrowed, new Error("foreign"))).toThrow(
    "listener is not owned"
  )
  await foreign.close(background())
})

test("preserves custom Context causes at public and Socket admission boundaries", async () => {
  const transport = newMemoryTransport()
  const customCause = new Error("custom cancellation cause")
  const canceledContext = withCancelCause(background())
  canceledContext[1](customCause)

  expect(await rejected(transport.listen(canceledContext[0], "memory://not-admitted"))).toBe(
    customCause
  )
  const listener = await transport.listen(background(), "memory://custom-admission")
  expect(await rejected(transport.dial(canceledContext[0], listener.addr()))).toBe(customCause)
  expect(
    await rejected(
      listener.accept(canceledContext[0], function unreachable(): never {
        throw new Error("pre-canceled accept must not consume the listener")
      })
    )
  ).toBe(customCause)

  const accepting = listener.accept(
    background(),
    async function handle(ctx, socket): Promise<void> {
      expect(await rejected(socket.recv(canceledContext[0]))).toBe(customCause)
      const message = await socket.recv(ctx)
      expect(await rejected(socket.send(canceledContext[0], message))).toBe(customCause)
      expect(await rejected(socket.close(canceledContext[0]))).toBe(customCause)
      await socket.send(ctx, message)
    }
  )
  const client = await transport.dial(background(), listener.addr())
  expect(
    await rejected(
      client.send(canceledContext[0], { header: { phase: "not-admitted" }, body: new Uint8Array() })
    )
  ).toBe(customCause)
  expect(await rejected(client.close(canceledContext[0]))).toBe(customCause)
  expect(await rejected(listener.close(canceledContext[0]))).toBe(customCause)
  expect(
    (
      await exchange(background(), client, {
        header: { phase: "healthy" },
        body: new Uint8Array([1])
      })
    ).header.phase
  ).toBe("healthy")

  await client.close(background())
  await listener.close(background())
  await accepting
})

test("propagates a started send custom cause into its derived handler Context", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://custom-send")
  const started = deferred<void>()
  const observed = deferred<Error | null>()
  const accepting = listener.accept(
    background(),
    async function handle(ctx, socket): Promise<void> {
      const message = await socket.recv(ctx)
      if (message.header.phase !== "cancel") {
        await socket.send(ctx, message)
        return
      }
      started.resolve(undefined)
      const signal = ctx.done()
      if (signal === null) throw new Error("handler Context must be cancelable")
      await new Promise<void>(function wait(resolve): void {
        signal.addEventListener(
          "abort",
          function aborted(): void {
            resolve()
          },
          { once: true }
        )
      })
      observed.resolve(cause(ctx))
    }
  )
  const client = await transport.dial(background(), listener.addr())
  const operationCause = new Error("send canceled by caller")
  const operation = withCancelCause(background())
  const sending = client.send(operation[0], {
    header: { phase: "cancel" },
    body: new Uint8Array([1])
  })
  await started.promise
  operation[1](operationCause)
  expect(await rejected(sending)).toBe(operationCause)
  expect(await observed.promise).toBe(operationCause)
  expect(
    (
      await exchange(background(), client, {
        header: { phase: "healthy" },
        body: new Uint8Array([2])
      })
    ).header.phase
  ).toBe("healthy")

  await client.close(background())
  await listener.close(background())
  await accepting
})

test("propagates an accept-owner custom cause through listener terminal cleanup", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://custom-accept")
  const owner = withCancelCause(background())
  const started = deferred<void>()
  const observed = deferred<Error | null>()
  const accepting = listener.accept(owner[0], async function handle(ctx, socket): Promise<void> {
    await socket.recv(ctx)
    started.resolve(undefined)
    const signal = ctx.done()
    if (signal === null) throw new Error("handler Context must be cancelable")
    await new Promise<void>(function wait(resolve): void {
      signal.addEventListener(
        "abort",
        function aborted(): void {
          resolve()
        },
        { once: true }
      )
    })
    observed.resolve(cause(ctx))
  })
  const client = await transport.dial(background(), listener.addr())
  const sending = client.send(background(), {
    header: { phase: "accept-cancel" },
    body: new Uint8Array()
  })
  await started.promise
  const ownerCause = new Error("accept owner canceled")
  owner[1](ownerCause)
  expect(await observed.promise).toBe(ownerCause)
  expect(await rejected(accepting)).toBe(ownerCause)
  expect(errorCode(await rejected(sending))).toBe("LIKEGO_TRANSPORT_CLOSED")
  await listener.close(background())
})

test("rejects malformed provider reducers and a send before accept without poisoning resources", async () => {
  const transport = newMemoryTransport()
  expect(() =>
    Reflect.apply(transport.init, transport, [
      function invalidCommon(): null {
        return null
      }
    ])
  ).toThrow("options must be an object")
  const listener = await transport.listen(background(), "memory://provider-boundaries")

  for (const reducer of [
    function invalidDialObject(): null {
      return null
    },
    function invalidDialTimeout() {
      return Object.freeze({
        timeoutMs: -1,
        connectionClose: false
      })
    },
    function invalidDialConnectionClose() {
      return Object.freeze({
        timeoutMs: 0,
        connectionClose: 1
      })
    }
  ]) {
    const dialing = Reflect.apply(transport.dial, transport, [
      background(),
      listener.addr(),
      reducer
    ])
    expect(await rejected(dialing)).toBeInstanceOf(Error)
  }

  const client = await transport.dial(background(), listener.addr())
  expect(
    errorCode(
      await rejected(
        client.send(background(), { header: { phase: "early" }, body: new Uint8Array() })
      )
    )
  ).toBe("LIKEGO_TRANSPORT_STATE")
  const accepting = echo(listener, background())
  expect(
    (
      await exchange(background(), client, {
        header: { phase: "healthy" },
        body: new Uint8Array([1])
      })
    ).header.phase
  ).toBe("healthy")

  expect(
    await rejected(
      Reflect.apply(transport.listen, transport, [
        background(),
        "memory://invalid-listen-reducer",
        function invalidListen(): readonly [] {
          return Object.freeze([])
        }
      ])
    )
  ).toBeInstanceOf(TypeError)
  const optioned = await Reflect.apply(transport.listen, transport, [
    background(),
    "memory://valid-listen-reducer",
    function validListen() {
      return Object.freeze({ marker: true })
    }
  ])
  await optioned.close(background())

  await client.close(background())
  await listener.close(background())
  await accepting
})

test("isolates handler protocol failure and oversized TransportInfo observations", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://handler-boundaries")
  const accepting = listener.accept(
    background(),
    async function handle(ctx, socket): Promise<void> {
      const message = await socket.recv(ctx)
      if (message.header.phase === "no-reply") return
      if (message.header.phase === "oversized" || message.header.phase === "invalid-metadata") {
        expect(fromServerContext(ctx)).toBeNull()
      }
      if (message.header.phase === "invalid-reply-metadata") {
        const info = fromServerContext(ctx)
        if (info === null) throw new Error("valid request TransportInfo is missing")
        await socket.send(ctx, {
          header: { phase: "invalid-reply-metadata", ["\ud800"]: "accepted-message-key" },
          body: message.body
        })
        expect(get(info.replyHeaders(), "phase")).toBeNull()
        return
      }
      await socket.send(ctx, message)
    }
  )
  const client = await transport.dial(background(), listener.addr())
  expect(
    errorCode(
      await rejected(
        client.send(background(), { header: { phase: "no-reply" }, body: new Uint8Array() })
      )
    )
  ).toBe("LIKEGO_TRANSPORT_STATE")
  const oversized = await exchange(background(), client, {
    header: {
      phase: "oversized",
      [request]: "x".repeat(1_100),
      [endpoint]: "Method"
    },
    body: new Uint8Array([1])
  })
  expect(oversized.header.phase).toBe("oversized")
  for (let sequence = 0; sequence < 3; sequence += 1) {
    const invalidMetadata = await exchange(background(), client, {
      header: {
        phase: "invalid-metadata",
        sequence: String(sequence),
        ["\ud800"]: "accepted-message-key"
      },
      body: new Uint8Array([sequence])
    })
    expect(invalidMetadata.header.sequence).toBe(String(sequence))
  }
  const invalidReplyMetadata = await exchange(background(), client, {
    header: { phase: "invalid-reply-metadata" },
    body: new Uint8Array([4])
  })
  expect(invalidReplyMetadata.header.phase).toBe("invalid-reply-metadata")

  await client.close(background())
  await listener.close(background())
  await accepting
})

test("preserves a cross-realm handler Error by identity", async () => {
  const foreign = runInNewContext('new Error("foreign handler failure")') as Error
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://cross-realm-handler")
  const accepting = listener.accept(background(), function fail(): never {
    throw foreign
  })
  const client = await transport.dial(background(), listener.addr())

  const observed = await client
    .send(background(), { header: { phase: "foreign" }, body: new Uint8Array() })
    .then(
      function fulfilled(): unknown {
        return null
      },
      function rejected(error: unknown): unknown {
        return error
      }
    )
  expect(observed).toBe(foreign)

  await client.close(background())
  await listener.close(background())
  await accepting
})
