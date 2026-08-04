import { once } from "node:events"

import { expect, test } from "bun:test"
import { background, canceled, withCancelCause } from "@go-like/context"
import pino, { symbols, type Logger } from "pino"

import { pinoDrainTimeout, newPinoServer } from "../src/index"

type SonicDestination = ReturnType<typeof pino.destination>
type ThreadDestination = ReturnType<typeof pino.transport>
type FlushCallback = (error?: Error) => void

interface SonicResource {
  readonly destination: SonicDestination
  readonly closed: Promise<void>
}

interface ThreadResource {
  readonly destination: ThreadDestination
  readonly closed: Promise<void>
}

/** Creates one ready Pino file destination with an observed close boundary. */
async function publishedSonicResource(): Promise<SonicResource> {
  const destination = pino.destination({ dest: "/dev/null", sync: false })
  if (Reflect.get(destination, "fd") === -1) await once(destination, "ready")
  const closed = new Promise<void>(
    /** Captures native close without treating an expected error as a Promise rejection. */
    function waitForClose(resolve) {
      destination.once("close", resolve)
    }
  )
  return Object.freeze({ destination, closed })
}

/** Creates one ready official ThreadStream destination with an observed close boundary. */
async function publishedThreadResource(): Promise<ThreadResource> {
  const destination = pino.transport({
    target: "pino/file",
    options: { destination: "/dev/null" }
  })
  if (Reflect.get(destination, "ready") !== true) await once(destination, "ready")
  const closed = new Promise<void>(
    /** Captures native close without treating an expected error as a Promise rejection. */
    function waitForClose(resolve) {
      destination.once("close", resolve)
    }
  )
  return Object.freeze({ destination, closed })
}

/** Creates an official Logger and optionally replaces only its public flush callback operation. */
function publishedLogger(
  destination: SonicDestination | ThreadDestination,
  flush?: (callback?: FlushCallback) => void
): Logger {
  const logger = pino({ enabled: false }, destination)
  if (flush !== undefined) {
    Object.defineProperty(logger, "flush", {
      configurable: true,
      value: flush,
      writable: true
    })
  }
  return logger
}

/** Closes one application-owned Pino file destination after a rejected start. */
async function closePublishedSonic(resource: SonicResource): Promise<void> {
  if (Reflect.get(resource.destination, "destroyed") !== true) resource.destination.destroy()
  await resource.closed
}

/** Exercises cancellation normalization and the one-shot start contract through public API only. */
test("published lifecycle rejects canceled and malformed startup contexts", async () => {
  const canceledResource = await publishedSonicResource()
  const canceledContext = withCancelCause(background())
  canceledContext[1](null)
  const canceledServer = newPinoServer(
    publishedLogger(canceledResource.destination),
    canceledResource.destination
  )
  await expect(canceledServer.start(canceledContext[0])).rejects.toBe(canceled)
  await expect(canceledServer.start(background())).rejects.toMatchObject({
    name: "PinoAlreadyStartedError",
    status: "failed"
  })
  await closePublishedSonic(canceledResource)

  const externalResource = await publishedSonicResource()
  const externalFailure = new Error("external context stopped")
  let errorReads = 0
  const externalContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal | null => null,
    err: (): Error | null => {
      errorReads += 1
      return errorReads === 1 ? externalFailure : null
    },
    value: () => undefined
  }
  await expect(
    newPinoServer(
      publishedLogger(externalResource.destination),
      externalResource.destination
    ).start(externalContext)
  ).rejects.toBe(externalFailure)
  expect(errorReads).toBe(2)
  await closePublishedSonic(externalResource)

  const hostileResource = await publishedSonicResource()
  const hostileContext = {
    deadline: (): readonly [Date, boolean] => [new Date(0), false],
    done: (): AbortSignal | null => null,
    err: (): Error | null => {
      throw "context inspection failed"
    },
    value: () => undefined
  }
  await expect(
    newPinoServer(publishedLogger(hostileResource.destination), hostileResource.destination).start(
      hostileContext
    )
  ).rejects.toMatchObject({
    cause: "context inspection failed"
  })
  await closePublishedSonic(hostileResource)
})

