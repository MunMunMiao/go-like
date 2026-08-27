import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  background,
  withCancel,
  withCancelCause,
  withTimeout,
  type Context
} from "@go-like/context"

import { fileSource, type FileWatcher } from "../src/file"
import {
  newNodeFileCapabilityWithIO,
  type NodeFileIO,
  type NodeFileWatchCallbacks,
  type NodeFileWatchResource
} from "../src/node-host"
import { newNodeFileCapability } from "../src/node"

interface ControlledBoundary {
  readonly io: NodeFileIO
  readonly directories: string[]
  readonly paths: string[]
  readonly signals: (AbortSignal | null)[]
  readonly closeCalls: () => number
  readonly detachCalls: () => number
  readonly change: (fileName: string | null) => void
  readonly fail: (error: unknown) => void
  readonly closeNative: () => void
}

interface ControlledBoundaryOptions {
  readonly bytes?: () => Uint8Array | Promise<Uint8Array>
  readonly onWatch?: (callbacks: NodeFileWatchCallbacks) => void
  readonly onClose?: (callbacks: NodeFileWatchCallbacks) => void
  readonly onDetach?: () => void
}

/** Creates a deterministic watcher boundary while retaining all owner operations for assertions. */
function controlledBoundary(options: ControlledBoundaryOptions = {}): ControlledBoundary {
  const directories: string[] = []
  const paths: string[] = []
  const signals: (AbortSignal | null)[] = []
  let callbacks: NodeFileWatchCallbacks | null = null
  let closes = 0
  let detaches = 0

  /** Returns the admitted callbacks after watch construction. */
  function admittedCallbacks(): NodeFileWatchCallbacks {
    if (callbacks === null) throw new Error("watch callbacks are not admitted")
    return callbacks
  }

  const io: NodeFileIO = {
    /** Returns the configured complete bytes. */
    async readFile(path, signal): Promise<Uint8Array> {
      paths.push(path)
      signals.push(signal)
      return await (options.bytes?.() ?? Promise.resolve(new TextEncoder().encode("{}")))
    },
    /** Captures callbacks and exposes one strict close/detach resource. */
    watch(directory, supplied): NodeFileWatchResource {
      directories.push(directory)
      callbacks = supplied
      options.onWatch?.(supplied)
      return {
        /** Records close and emits native close unless the fixture overrides it. */
        close(): void {
          closes += 1
          if (options.onClose === undefined) supplied.closed()
          else options.onClose(supplied)
        },
        /** Records exact listener detachment. */
        detach(): void {
          detaches += 1
          options.onDetach?.()
        }
      }
    }
  }

  return {
    io,
    directories,
    paths,
    signals,
    closeCalls() {
      return closes
    },
    detachCalls() {
      return detaches
    },
    change(fileName) {
      admittedCallbacks().changed(fileName)
    },
    fail(error) {
      admittedCallbacks().failed(error)
    },
    closeNative() {
      admittedCallbacks().closed()
    }
  }
}

/** Captures one rejected value without changing its identity. */
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error("operation unexpectedly succeeded")
}

/** Starts one watcher with a listener that records complete filtered notifications. */
async function opened(
  boundary: ControlledBoundary,
  changed: () => void = function unchanged(): void {}
): Promise<FileWatcher> {
  const capability = newNodeFileCapabilityWithIO(boundary.io)
  const watch = capability.watch
  if (watch === undefined) throw new Error("Node file watch capability is missing")
  return await watch.call(capability, background(), "/srv/config.json", changed)
}

/** Waits for one real file-source notification under a bounded Context. */
async function nextWithin(watcher: { next(ctx: Context): Promise<void> }): Promise<void> {
  const [ctx, cancel] = withTimeout(background(), 2_000)
  try {
    await watcher.next(ctx)
  } finally {
    cancel()
  }
}