/** Exercises every ThreadStream state guard against one real official transport. */
test("published lifecycle validates and drains an official ThreadStream", async () => {
  const resource = await publishedThreadResource()
  const destination = resource.destination
  const booleanState = [
    "destroyed",
    "closed",
    "writable",
    "writableEnded",
    "writableFinished"
  ] as const

  for (const key of booleanState) {
    const missing = new Proxy(destination, {
      has(target, property): boolean {
        return property === key ? false : Reflect.has(target, property)
      }
    })
    const missingLogger = {
      [symbols.streamSym]: missing,
      flush(callback?: FlushCallback): void {
        callback?.()
      }
    }
    expect(() => newPinoServer(missingLogger as never, missing as never)).toThrow(TypeError)

    const changed = new Proxy(destination, {
      get(target, property, receiver): unknown {
        return property === key ? "invalid" : Reflect.get(target, property, receiver)
      }
    })
    const changedLogger = {
      [symbols.streamSym]: changed,
      flush(callback?: FlushCallback): void {
        callback?.()
      }
    }
    expect(() => newPinoServer(changedLogger as never, changed as never)).toThrow(TypeError)
  }

  const missingErrorState = new Proxy(destination, {
    has(target, property): boolean {
      return property === "writableErrored" ? false : Reflect.has(target, property)
    }
  })
  expect(() =>
    newPinoServer(
      {
        [symbols.streamSym]: missingErrorState,
        flush(callback?: FlushCallback): void {
          callback?.()
        }
      } as never,
      missingErrorState as never
    )
  ).toThrow(TypeError)

  const terminalStates: readonly [string, unknown][] = [
    ["destroyed", true],
    ["closed", true],
    ["writable", false],
    ["writableEnded", true],
    ["writableFinished", true]
  ]
  for (const [key, value] of terminalStates) {
    Object.defineProperty(destination, key, { configurable: true, value })
    await expect(
      newPinoServer(publishedLogger(destination), destination).start(background())
    ).rejects.toMatchObject({
      name: "PinoDestinationClosedError"
    })
    Reflect.deleteProperty(destination, key)
  }

  const startupFailure = new Error("transport startup failed")
  Object.defineProperty(destination, "writableErrored", {
    configurable: true,
    value: startupFailure
  })
  await expect(
    newPinoServer(publishedLogger(destination), destination).start(background())
  ).rejects.toBe(startupFailure)
  Reflect.deleteProperty(destination, "writableErrored")

  const server = newPinoServer(publishedLogger(destination), destination)
  const running = server.start(background())
  await server.stop(background())
  await running
  await resource.closed
})

/** Exercises synchronous listener-registration failures on Pino file destinations. */
test("published lifecycle rejects synchronous native admission failures", async () => {
  const closeResource = await publishedSonicResource()
  const closeOnce = closeResource.destination.once.bind(closeResource.destination)
  Object.defineProperty(closeResource.destination, "once", {
    configurable: true,
    value(event: string, listener: (...arguments_: readonly unknown[]) => void): SonicDestination {
      closeOnce(event, listener)
      if (event === "close") listener()
      return closeResource.destination
    }
  })
  await expect(
    newPinoServer(publishedLogger(closeResource.destination), closeResource.destination).start(
      background()
    )
  ).rejects.toMatchObject({
    name: "PinoDestinationClosedError"
  })
  Reflect.deleteProperty(closeResource.destination, "once")
  await closePublishedSonic(closeResource)

  const errorResource = await publishedSonicResource()
  const admissionFailure = new Error("destination failed during registration")
  const errorOn = errorResource.destination.on.bind(errorResource.destination)
  Object.defineProperty(errorResource.destination, "on", {
    configurable: true,
    value(event: string, listener: (...arguments_: readonly unknown[]) => void): SonicDestination {
      errorOn(event, listener)
      if (event === "error") listener(admissionFailure)
      return errorResource.destination
    }
  })
  await expect(
    newPinoServer(publishedLogger(errorResource.destination), errorResource.destination).start(
      background()
    )
  ).rejects.toBe(admissionFailure)
  Reflect.deleteProperty(errorResource.destination, "on")
  await closePublishedSonic(errorResource)

  const thrownResource = await publishedSonicResource()
  Object.defineProperty(thrownResource.destination, "once", {
    configurable: true,
    value(): never {
      throw "close listener registration failed"
    }
  })
  await expect(
    newPinoServer(publishedLogger(thrownResource.destination), thrownResource.destination).start(
      background()
    )
  ).rejects.toMatchObject({
    cause: "close listener registration failed"
  })
  Reflect.deleteProperty(thrownResource.destination, "once")
  await closePublishedSonic(thrownResource)

  const stateResource = await publishedSonicResource()
  const stateOnce = stateResource.destination.once.bind(stateResource.destination)
  Object.defineProperty(stateResource.destination, "once", {
    configurable: true,
    value(event: string, listener: (...arguments_: readonly unknown[]) => void): SonicDestination {
      stateOnce(event, listener)
      if (event === "close") Reflect.set(stateResource.destination, "_ending", true)
      return stateResource.destination
    }
  })
  await expect(
    newPinoServer(publishedLogger(stateResource.destination), stateResource.destination).start(
      background()
    )
  ).rejects.toMatchObject({
    name: "PinoDestinationClosedError"
  })
  Reflect.deleteProperty(stateResource.destination, "once")
  Reflect.set(stateResource.destination, "_ending", false)
  await closePublishedSonic(stateResource)
})