describe("Node file read capability", () => {
  test("captures I/O receiver behavior and hashes complete detached content", async () => {
    let document = new TextEncoder().encode('{"ready":true}')
    let reads = 0
    const receiver = {
      prefix: "node",
      /** Reads the current fixture through the captured receiver. */
      async readFile(path: string, signal: AbortSignal | null): Promise<Uint8Array> {
        expect(this.prefix).toBe("node")
        expect(path).toBe("settings.json")
        if (reads === 0) expect(signal).not.toBeNull()
        reads += 1
        return document
      },
      /** Provides the unused valid watch boundary. */
      watch(): NodeFileWatchResource {
        return { close() {}, detach() {} }
      }
    }
    const capability = newNodeFileCapabilityWithIO(receiver)
    receiver.readFile = async function replacedRead(): Promise<Uint8Array> {
      throw new Error("mutated read should not run")
    }
    const [ctx, cancel] = withCancel(background())
    const first = await capability.read(ctx, "settings.json")
    cancel()
    expect(first.text).toBe('{"ready":true}')
    expect(first.revision).toMatch(/^sha256:[0-9a-f]{64}$/)
    document[0] = 32
    expect(first.text).toBe('{"ready":true}')

    document = new TextEncoder().encode('{"ready":true}')
    const same = await capability.read(background(), "settings.json")
    expect(same.revision).toBe(first.revision)
    document = new TextEncoder().encode('{"ready":false}')
    const changed = await capability.read(background(), "settings.json")
    expect(changed.revision).not.toBe(first.revision)
    expect(Object.isFrozen(changed)).toBe(true)
  })

  test("rejects canceled, invalid, malformed, and failed reads without fabricating results", async () => {
    let calls = 0
    const [canceledContext, cancelBefore] = withCancelCause(background())
    const canceled = new Error("read canceled before admission")
    cancelBefore(canceled)
    const preCanceled = controlledBoundary({
      bytes() {
        calls += 1
        return new Uint8Array()
      }
    })
    await expect(
      newNodeFileCapabilityWithIO(preCanceled.io).read(canceledContext, "config.json")
    ).rejects.toBe(canceled)
    expect(calls).toBe(0)

    const invalidPath = newNodeFileCapabilityWithIO(controlledBoundary().io)
    for (const path of ["", "bad\0path", "/", ".", ".."])
      await expect(invalidPath.read(background(), path)).rejects.toBeInstanceOf(TypeError)
    await expect(
      Reflect.apply(invalidPath.read, invalidPath, [background(), null])
    ).rejects.toBeInstanceOf(TypeError)

    const nativeFailure = new Error("native read failed")
    const failed = controlledBoundary({
      bytes() {
        throw nativeFailure
      }
    })
    await expect(
      newNodeFileCapabilityWithIO(failed.io).read(background(), "config.json")
    ).rejects.toBe(nativeFailure)
    const hostile = controlledBoundary({
      bytes() {
        throw "hostile read failure"
      }
    })
    await expect(
      newNodeFileCapabilityWithIO(hostile.io).read(background(), "config.json")
    ).rejects.toMatchObject({ message: "Node configuration file read failed" })

    const [startedContext, cancelStarted] = withCancelCause(background())
    const startedFailure = new Error("read canceled after native completion")
    const started = controlledBoundary({
      bytes() {
        cancelStarted(startedFailure)
        return new TextEncoder().encode("{}")
      }
    })
    await expect(
      newNodeFileCapabilityWithIO(started.io).read(startedContext, "config.json")
    ).rejects.toBe(startedFailure)

    const [carrierContext, cancelCarrierRead] = withCancelCause(background())
    const carrierReason = new Error("read cancellation remained primary")
    const nativeCarrierFailure = new Error("discarded read carrier rejected")
    const nativeCarrier = Promise.reject(nativeCarrierFailure)
    const carrierRead = controlledBoundary({
      bytes() {
        cancelCarrierRead(carrierReason)
        return Promise.reject(nativeCarrier)
      }
    })
    await expect(
      newNodeFileCapabilityWithIO(carrierRead.io).read(carrierContext, "config.json")
    ).rejects.toBe(carrierReason)
    expect(await rejection(nativeCarrier)).toBe(nativeCarrierFailure)

    const structuralReadFailure = new Error("structural read continuation rejected")
    let structuralReadCalls = 0
    const structuralRead: NodeFileIO = {
      // @ts-expect-error NodeFileIO requires one genuine Promise, not a structural thenable.
      readFile(): object {
        return {
          then(resolve: (value: Uint8Array) => void): Promise<never> {
            structuralReadCalls += 1
            resolve(new Uint8Array())
            return Promise.reject(structuralReadFailure)
          }
        }
      },
      watch(): NodeFileWatchResource {
        return { close() {}, detach() {} }
      }
    }
    await expect(
      newNodeFileCapabilityWithIO(structuralRead).read(background(), "config.json")
    ).rejects.toMatchObject({ message: "Node file read must return a native Promise" })
    expect(structuralReadCalls).toBe(1)

    const malformed: NodeFileIO = {
      /** Deliberately violates the native byte boundary. */
      // @ts-expect-error Runtime validation must reject a hostile I/O result.
      async readFile(): Promise<string> {
        return "not bytes"
      },
      /** Supplies an otherwise valid unused watcher. */
      watch(): NodeFileWatchResource {
        return { close() {}, detach() {} }
      }
    }
    await expect(
      newNodeFileCapabilityWithIO(malformed).read(background(), "config.json")
    ).rejects.toBeInstanceOf(TypeError)
    const invalidUtf8 = controlledBoundary({ bytes: () => new Uint8Array([0xff]) })
    await expect(
      newNodeFileCapabilityWithIO(invalidUtf8.io).read(background(), "config.json")
    ).rejects.toBeInstanceOf(TypeError)
  })

  test("validates and stably captures the injected I/O surface", () => {
    for (const value of [null, 1, {}, { readFile() {} }, { watch() {} }]) {
      expect(() => Reflect.apply(newNodeFileCapabilityWithIO, undefined, [value])).toThrow(
        TypeError
      )
    }
    const readGetterFailure = new Error("read getter failed")
    const hostile = Object.defineProperties(
      {},
      {
        readFile: {
          get() {
            throw readGetterFailure
          }
        },
        watch: { value() {} }
      }
    )
    expect(() => Reflect.apply(newNodeFileCapabilityWithIO, undefined, [hostile])).toThrow(
      readGetterFailure
    )

    const earlyCarrierFailure = new Error("early I/O carrier rejected")
    const laterGetterFailure = new Error("later watch getter failed")
    let earlyThenCalls = 0
    const earlyCarrier = {
      then(): Promise<never> {
        earlyThenCalls += 1
        return Promise.reject(earlyCarrierFailure)
      }
    }
    const ordered = Object.defineProperties(
      {},
      {
        readFile: { value: earlyCarrier },
        watch: {
          get() {
            throw laterGetterFailure
          }
        }
      }
    )
    expect(() => Reflect.apply(newNodeFileCapabilityWithIO, undefined, [ordered])).toThrow(
      TypeError
    )
    expect(earlyThenCalls).toBe(1)
  })
})

describe("Node file watcher lifecycle", () => {
  test("filters parent-directory events and keeps stable idempotent owner barriers", async () => {
    const boundary = controlledBoundary()
    let changes = 0
    const handle = await opened(boundary, function changed(): void {
      changes += 1
    })
    expect(boundary.directories).toEqual(["/srv"])
    expect(handle.done()).toBe(handle.done())
    boundary.change("other.json")
    boundary.change("config.json")
    boundary.change(null)
    expect(changes).toBe(2)

    const [preCanceled, cancelBefore] = withCancelCause(background())
    const reason = new Error("stop caller already canceled")
    cancelBefore(reason)
    await expect(handle.stop(preCanceled)).rejects.toBe(reason)
    expect(boundary.closeCalls()).toBe(0)

    await handle.stop(background())
    await handle.stop(background())
    await handle.done()
    expect(boundary.closeCalls()).toBe(1)
    expect(boundary.detachCalls()).toBe(1)
  })

  test("composes with fileSource to coalesce repeated Node dirty notifications", async () => {
    const boundary = controlledBoundary()
    const source = fileSource(newNodeFileCapabilityWithIO(boundary.io), "/srv/config.json")
    const watcher = await source.watch?.(background(), null)
    if (watcher === undefined) throw new Error("Node-backed file source watcher is missing")

    boundary.change("config.json")
    boundary.change("config.json")
    await watcher.next(background())

    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("no second retained dirty event")
    const pending = watcher.next(ctx)
    cancel(reason)
    await expect(pending).rejects.toBe(reason)
    await watcher.stop(background())
    expect(boundary.closeCalls()).toBe(1)
  })

  test("lets a started stop caller leave while shared shutdown remains joinable", async () => {
    const boundary = controlledBoundary({ onClose() {} })
    const handle = await opened(boundary)
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("stop waiter left")
    const stopping = handle.stop(ctx)
    expect(boundary.closeCalls()).toBe(1)
    cancel(reason)
    await expect(stopping).rejects.toBe(reason)
    expect(handle.done()).toBe(handle.done())
    boundary.change("config.json")
    boundary.closeNative()
    await handle.done()
    await handle.stop(background())
    expect(boundary.closeCalls()).toBe(1)
  })

  test("propagates callback, passive, unexpected-close, close, and detach failures", async () => {
    const callbackFailure = new Error("change callback failed")
    const callbackBoundary = controlledBoundary()
    const callbackHandle = await opened(callbackBoundary, function failedChange(): void {
      throw callbackFailure
    })
    callbackBoundary.change("config.json")
    await expect(callbackHandle.done()).rejects.toBe(callbackFailure)
    expect(callbackBoundary.closeCalls()).toBe(1)
    expect(callbackBoundary.detachCalls()).toBe(1)

    const passiveFailure = new Error("passive watcher failure")
    const passiveBoundary = controlledBoundary()
    const passiveHandle = await opened(passiveBoundary)
    passiveBoundary.fail(passiveFailure)
    await expect(passiveHandle.done()).rejects.toBe(passiveFailure)

    const hostileBoundary = controlledBoundary({ onClose() {} })
    const hostileHandle = await opened(hostileBoundary)
    hostileBoundary.fail("non-error watcher failure")
    hostileBoundary.fail(new Error("secondary ignored failure"))
    hostileBoundary.closeNative()
    await expect(hostileHandle.done()).rejects.toMatchObject({
      message: "Node file watcher failed"
    })

    const unexpectedBoundary = controlledBoundary()
    const unexpectedHandle = await opened(unexpectedBoundary)
    unexpectedBoundary.closeNative()
    await expect(unexpectedHandle.done()).rejects.toMatchObject({
      message: "Node file watcher closed unexpectedly"
    })

    const closeFailure = new Error("native close failed")
    const detachFailure = new Error("native detach failed")
    const cleanupBoundary = controlledBoundary({
      onClose() {
        throw closeFailure
      },
      onDetach() {
        throw detachFailure
      }
    })
    const cleanupHandle = await opened(cleanupBoundary)
    const cleanupError = await rejection(cleanupHandle.stop(background()))
    expect(cleanupError).toBeInstanceOf(AggregateError)
    expect((cleanupError as AggregateError).errors).toEqual([closeFailure, detachFailure])
    await expect(cleanupHandle.done()).rejects.toBe(cleanupError)

    const detachOnlyBoundary = controlledBoundary({
      onDetach() {
        throw detachFailure
      }
    })
    const detachOnlyHandle = await opened(detachOnlyBoundary)
    await expect(detachOnlyHandle.stop(background())).rejects.toBe(detachFailure)
    await expect(detachOnlyHandle.done()).rejects.toBe(detachFailure)
  })

  test("observes returned change-listener values and hostile thenable failures", async () => {
    const ordinaryBoundary = controlledBoundary()
    let ordinaryChanges = 0
    const ordinaryHandle = await opened(ordinaryBoundary, function ordinaryValue(): number {
      ordinaryChanges += 1
      return 1
    })
    ordinaryBoundary.change("config.json")
    expect(ordinaryChanges).toBe(1)
    await ordinaryHandle.stop(background())

    const resolvedBoundary = controlledBoundary()
    const resolvedHandle = await opened(resolvedBoundary, async function resolvedChange() {})
    resolvedBoundary.change("config.json")
    await resolvedHandle.stop(background())

    const rejectedFailure = new Error("async change listener rejected")
    const rejectedBoundary = controlledBoundary()
    const rejectedHandle = await opened(rejectedBoundary, async function rejectedChange() {
      throw rejectedFailure
    })
    rejectedBoundary.change("config.json")
    await expect(rejectedHandle.done()).rejects.toBe(rejectedFailure)
    expect(rejectedBoundary.closeCalls()).toBe(1)
    expect(rejectedBoundary.detachCalls()).toBe(1)

    const getterFailure = new Error("change then getter failed")
    const getterBoundary = controlledBoundary()
    const getterHandle = await opened(getterBoundary, function hostileThenGetter(): object {
      return Object.defineProperty({}, "then", {
        get() {
          throw getterFailure
        }
      })
    })
    getterBoundary.change("config.json")
    await expect(getterHandle.done()).rejects.toBe(getterFailure)

    const callFailure = new Error("change then call failed")
    const callBoundary = controlledBoundary()
    const callHandle = await opened(callBoundary, function hostileThenCall(): object {
      return {
        then() {
          throw callFailure
        }
      }
    })
    callBoundary.change("config.json")
    await expect(callHandle.done()).rejects.toBe(callFailure)

    const thrownCarrierFailure = new Error("change listener threw a rejected Promise")
    const thrownCarrierBoundary = controlledBoundary()
    const thrownCarrierHandle = await opened(
      thrownCarrierBoundary,
      function rejectedCarrier(): void {
        throw Promise.reject(thrownCarrierFailure)
      }
    )
    thrownCarrierBoundary.change("config.json")
    const thrownCarrierTerminal = await rejection(thrownCarrierHandle.done())
    expect(thrownCarrierTerminal).toBeInstanceOf(Error)
    expect((thrownCarrierTerminal as Error).cause).toBeInstanceOf(Promise)
    expect(await rejection(Promise.resolve((thrownCarrierTerminal as Error).cause))).toBe(
      thrownCarrierFailure
    )

    const getterCarrierFailure = new Error("change then getter threw a rejected Promise")
    const getterCarrierBoundary = controlledBoundary()
    const getterCarrierHandle = await opened(
      getterCarrierBoundary,
      function rejectedGetterCarrier(): object {
        return Object.defineProperty({}, "then", {
          get() {
            throw Promise.reject(getterCarrierFailure)
          }
        })
      }
    )
    getterCarrierBoundary.change("config.json")
    const getterCarrierTerminal = await rejection(getterCarrierHandle.done())
    expect(getterCarrierTerminal).toBeInstanceOf(Error)
    expect((getterCarrierTerminal as Error).cause).toBeInstanceOf(Promise)
    expect(await rejection(Promise.resolve((getterCarrierTerminal as Error).cause))).toBe(
      getterCarrierFailure
    )

    const callCarrierFailure = new Error("change then call threw a rejected Promise")
    const callCarrierBoundary = controlledBoundary()
    const callCarrierHandle = await opened(
      callCarrierBoundary,
      function rejectedCallCarrier(): object {
        return {
          then(): never {
            throw Promise.reject(callCarrierFailure)
          }
        }
      }
    )
    callCarrierBoundary.change("config.json")
    const callCarrierTerminal = await rejection(callCarrierHandle.done())
    expect(callCarrierTerminal).toBeInstanceOf(Error)
    expect((callCarrierTerminal as Error).cause).toBeInstanceOf(Promise)
    expect(await rejection(Promise.resolve((callCarrierTerminal as Error).cause))).toBe(
      callCarrierFailure
    )

    const ownCatchFailure = new Error("change rejected Promise had a hostile own catch")
    const ownCatchCarrier = Promise.reject(ownCatchFailure)
    let ownCatchReads = 0
    Object.defineProperty(ownCatchCarrier, "catch", {
      get() {
        ownCatchReads += 1
        throw new Error("own catch must not be read")
      }
    })
    const ownCatchBoundary = controlledBoundary()
    const ownCatchHandle = await opened(ownCatchBoundary, function poisonedCatch(): void {
      throw ownCatchCarrier
    })
    ownCatchBoundary.change("config.json")
    const ownCatchTerminal = await rejection(ownCatchHandle.done())
    expect(ownCatchTerminal).toBeInstanceOf(Error)
    expect((ownCatchTerminal as Error).cause).toBe(ownCatchCarrier)
    expect(ownCatchReads).toBe(0)
    expect(await rejection(ownCatchCarrier)).toBe(ownCatchFailure)

    const returnedContinuationFailure = new Error(
      "fulfilled change thenable returned a rejected Promise"
    )
    const returnedContinuationBoundary = controlledBoundary()
    let returnedThenCalls = 0
    let lateSettlementCarrier: Promise<never> | null = null
    const lateSettlementFailure = new Error("fulfilled change thenable rejected again")
    const returnedContinuationHandle = await opened(
      returnedContinuationBoundary,
      function returnedContinuation(): object {
        return {
          then(
            resolve: (value: unknown) => void,
            reject: (reason: unknown) => void
          ): Promise<never> {
            returnedThenCalls += 1
            resolve(undefined)
            lateSettlementCarrier = Promise.reject(lateSettlementFailure)
            reject(lateSettlementCarrier)
            return Promise.reject(returnedContinuationFailure)
          }
        }
      }
    )
    returnedContinuationBoundary.change("config.json")
    await Promise.resolve()
    await returnedContinuationHandle.stop(background())
    expect(returnedThenCalls).toBe(1)
    if (lateSettlementCarrier === null) throw new Error("late settlement carrier is missing")
    expect(await rejection(lateSettlementCarrier)).toBe(lateSettlementFailure)

    const returnedPropertyFailure = new Error("change then property was a rejected Promise")
    const returnedProperty = Promise.reject(returnedPropertyFailure)
    const returnedPropertyBoundary = controlledBoundary()
    const returnedPropertyHandle = await opened(
      returnedPropertyBoundary,
      function returnedThenProperty(): object {
        return { then: returnedProperty }
      }
    )
    returnedPropertyBoundary.change("config.json")
    await returnedPropertyHandle.stop(background())
    expect(await rejection(returnedProperty)).toBe(returnedPropertyFailure)

    const structuralGetterFailure = new Error("thrown structural carrier getter rejected")
    let structuralGetterNested: Promise<never> | null = null
    const structuralGetterCarrier = Object.defineProperty({}, "then", {
      get() {
        structuralGetterNested = Promise.reject(structuralGetterFailure)
        throw structuralGetterNested
      }
    })
    const structuralGetterBoundary = controlledBoundary()
    const structuralGetterHandle = await opened(
      structuralGetterBoundary,
      function throwStructuralGetter(): void {
        throw structuralGetterCarrier
      }
    )
    structuralGetterBoundary.change("config.json")
    const structuralGetterTerminal = await rejection(structuralGetterHandle.done())
    expect((structuralGetterTerminal as Error).cause).toBe(structuralGetterCarrier)
    if (structuralGetterNested === null) throw new Error("structural getter carrier is missing")
    expect(await rejection(structuralGetterNested)).toBe(structuralGetterFailure)

    const structuralCallFailure = new Error("thrown structural carrier rejected")
    const structuralReturnFailure = new Error("thrown structural continuation rejected")
    let structuralCallNested: Promise<never> | null = null
    let structuralReturnNested: Promise<never> | null = null
    const structuralCallCarrier = {
      then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void): Promise<never> {
        structuralCallNested = Promise.reject(structuralCallFailure)
        structuralReturnNested = Promise.reject(structuralReturnFailure)
        reject(structuralCallNested)
        return structuralReturnNested
      }
    }
    const structuralCallBoundary = controlledBoundary()
    const structuralCallHandle = await opened(
      structuralCallBoundary,
      function throwStructuralCall(): void {
        throw structuralCallCarrier
      }
    )
    structuralCallBoundary.change("config.json")
    const structuralCallTerminal = await rejection(structuralCallHandle.done())
    expect((structuralCallTerminal as Error).cause).toBe(structuralCallCarrier)
    if (structuralCallNested === null || structuralReturnNested === null) {
      throw new Error("structural call carriers are missing")
    }
    expect(await rejection(structuralCallNested)).toBe(structuralCallFailure)
    expect(await rejection(structuralReturnNested)).toBe(structuralReturnFailure)

    const structuralThrowFailure = new Error("thrown structural observer call failed")
    let structuralThrowNested: Promise<never> | null = null
    const structuralThrowCarrier = {
      then(): never {
        structuralThrowNested = Promise.reject(structuralThrowFailure)
        throw structuralThrowNested
      }
    }
    const structuralThrowBoundary = controlledBoundary()
    const structuralThrowHandle = await opened(
      structuralThrowBoundary,
      function throwStructuralObserver(): void {
        throw structuralThrowCarrier
      }
    )
    structuralThrowBoundary.change("config.json")
    const structuralThrowTerminal = await rejection(structuralThrowHandle.done())
    expect((structuralThrowTerminal as Error).cause).toBe(structuralThrowCarrier)
    if (structuralThrowNested === null) throw new Error("structural throw carrier is missing")
    expect(await rejection(structuralThrowNested)).toBe(structuralThrowFailure)

    const deepFailure = new Error("deep structural carrier rejected")
    const deepTail = Promise.reject(deepFailure)
    let deepCarrier: unknown = deepTail
    for (let index = 0; index < 50_000; index += 1) {
      const nested = deepCarrier
      deepCarrier = {
        then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
          reject(nested)
        }
      }
    }
    const deepRoot = deepCarrier
    const deepBoundary = controlledBoundary()
    const deepHandle = await opened(deepBoundary, function throwDeepCarrier(): void {
      throw deepRoot
    })
    deepBoundary.change("config.json")
    const deepTerminal = await rejection(deepHandle.done())
    expect((deepTerminal as Error).cause).toBe(deepRoot)
    expect(await rejection(deepTail)).toBe(deepFailure)

    const selfBoundary = controlledBoundary()
    let selfThenCalls = 0
    const selfThenable: {
      then(resolve: (value: unknown) => void, reject: (reason: unknown) => void): void
    } = {
      then(_resolve, reject): void {
        selfThenCalls += 1
        reject(selfThenable)
      }
    }
    const selfHandle = await opened(selfBoundary, function selfRejectingThenable(): object {
      return selfThenable
    })
    selfBoundary.change("config.json")
    const selfTerminal = await rejection(selfHandle.done())
    expect((selfTerminal as Error).cause).toBe(selfThenable)
    expect(selfThenCalls).toBe(1)

    const cycleBoundary = controlledBoundary()
    let cycleThenCalls = 0
    const cycleThenable: {
      then(resolve: (value: unknown) => void): void
    } = {
      then(resolve): void {
        cycleThenCalls += 1
        resolve(cycleThenable)
      }
    }
    const cycleHandle = await opened(cycleBoundary, function selfFulfillingThenable(): object {
      return cycleThenable
    })
    cycleBoundary.change("config.json")
    const cycleTerminal = await rejection(cycleHandle.done())
    expect(cycleTerminal).toEqual(
      new TypeError("Node file change listener returned a cyclic thenable")
    )
    expect(cycleThenCalls).toBe(1)

    const duplicateBoundary = controlledBoundary()
    const duplicateFailure = new Error("duplicate fulfillment carried a rejected Promise")
    let duplicateCarrier: Promise<never> | null = null
    const duplicateHandle = await opened(
      duplicateBoundary,
      function duplicateFulfillment(): object {
        return {
          then(resolve: (value: unknown) => void): void {
            resolve(undefined)
            duplicateCarrier = Promise.reject(duplicateFailure)
            resolve(duplicateCarrier)
          }
        }
      }
    )
    duplicateBoundary.change("config.json")
    await Promise.resolve()
    await duplicateHandle.stop(background())
    if (duplicateCarrier === null) throw new Error("duplicate fulfillment carrier is missing")
    expect(await rejection(duplicateCarrier)).toBe(duplicateFailure)
  })

  test("rejects asynchronous watcher owner methods and observes invalid resource carriers", async () => {
    /** Creates one direct I/O boundary around an intentionally hostile resource factory. */
    function hostileResourceIO(
      resource: (callbacks: NodeFileWatchCallbacks) => NodeFileWatchResource
    ): NodeFileIO {
      return {
        async readFile(): Promise<Uint8Array> {
          return new Uint8Array()
        },
        watch(_directory, callbacks): NodeFileWatchResource {
          return resource(callbacks)
        }
      }
    }

    const closeCarrierFailure = new Error("watch close returned a rejected Promise")
    let closeDetachCalls = 0
    const closeCapability = newNodeFileCapabilityWithIO(
      hostileResourceIO(function asyncClose(callbacks) {
        return {
          close() {
            callbacks.closed()
            return Promise.reject(closeCarrierFailure)
          },
          detach(): void {
            closeDetachCalls += 1
          }
        }
      })
    )
    const closeHandle = await closeCapability.watch?.(background(), "/srv/config.json", () => {})
    if (closeHandle === undefined) throw new Error("async close watcher is missing")
    await expect(closeHandle.stop(background())).rejects.toMatchObject({
      message: "Node file watcher close must settle synchronously"
    })
    expect(closeDetachCalls).toBe(1)

    const hiddenCloseFailure = new Error("native close Promise rejected")
    const hiddenCloseThenFailure = new Error("native close own then getter failed")
    const hiddenCloseCarrier = Promise.reject(hiddenCloseFailure)
    let hiddenCloseThenReads = 0
    Object.defineProperty(hiddenCloseCarrier, "then", {
      get() {
        hiddenCloseThenReads += 1
        throw hiddenCloseThenFailure
      }
    })
    const hiddenCloseCapability = newNodeFileCapabilityWithIO(
      hostileResourceIO(function hiddenNativeClose(callbacks) {
        return {
          close() {
            callbacks.closed()
            return hiddenCloseCarrier
          },
          detach(): void {}
        }
      })
    )
    const hiddenCloseHandle = await hiddenCloseCapability.watch?.(
      background(),
      "/srv/config.json",
      () => {}
    )
    if (hiddenCloseHandle === undefined) throw new Error("hidden close watcher is missing")
    await expect(hiddenCloseHandle.stop(background())).rejects.toMatchObject({
      message: "Node file watcher close must settle synchronously"
    })
    expect(hiddenCloseThenReads).toBe(0)
    expect(await rejection(hiddenCloseCarrier)).toBe(hiddenCloseFailure)

    const structuralCloseFailure = new Error("structural close settlement rejected")
    const structuralCloseContinuationFailure = new Error("structural close continuation rejected")
    const structuralCloseNested = Promise.reject(structuralCloseFailure)
    const structuralCloseContinuation = Promise.reject(structuralCloseContinuationFailure)
    let structuralCloseCalls = 0
    let structuralCloseThenReads = 0
    const structuralCloseCapability = newNodeFileCapabilityWithIO(
      hostileResourceIO(function structuralNativeClose(callbacks) {
        return {
          close() {
            callbacks.closed()
            return Object.defineProperty({}, "then", {
              get() {
                structuralCloseThenReads += 1
                return function structuralCloseThen(
                  _resolve: (value: unknown) => void,
                  reject: (reason: unknown) => void
                ): Promise<never> {
                  structuralCloseCalls += 1
                  reject(structuralCloseNested)
                  return structuralCloseContinuation
                }
              }
            })
          },
          detach(): void {}
        }
      })
    )
    const structuralCloseHandle = await structuralCloseCapability.watch?.(
      background(),
      "/srv/config.json",
      () => {}
    )
    if (structuralCloseHandle === undefined) throw new Error("structural close watcher is missing")
    await expect(structuralCloseHandle.stop(background())).rejects.toMatchObject({
      message: "Node file watcher close must settle synchronously"
    })
    expect(structuralCloseCalls).toBe(1)
    expect(structuralCloseThenReads).toBe(1)
    expect(await rejection(structuralCloseNested)).toBe(structuralCloseFailure)
    expect(await rejection(structuralCloseContinuation)).toBe(structuralCloseContinuationFailure)

    const detachCarrierFailure = new Error("watch detach returned a rejected Promise")
    const detachCapability = newNodeFileCapabilityWithIO(
      hostileResourceIO(function asyncDetach(callbacks) {
        return {
          close(): void {
            callbacks.closed()
          },
          detach() {
            return Promise.reject(detachCarrierFailure)
          }
        }
      })
    )
    const detachHandle = await detachCapability.watch?.(background(), "/srv/config.json", () => {})
    if (detachHandle === undefined) throw new Error("async detach watcher is missing")
    await expect(detachHandle.stop(background())).rejects.toMatchObject({
      message: "Node file watcher listener cleanup must settle synchronously"
    })

    const getterFailure = new Error("watch close result then getter failed")
    const getterCapability = newNodeFileCapabilityWithIO(
      hostileResourceIO(function hostileCloseResult(callbacks) {
        return {
          close() {
            callbacks.closed()
            return Object.defineProperty({}, "then", {
              get() {
                throw getterFailure
              }
            })
          },
          detach(): void {}
        }
      })
    )
    const getterHandle = await getterCapability.watch?.(background(), "/srv/config.json", () => {})
    if (getterHandle === undefined) throw new Error("hostile close result watcher is missing")
    await expect(getterHandle.stop(background())).rejects.toBe(getterFailure)

    const propertyCarrierFailure = new Error("watch close result carried a rejected Promise")
    const propertyCarrier = Promise.reject(propertyCarrierFailure)
    const propertyCapability = newNodeFileCapabilityWithIO(
      hostileResourceIO(function propertyCloseResult(callbacks) {
        return {
          close() {
            callbacks.closed()
            return { then: propertyCarrier }
          },
          detach(): void {}
        }
      })
    )
    const propertyHandle = await propertyCapability.watch?.(
      background(),
      "/srv/config.json",
      () => {}
    )
    if (propertyHandle === undefined) throw new Error("property carrier watcher is missing")
    await propertyHandle.stop(background())
    expect(await rejection(propertyCarrier)).toBe(propertyCarrierFailure)

    const watchCarrierFailure = new Error("watch returned a rejected Promise")
    const watchCarrier = Promise.reject(watchCarrierFailure)
    const watchCarrierIO: NodeFileIO = {
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array()
      },
      // @ts-expect-error Runtime validation must reject an asynchronous watch resource.
      watch(): Promise<NodeFileWatchResource> {
        return watchCarrier
      }
    }
    const watchCarrierTerminal = await rejection(
      newNodeFileCapabilityWithIO(watchCarrierIO).watch?.(
        background(),
        "/srv/config.json",
        () => {}
      ) ?? Promise.resolve()
    )
    expect(watchCarrierTerminal).toBeInstanceOf(AggregateError)
    expect(await rejection(watchCarrier)).toBe(watchCarrierFailure)
  })

  test("observes change rejection races without reopening or double-settling shutdown", async () => {
    const beforeCloseFailure = new Error("change rejected while stop was waiting")
    const beforeClose = Promise.withResolvers<void>()
    const waitingBoundary = controlledBoundary({ onClose() {} })
    const waitingHandle = await opened(waitingBoundary, function pendingChange(): Promise<void> {
      return beforeClose.promise
    })
    waitingBoundary.change("config.json")
    const stopping = rejection(waitingHandle.stop(background()))
    beforeClose.reject(beforeCloseFailure)
    await Promise.resolve()
    await Promise.resolve()
    waitingBoundary.closeNative()
    expect(await stopping).toBe(beforeCloseFailure)
    await expect(waitingHandle.done()).rejects.toBe(beforeCloseFailure)
    expect(waitingBoundary.closeCalls()).toBe(1)
    expect(waitingBoundary.detachCalls()).toBe(1)

    const afterCloseCarrierFailure = new Error("late change rejection carrier failed")
    const afterCloseCarrier = Promise.reject(afterCloseCarrierFailure)
    const afterClose = Promise.withResolvers<void>()
    const closedBoundary = controlledBoundary()
    const closedHandle = await opened(closedBoundary, function lateChange(): Promise<void> {
      return afterClose.promise
    })
    closedBoundary.change("config.json")
    await closedHandle.stop(background())
    afterClose.reject(afterCloseCarrier)
    await Promise.resolve()
    await Promise.resolve()
    await expect(closedHandle.done()).resolves.toBeUndefined()
    expect(await rejection(afterCloseCarrier)).toBe(afterCloseCarrierFailure)
    const latePassiveCarrierFailure = new Error("late passive rejection carrier failed")
    const latePassiveCarrier = Promise.reject(latePassiveCarrierFailure)
    closedBoundary.fail(latePassiveCarrier)
    await Promise.resolve()
    expect(await rejection(latePassiveCarrier)).toBe(latePassiveCarrierFailure)
    expect(closedBoundary.closeCalls()).toBe(1)
    expect(closedBoundary.detachCalls()).toBe(1)
  })

  test("retains failure order when close reports an error or cleanup also fails", async () => {
    const duringClose = new Error("watch failed during close")
    const stoppingBoundary = controlledBoundary({
      onClose(callbacks) {
        callbacks.failed(duringClose)
        callbacks.changed("config.json")
        callbacks.closed()
      }
    })
    const stoppingHandle = await opened(stoppingBoundary)
    await expect(stoppingHandle.stop(background())).rejects.toBe(duringClose)

    const primary = new Error("listener failed")
    const closeFailure = new Error("failure close failed")
    const detachFailure = new Error("failure detach failed")
    const aggregateBoundary = controlledBoundary({
      onClose() {
        throw closeFailure
      },
      onDetach() {
        throw detachFailure
      }
    })
    const aggregateHandle = await opened(aggregateBoundary, function listenerFailure(): void {
      throw primary
    })
    aggregateBoundary.change("config.json")
    const aggregate = await rejection(aggregateHandle.done())
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([primary, closeFailure, detachFailure])
  })

  test("defers synchronous close settlement until close returns or throws", async () => {
    const closeFailure = new Error("close failed after synchronous callback")
    const detachFailure = new Error("detach failed after synchronous callback")
    const stoppingBoundary = controlledBoundary({
      onClose(callbacks) {
        callbacks.closed()
        throw closeFailure
      },
      onDetach() {
        throw detachFailure
      }
    })
    const handle = await opened(stoppingBoundary)
    const stopped = await rejection(handle.stop(background()))
    expect(stopped).toBeInstanceOf(AggregateError)
    expect((stopped as AggregateError).errors).toEqual([closeFailure, detachFailure])
    await expect(handle.done()).rejects.toBe(stopped)
    expect(stoppingBoundary.closeCalls()).toBe(1)
    expect(stoppingBoundary.detachCalls()).toBe(1)

    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("watch canceled during guarded close admission")
    const cancellationBoundary = controlledBoundary({
      onWatch() {
        cancel(reason)
      },
      onClose(callbacks) {
        callbacks.closed()
        throw closeFailure
      },
      onDetach() {
        throw detachFailure
      }
    })
    const canceled = await rejection(
      newNodeFileCapabilityWithIO(cancellationBoundary.io).watch?.(
        ctx,
        "/srv/config.json",
        () => {}
      ) ?? Promise.resolve()
    )
    expect(canceled).toBeInstanceOf(AggregateError)
    expect((canceled as AggregateError).errors).toEqual([reason, closeFailure, detachFailure])
    expect(cancellationBoundary.closeCalls()).toBe(1)
    expect(cancellationBoundary.detachCalls()).toBe(1)
  })

  test("rejects invalid watch admission before transferring ownership", async () => {
    const boundary = controlledBoundary()
    const capability = newNodeFileCapabilityWithIO(boundary.io)
    const watch = capability.watch
    if (watch === undefined) throw new Error("Node file watch capability is missing")
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("watch canceled before admission")
    cancel(reason)
    await expect(watch.call(capability, ctx, "/srv/config.json", () => {})).rejects.toBe(reason)
    expect(boundary.directories).toEqual([])
    await expect(
      Reflect.apply(watch, capability, [background(), "/srv/config.json", null])
    ).rejects.toBeInstanceOf(TypeError)
    await expect(watch.call(capability, background(), "/", () => {})).rejects.toBeInstanceOf(
      TypeError
    )
  })

  test("rolls back cancellation that becomes visible after native watch creation", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("watch canceled during admission")
    const boundary = controlledBoundary({
      onWatch() {
        cancel(reason)
      }
    })
    const capability = newNodeFileCapabilityWithIO(boundary.io)
    await expect(capability.watch?.(ctx, "/srv/config.json", () => {})).rejects.toBe(reason)
    expect(boundary.closeCalls()).toBe(1)
    expect(boundary.detachCalls()).toBe(1)

    const cleanupFailure = new Error("cancellation close failed")
    const [failedContext, cancelFailed] = withCancelCause(background())
    const failedBoundary = controlledBoundary({
      onWatch() {
        cancelFailed(reason)
      },
      onClose() {
        throw cleanupFailure
      }
    })
    const failedCapability = newNodeFileCapabilityWithIO(failedBoundary.io)
    const aggregate = await rejection(
      failedCapability.watch?.(failedContext, "/srv/config.json", () => {}) ?? Promise.resolve()
    )
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors[0]).toBe(reason)
    expect((aggregate as AggregateError).errors[1]).toBe(cleanupFailure)
    expect(failedBoundary.closeCalls()).toBe(1)
    expect(failedBoundary.detachCalls()).toBe(1)
  })

  test("rolls back cancellation raised by a replayed synchronous change", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("watch canceled by synchronous change")
    let changes = 0
    const boundary = controlledBoundary({
      onWatch(callbacks) {
        callbacks.changed("config.json")
      }
    })
    const capability = newNodeFileCapabilityWithIO(boundary.io)
    await expect(
      capability.watch?.(ctx, "/srv/config.json", function cancelFromChange(): void {
        changes += 1
        cancel(reason)
      })
    ).rejects.toBe(reason)
    expect(changes).toBe(1)
    expect(boundary.closeCalls()).toBe(1)
    expect(boundary.detachCalls()).toBe(1)
  })

  test("keeps replay cancellation primary before callback and guarded cleanup failures", async () => {
    const [ctx, cancel] = withCancelCause(background())
    const reason = new Error("watch canceled by failing synchronous change")
    const callbackFailure = new Error("synchronous change failed after cancellation")
    const closeFailure = new Error("failure close failed after synchronous callback")
    const detachFailure = new Error("failure detach failed after synchronous callback")
    const boundary = controlledBoundary({
      onWatch(callbacks) {
        callbacks.changed("config.json")
      },
      onClose(callbacks) {
        callbacks.closed()
        throw closeFailure
      },
      onDetach() {
        throw detachFailure
      }
    })
    const rejected = await rejection(
      newNodeFileCapabilityWithIO(boundary.io).watch?.(
        ctx,
        "/srv/config.json",
        function cancelThenFail(): void {
          cancel(reason)
          throw callbackFailure
        }
      ) ?? Promise.resolve()
    )
    expect(rejected).toBeInstanceOf(AggregateError)
    expect((rejected as AggregateError).errors).toEqual([
      reason,
      callbackFailure,
      closeFailure,
      detachFailure
    ])
    expect(boundary.closeCalls()).toBe(1)
    expect(boundary.detachCalls()).toBe(1)
  })

  test("keeps Context identity when synchronous watch or resource capture also fails", async () => {
    const nativeFailure = new Error("native watch failed after cancellation")
    const [watchContext, cancelWatch] = withCancelCause(background())
    const watchReason = new Error("watch canceled before native failure")
    const failedWatch: NodeFileIO = {
      /** Supplies bytes for the unused read operation. */
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array()
      },
      /** Cancels synchronously before exposing a competing native failure. */
      watch(): NodeFileWatchResource {
        cancelWatch(watchReason)
        throw nativeFailure
      }
    }
    await expect(
      newNodeFileCapabilityWithIO(failedWatch).watch?.(watchContext, "/srv/config.json", () => {})
    ).rejects.toBe(watchReason)

    const [carrierContext, cancelCarrierWatch] = withCancelCause(background())
    const carrierReason = new Error("watch carrier cancellation remained primary")
    const nativeCarrierFailure = new Error("discarded watch carrier rejected")
    const nativeCarrier = Promise.reject(nativeCarrierFailure)
    const carrierWatch: NodeFileIO = {
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array()
      },
      watch(): NodeFileWatchResource {
        cancelCarrierWatch(carrierReason)
        throw nativeCarrier
      }
    }
    await expect(
      newNodeFileCapabilityWithIO(carrierWatch).watch?.(
        carrierContext,
        "/srv/config.json",
        () => {}
      )
    ).rejects.toBe(carrierReason)
    expect(await rejection(nativeCarrier)).toBe(nativeCarrierFailure)

    const captureFailure = new Error("resource close capture failed")
    const detachFailure = new Error("resource detach cleanup failed")
    const [captureContext, cancelCapture] = withCancelCause(background())
    const captureReason = new Error("watch canceled during resource capture")
    let detaches = 0
    const failedCapture: NodeFileIO = {
      /** Supplies bytes for the unused read operation. */
      async readFile(): Promise<Uint8Array> {
        return new Uint8Array()
      },
      /** Returns a resource whose hostile getter cancels before failing capture. */
      watch(): NodeFileWatchResource {
        return Object.defineProperties(
          {},
          {
            close: {
              get() {
                cancelCapture(captureReason)
                throw captureFailure
              }
            },
            detach: {
              value() {
                detaches += 1
                throw detachFailure
              }
            }
          }
        ) as NodeFileWatchResource
      }
    }
    const rejected = await rejection(
      newNodeFileCapabilityWithIO(failedCapture).watch?.(
        captureContext,
        "/srv/config.json",
        () => {}
      ) ?? Promise.resolve()
    )
    expect(rejected).toBeInstanceOf(AggregateError)
    expect((rejected as AggregateError).errors).toEqual([
      captureReason,
      captureFailure,
      detachFailure
    ])
    expect(detaches).toBe(1)
  })

  test("retains synchronous admission changes and rejects synchronous native terminals", async () => {
    let changes = 0
    const changedBoundary = controlledBoundary({
      onWatch(callbacks) {
        callbacks.changed("config.json")
      }
    })
    const changedHandle = await opened(changedBoundary, function changed(): void {
      changes += 1
    })
    expect(changes).toBe(1)
    await changedHandle.stop(background())

    const admissionFailure = new Error("synchronous native failure")
    const failedBoundary = controlledBoundary({
      onWatch(callbacks) {
        callbacks.failed(admissionFailure)
      }
    })
    await expect(opened(failedBoundary)).rejects.toBe(admissionFailure)
    expect(failedBoundary.closeCalls()).toBe(1)
    expect(failedBoundary.detachCalls()).toBe(1)

    const closedBoundary = controlledBoundary({
      onWatch(callbacks) {
        callbacks.closed()
      }
    })
    await expect(opened(closedBoundary)).rejects.toMatchObject({
      message: "Node file watcher closed unexpectedly"
    })

    const callbackFailure = new Error("synchronous listener failure")
    const callbackBoundary = controlledBoundary({
      onWatch(callbacks) {
        callbacks.changed("config.json")
      }
    })
    await expect(
      opened(callbackBoundary, function failedListener(): void {
        throw callbackFailure
      })
    ).rejects.toBe(callbackFailure)
  })

  test("best-effort releases partial and hostile watcher resources", async () => {
    /** Creates an I/O boundary returning the exact hostile resource. */
    function resourceIO(resource: unknown): NodeFileIO {
      return {
        /** Supplies complete bytes for the unused read operation. */
        async readFile(): Promise<Uint8Array> {
          return new Uint8Array()
        },
        /** Returns the hostile fixture for admission validation. */
        // @ts-expect-error Runtime tests deliberately violate the resource contract.
        watch(): unknown {
          return resource
        }
      }
    }

    for (const resource of [null, 1]) {
      const capability = newNodeFileCapabilityWithIO(resourceIO(resource))
      await expect(
        capability.watch?.(background(), "/srv/config.json", () => {})
      ).rejects.toBeInstanceOf(TypeError)
    }

    let closes = 0
    let detaches = 0
    const missingDetach = {
      close() {
        closes += 1
      },
      detach: 1
    }
    await expect(
      newNodeFileCapabilityWithIO(resourceIO(missingDetach)).watch?.(
        background(),
        "/srv/config.json",
        () => {}
      )
    ).rejects.toBeInstanceOf(TypeError)
    expect(closes).toBe(1)

    const missingClose = {
      close: 1,
      detach() {
        detaches += 1
      }
    }
    await expect(
      newNodeFileCapabilityWithIO(resourceIO(missingClose)).watch?.(
        background(),
        "/srv/config.json",
        () => {}
      )
    ).rejects.toBeInstanceOf(TypeError)
    expect(detaches).toBe(1)

    const closeGetterFailure = new Error("close getter failed")
    const detachGetterFailure = new Error("detach getter failed")
    const bothHostile = Object.defineProperties(
      {},
      {
        close: {
          get() {
            throw closeGetterFailure
          }
        },
        detach: {
          get() {
            throw detachGetterFailure
          }
        }
      }
    )
    const bothFailure = await rejection(
      newNodeFileCapabilityWithIO(resourceIO(bothHostile)).watch?.(
        background(),
        "/srv/config.json",
        () => {}
      ) ?? Promise.resolve()
    )
    expect(bothFailure).toBeInstanceOf(AggregateError)
    expect((bothFailure as AggregateError).errors).toEqual([
      closeGetterFailure,
      detachGetterFailure
    ])

    const closeFailure = new Error("provisional close failed")
    const detachFailure = new Error("provisional detach failed")
    const detachHostile = Object.defineProperties(
      {},
      {
        close: {
          value() {
            throw closeFailure
          }
        },
        detach: {
          get() {
            throw detachGetterFailure
          }
        }
      }
    )
    const closeCleanup = await rejection(
      newNodeFileCapabilityWithIO(resourceIO(detachHostile)).watch?.(
        background(),
        "/srv/config.json",
        () => {}
      ) ?? Promise.resolve()
    )
    expect(closeCleanup).toBeInstanceOf(AggregateError)
    expect((closeCleanup as AggregateError).errors).toEqual([detachGetterFailure, closeFailure])

    const closeHostile = Object.defineProperties(
      {},
      {
        close: {
          get() {
            throw closeGetterFailure
          }
        },
        detach: {
          value() {
            throw detachFailure
          }
        }
      }
    )
    const detachCleanup = await rejection(
      newNodeFileCapabilityWithIO(resourceIO(closeHostile)).watch?.(
        background(),
        "/srv/config.json",
        () => {}
      ) ?? Promise.resolve()
    )
    expect(detachCleanup).toBeInstanceOf(AggregateError)
    expect((detachCleanup as AggregateError).errors).toEqual([closeGetterFailure, detachFailure])
  })

  test("normalizes direct watch admission failures", async () => {
    for (const failure of [new Error("watch creation failed"), "hostile watch creation failure"]) {
      const io: NodeFileIO = {
        /** Supplies bytes for the unused read operation. */
        async readFile(): Promise<Uint8Array> {
          return new Uint8Array()
        },
        /** Throws the selected admission failure. */
        watch(): NodeFileWatchResource {
          throw failure
        }
      }
      const capability = newNodeFileCapabilityWithIO(io)
      const rejected = await rejection(
        capability.watch?.(background(), "/srv/config.json", () => {}) ?? Promise.resolve()
      )
      if (failure instanceof Error) expect(rejected).toBe(failure)
      else expect(rejected).toMatchObject({ message: "Node file watcher admission failed" })
    }
  })
})

test("real filesystem observes ordinary writes without residual Node watcher owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-config-node-"))
  const path = join(directory, "config.json")
  try {
    await writeFile(path, '{"value":1}')
    const capability = newNodeFileCapability()
    const first = await capability.read(background(), path)
    await writeFile(path, '{"value":2}')
    const second = await capability.read(background(), path)
    expect(second.revision).not.toBe(first.revision)
    await writeFile(path, '{"value":2}')
    expect((await capability.read(background(), path)).revision).toBe(second.revision)

    const source = fileSource(capability, path)
    const ordinary = await source.watch?.(background(), second.revision)
    if (ordinary === undefined) throw new Error("ordinary Node file source watcher is missing")
    try {
      const changed = nextWithin(ordinary)
      const notified = changed.then(() => true)
      let value = 3
      for (; ; value += 1) {
        await writeFile(path, `{"value":${value}}`)
        if (await Promise.race([notified, Bun.sleep(10).then(() => false)])) break
      }
      expect((await source.load(background())).value).toEqual({ value })
    } finally {
      await ordinary.stop(background())
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