/** Exercises native error ordering and Logger flush rejection through public ownership. */
test("published lifecycle preserves flush and native failure identity", async () => {
  const flushResource = await publishedSonicResource()
  const flushFailure = new Error("published flush failed")
  const flushServer = newPinoServer(
    publishedLogger(flushResource.destination, function flush(callback?: FlushCallback): void {
      callback?.(flushFailure)
    }),
    flushResource.destination
  )
  const flushRunning = flushServer.start(background())
  await expect(flushServer.stop(background())).rejects.toBe(flushFailure)
  await expect(flushRunning).rejects.toBe(flushFailure)
  await flushResource.closed

  const nativeResource = await publishedSonicResource()
  let releaseFlush: FlushCallback | undefined
  const nativeServer = newPinoServer(
    publishedLogger(nativeResource.destination, function flush(callback?: FlushCallback): void {
      releaseFlush = callback
    }),
    nativeResource.destination
  )
  const nativeRunning = nativeServer.start(background())
  const first = new Error("first native failure")
  const second = new Error("second native failure")
  nativeResource.destination.emit("error", first)
  nativeResource.destination.emit("error", first)
  nativeResource.destination.emit("error", second)
  releaseFlush?.()
  const nativeFailure = await nativeRunning.catch((error: unknown) => error)
  expect(nativeFailure).toBeInstanceOf(AggregateError)
  expect((nativeFailure as AggregateError).errors).toEqual([first, second])
  await nativeResource.closed

  const closeResource = await publishedSonicResource()
  const closeServer = newPinoServer(
    publishedLogger(closeResource.destination),
    closeResource.destination
  )
  const closeRunning = closeServer.start(background())
  closeResource.destination.destroy()
  await expect(closeRunning).rejects.toMatchObject({
    name: "PinoDestinationClosedError"
  })
  await closeResource.closed
})

/** Exercises the Pino file-destination force boundary and native-operation failures. */
test("published lifecycle enforces file-destination hard drain boundaries", async () => {
  const forcedResource = await publishedSonicResource()
  const forcedServer = newPinoServer(
    publishedLogger(forcedResource.destination, function blockedFlush(): void {}),
    forcedResource.destination,
    pinoDrainTimeout(0)
  )
  const forcedRunning = forcedServer.start(background())
  await expect(forcedServer.stop(background())).rejects.toMatchObject({
    name: "PinoDrainTimeoutError",
    timeoutMs: 0,
    forceSupported: true
  })
  await expect(forcedRunning).rejects.toMatchObject({
    name: "PinoDrainTimeoutError"
  })
  await forcedResource.closed

  const destroyResource = await publishedSonicResource()
  const destroyServer = newPinoServer(
    publishedLogger(destroyResource.destination, function blockedFlush(): void {}),
    destroyResource.destination,
    pinoDrainTimeout(0)
  )
  const destroyRunning = destroyServer.start(background())
  const descriptor = Object.getOwnPropertyDescriptor(destroyResource.destination, "fd")
  const originalFD = Reflect.get(destroyResource.destination, "fd")
  Object.defineProperty(destroyResource.destination, "fd", {
    configurable: true,
    value: "invalid",
    writable: true
  })
  const destroyFailure = await destroyServer.stop(background()).catch((error: unknown) => error)
  expect(destroyFailure).toBeInstanceOf(AggregateError)
  expect((destroyFailure as AggregateError).errors).toHaveLength(2)
  if (descriptor === undefined) Reflect.deleteProperty(destroyResource.destination, "fd")
  else Object.defineProperty(destroyResource.destination, "fd", descriptor)
  Reflect.set(destroyResource.destination, "fd", originalFD)
  Reflect.set(destroyResource.destination, "destroyed", false)
  destroyResource.destination.destroy()
  const terminalDestroyFailure = await destroyRunning.catch((error: unknown) => error)
  expect(terminalDestroyFailure).toBeInstanceOf(AggregateError)
  expect((terminalDestroyFailure as AggregateError).errors[0]).toBe(
    (destroyFailure as AggregateError).errors[0]
  )
  expect((terminalDestroyFailure as AggregateError).errors[1]).toBe(
    (destroyFailure as AggregateError).errors[1]
  )
  await destroyResource.closed

  const endResource = await publishedSonicResource()
  const endServer = newPinoServer(
    publishedLogger(endResource.destination, function failedFlush(): void {
      throw "flush threw"
    }),
    endResource.destination,
    pinoDrainTimeout(0)
  )
  const endRunning = endServer.start(background())
  Reflect.set(endResource.destination, "destroyed", true)
  const endFailure = await endServer.stop(background()).catch((error: unknown) => error)
  expect(endFailure).toBeInstanceOf(AggregateError)
  expect((endFailure as AggregateError).errors).toHaveLength(3)
  expect((endFailure as AggregateError).errors[0]).toMatchObject({ cause: "flush threw" })
  Reflect.set(endResource.destination, "destroyed", false)
  endResource.destination.destroy()
  const terminalEndFailure = await endRunning.catch((error: unknown) => error)
  expect(terminalEndFailure).toBeInstanceOf(AggregateError)
  expect((terminalEndFailure as AggregateError).errors[0]).toBe(
    (endFailure as AggregateError).errors[0]
  )
  expect((terminalEndFailure as AggregateError).errors[1]).toBe(
    (endFailure as AggregateError).errors[1]
  )
  expect((terminalEndFailure as AggregateError).errors[2]).toBe(
    (endFailure as AggregateError).errors[2]
  )
  await endResource.closed
})

/** Exercises no-force timeout, repeated stop, late error, and late native close on ThreadStream. */
test("published lifecycle retains ThreadStream terminal observation after timeout", async () => {
  const resource = await publishedThreadResource()
  let staleNativeClose: (() => void) | undefined
  const registerOnce = resource.destination.once.bind(resource.destination)
  Object.defineProperty(resource.destination, "once", {
    configurable: true,
    value(event: string, listener: (...arguments_: readonly unknown[]) => void): ThreadDestination {
      if (event === "close") {
        staleNativeClose = function invokeStaleNativeClose(): void {
          listener()
        }
      }
      registerOnce(event, listener)
      return resource.destination
    }
  })
  const server = newPinoServer(
    publishedLogger(resource.destination, function blockedFlush(): void {}),
    resource.destination,
    pinoDrainTimeout(0)
  )
  const running = server.start(background())
  const timeoutFailure = await server.stop(background()).catch((error: unknown) => error)
  expect(timeoutFailure).toMatchObject({
    name: "PinoDrainTimeoutError",
    forceSupported: false
  })
  await expect(server.stop(background())).rejects.toBe(timeoutFailure)
  const lateFailure = new Error("late ThreadStream failure")
  resource.destination.emit("error", lateFailure)
  resource.destination.end()
  const terminalFailure = await running.catch((error: unknown) => error)
  expect(terminalFailure).toBeInstanceOf(AggregateError)
  expect((terminalFailure as AggregateError).errors).toEqual([timeoutFailure, lateFailure])
  await resource.closed
  if (staleNativeClose === undefined)
    throw new Error("ThreadStream close listener was not captured")
  staleNativeClose()
  await expect(running).rejects.toBe(terminalFailure)
})

/** Exercises the elapsed-time recheck and stale owner-timer guard with official resources. */
test("published lifecycle uses monotonic deadlines and ignores stale timeout callbacks", async () => {
  const elapsedResource = await publishedSonicResource()
  const elapsedServer = newPinoServer(
    publishedLogger(
      elapsedResource.destination,
      function delayedFlush(callback?: FlushCallback): void {
        const startedAt = performance.now()
        while (performance.now() - startedAt < 15) {}
        elapsedResource.destination.emit("close")
        callback?.()
      }
    ),
    elapsedResource.destination,
    pinoDrainTimeout(1)
  )
  const elapsedRunning = elapsedServer.start(background())
  await expect(elapsedServer.stop(background())).rejects.toMatchObject({
    name: "PinoDrainTimeoutError",
    timeoutMs: 1
  })
  await expect(elapsedRunning).rejects.toMatchObject({
    name: "PinoDrainTimeoutError"
  })
  const elapsedNativeClose = new Promise<void>(
    /** Observes physical cleanup after the synthetic lifecycle close used by the deadline case. */
    function waitForElapsedNativeClose(resolve) {
      elapsedResource.destination.once("close", resolve)
    }
  )
  elapsedResource.destination.destroy()
  await elapsedNativeClose

  const staleResource = await publishedSonicResource()
  const staleServer = newPinoServer(
    publishedLogger(staleResource.destination),
    staleResource.destination,
    pinoDrainTimeout(100)
  )
  const staleRunning = staleServer.start(background())
  const nativeSetTimeout = globalThis.setTimeout
  let staleCallback: (() => void) | undefined
  function captureTimeout(
    callback: TimerHandler,
    delay?: number,
    ...arguments_: readonly unknown[]
  ) {
    if (typeof callback === "function") {
      staleCallback = function invokeCapturedTimeout(): void {
        callback(...arguments_)
      }
    }
    return nativeSetTimeout(callback, delay, ...arguments_)
  }
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: captureTimeout,
    writable: true
  })
  try {
    await staleServer.stop(background())
  } finally {
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: nativeSetTimeout,
      writable: true
    })
  }
  if (staleCallback === undefined) throw new Error("Pino owner timeout callback was not captured")
  staleCallback()
  await staleRunning
  await staleResource.closed
})
