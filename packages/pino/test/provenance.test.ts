import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"
import { background } from "@go-like/context"
import pino, { symbols } from "pino"

import { pinoDrainTimeout, newPinoServer } from "../src/index"

interface StartOutcome {
  readonly error: unknown
}

interface DestinationState {
  readonly destroyed: boolean
  readonly writable: boolean
}

/** Reads the Pino file-destination runtime state absent from its public declarations. */
function destinationState(value: unknown): DestinationState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("destroyed" in value) ||
    typeof value.destroyed !== "boolean" ||
    !("writable" in value) ||
    typeof value.writable !== "boolean"
  ) {
    throw new Error("Pino file destination state changed")
  }
  return Object.freeze({ destroyed: value.destroyed, writable: value.writable })
}

/** Observes the synchronous admission result without waiting for the full runtime. */
async function observeStart(server: ReturnType<typeof newPinoServer>): Promise<StartOutcome> {
  let error: unknown = null
  const running = server.start(background())
  void running.then(
    function terminated(): void {},
    function rejected(value: unknown): void {
      error = value
    }
  )
  await Promise.resolve()
  return Object.freeze({ error })
}

/** Destroys one official destination only while it remains open. */
function destroyIfOpen(destination: ReturnType<typeof pino.destination>): void {
  if (!("destroyed" in destination) || typeof destination.destroyed !== "boolean") {
    throw new Error("Pino file destination did not expose destroyed state")
  }
  if (!destination.destroyed) destination.destroy()
}

test("uses the file destination implementation owned by Pino", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-provenance-"))
  const path = join(directory, "provenance.log")
  const destination = pino.destination({ dest: path, mkdir: true, sync: false })
  const closed = once(destination, "close")
  try {
    const logger = pino({ base: null, timestamp: false }, destination)
    const server = newPinoServer(logger, destination)
    const running = server.start(background())
    logger.info({ dependencyBoundary: "pino-owned" }, "published dependency boundary")
    await server.stop(background())
    await running
    const record = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>
    expect(record.dependencyBoundary).toBe("pino-owned")
  } finally {
    if (!("destroyed" in destination) || typeof destination.destroyed !== "boolean") {
      throw new Error("Pino file destination did not expose destroyed state")
    }
    if (!destination.destroyed) destination.destroy()
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("uses stable file-destination methods first observed at construction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-construction-baseline-"))
  const destination = pino.destination({
    dest: join(directory, "construction-baseline.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const nativeEnd = destination.end
  let baselineEndCalls = 0
  try {
    await once(destination, "ready")
    Object.defineProperty(destination, "end", {
      configurable: true,
      value: function constructionBaselineEnd(this: typeof destination): void {
        baselineEndCalls += 1
        nativeEnd.call(this)
      },
      writable: true
    })
    const logger = pino({ base: null, timestamp: false }, destination)
    const server = newPinoServer(logger, destination)
    const running = server.start(background())
    await server.stop(background())
    await running
    expect(baselineEndCalls).toBe(1)
  } finally {
    Reflect.deleteProperty(destination, "end")
    if (!("destroyed" in destination) || typeof destination.destroyed !== "boolean") {
      throw new Error("Pino file destination did not expose destroyed state")
    }
    if (!destination.destroyed) destination.destroy()
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("revalidates the file-destination prototype method after construction and before ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-provenance-start-mutation-"))
  const destination = pino.destination({
    dest: join(directory, "start-mutation.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const server = newPinoServer(logger, destination)
  const destinationPrototype = Object.getPrototypeOf(destination) as {
    end: typeof destination.end
  }
  const originalEnd = destinationPrototype.end
  try {
    await once(destination, "ready")
    const baselineErrorListeners = destination.listenerCount("error")
    const baselineCloseListeners = destination.listenerCount("close")
    destinationPrototype.end = function changedAfterConstruction(): void {}
    const outcome = await observeStart(server)
    destinationPrototype.end = originalEnd
    expect(outcome.error).toBeInstanceOf(TypeError)
    expect(destination.listenerCount("error")).toBe(baselineErrorListeners)
    expect(destination.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    destinationPrototype.end = originalEnd
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects an own end override introduced after construction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-provenance-own-end-"))
  const destination = pino.destination({
    dest: join(directory, "own-end.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const server = newPinoServer(logger, destination)
  try {
    await once(destination, "ready")
    const baselineErrorListeners = destination.listenerCount("error")
    const baselineCloseListeners = destination.listenerCount("close")
    Object.defineProperty(destination, "end", {
      configurable: true,
      value: function changedOwnEnd(): void {},
      writable: true
    })
    const outcome = await observeStart(server)
    Reflect.deleteProperty(destination, "end")
    expect(outcome.error).toBeInstanceOf(TypeError)
    expect(destination.listenerCount("error")).toBe(baselineErrorListeners)
    expect(destination.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    Reflect.deleteProperty(destination, "end")
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("revalidates the exact logger stream binding at ownership admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-provenance-stream-drift-"))
  const first = pino.destination({ dest: join(directory, "first.log"), mkdir: true, sync: false })
  const second = pino.destination({ dest: join(directory, "second.log"), mkdir: true, sync: false })
  const firstClosed = once(first, "close")
  const secondClosed = once(second, "close")
  const logger = pino({ base: null, timestamp: false }, first)
  const server = newPinoServer(logger, first)
  const streamDescriptor = Object.getOwnPropertyDescriptor(logger, symbols.streamSym)
  try {
    await Promise.all([once(first, "ready"), once(second, "ready")])
    const baselineErrorListeners = first.listenerCount("error")
    const baselineCloseListeners = first.listenerCount("close")
    Object.defineProperty(logger, symbols.streamSym, {
      configurable: true,
      value: second,
      writable: true
    })
    const outcome = await observeStart(server)
    if (streamDescriptor !== undefined) {
      Object.defineProperty(logger, symbols.streamSym, streamDescriptor)
    }
    expect(outcome.error).toBeInstanceOf(TypeError)
    expect(first.listenerCount("error")).toBe(baselineErrorListeners)
    expect(first.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    if (streamDescriptor !== undefined) {
      Object.defineProperty(logger, symbols.streamSym, streamDescriptor)
    }
    destroyIfOpen(first)
    destroyIfOpen(second)
    await Promise.all([firstClosed.catch(() => {}), secondClosed.catch(() => {})])
    await rm(directory, { recursive: true, force: true })
  }
})

test("revalidates construction operations after synchronous listener-registration re-entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-provenance-listener-reentry-"))
  const destination = pino.destination({
    dest: join(directory, "listener-reentry.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const server = newPinoServer(logger, destination)
  const destinationPrototype = Object.getPrototypeOf(destination) as {
    end: typeof destination.end
  }
  const originalEnd = destinationPrototype.end
  const nativeOn = destination.on
  try {
    await once(destination, "ready")
    const baselineErrorListeners = destination.listenerCount("error")
    const baselineCloseListeners = destination.listenerCount("close")
    Object.defineProperty(destination, "on", {
      configurable: true,
      value: function mutateDuringRegistration(
        this: typeof destination,
        event: string | symbol,
        listener: (...args: unknown[]) => void
      ): typeof destination {
        if (event === "error") {
          destinationPrototype.end = function changedDuringRegistration(): void {}
        }
        return nativeOn.call(this, event, listener)
      },
      writable: true
    })
    const outcome = await observeStart(server)
    destinationPrototype.end = originalEnd
    Reflect.deleteProperty(destination, "on")
    expect(outcome.error).toBeInstanceOf(TypeError)
    expect(destination.listenerCount("error")).toBe(baselineErrorListeners)
    expect(destination.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    destinationPrototype.end = originalEnd
    Reflect.deleteProperty(destination, "on")
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects lifecycle method drift during owner operation capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-capture-drift-"))
  const destination = pino.destination({
    dest: join(directory, "owner-capture-drift.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const flushDescriptor = Object.getOwnPropertyDescriptor(logger, "flush")
  const nativeFlush = logger.flush
  const replacementFlush = function replacementFlush(): void {}
  const server = newPinoServer(logger, destination)
  let reads = 0
  try {
    await once(destination, "ready")
    Object.defineProperty(logger, "flush", {
      configurable: true,
      get(): typeof nativeFlush {
        reads += 1
        return reads >= 5 ? replacementFlush : nativeFlush
      }
    })
    const outcome = await observeStart(server)
    expect(outcome.error).toBeInstanceOf(TypeError)
    expect((outcome.error as Error).message).toBe(
      "Pino lifecycle methods changed during ownership admission"
    )
  } finally {
    if (flushDescriptor === undefined) Reflect.deleteProperty(logger, "flush")
    else Object.defineProperty(logger, "flush", flushDescriptor)
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects lifecycle method drift after owner operation capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-post-capture-drift-"))
  const destination = pino.destination({
    dest: join(directory, "owner-post-capture-drift.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const flushDescriptor = Object.getOwnPropertyDescriptor(logger, "flush")
  const nativeFlush = logger.flush
  const replacementFlush = function replacementFlush(): void {}
  const server = newPinoServer(logger, destination)
  let reads = 0
  try {
    await once(destination, "ready")
    const baselineErrorListeners = destination.listenerCount("error")
    const baselineCloseListeners = destination.listenerCount("close")
    Object.defineProperty(logger, "flush", {
      configurable: true,
      get(): typeof nativeFlush {
        reads += 1
        return reads >= 6 ? replacementFlush : nativeFlush
      }
    })
    const outcome = await observeStart(server)
    expect(outcome.error).toBeInstanceOf(TypeError)
    expect((outcome.error as Error).message).toBe(
      "Pino lifecycle methods changed during ownership admission"
    )
    expect(destination.listenerCount("error")).toBe(baselineErrorListeners)
    expect(destination.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    if (flushDescriptor === undefined) Reflect.deleteProperty(logger, "flush")
    else Object.defineProperty(logger, "flush", flushDescriptor)
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects a destination destroyed during owner operation capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-capture-destroy-"))
  const destination = pino.destination({
    dest: join(directory, "owner-capture-destroy.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const flushDescriptor = Object.getOwnPropertyDescriptor(logger, "flush")
  const nativeFlush = logger.flush
  let reads = 0
  let flushCalls = 0
  let captureActionCalls = 0
  const admittedFlush = function admittedFlush(callback?: (error?: Error) => void): void {
    flushCalls += 1
    nativeFlush.call(logger, callback)
  }
  Object.defineProperty(logger, "flush", {
    configurable: true,
    value: admittedFlush,
    writable: true
  })
  const server = newPinoServer(logger, destination)
  try {
    await once(destination, "ready")
    const baselineErrorListeners = destination.listenerCount("error")
    const baselineCloseListeners = destination.listenerCount("close")
    Object.defineProperty(logger, "flush", {
      configurable: true,
      get(): typeof admittedFlush {
        reads += 1
        if (reads === 4) {
          captureActionCalls += 1
          destination.destroy()
        }
        return admittedFlush
      }
    })
    const outcome = await observeStart(server)
    expect(outcome.error).toMatchObject({ code: "GO_LIKE_PINO_DESTINATION_CLOSED" })
    expect(captureActionCalls).toBe(1)
    expect(flushCalls).toBe(0)
    expect(destination.listenerCount("error")).toBe(baselineErrorListeners)
    expect(destination.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    if (flushDescriptor === undefined) Reflect.deleteProperty(logger, "flush")
    else Object.defineProperty(logger, "flush", flushDescriptor)
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("preserves an error emitted during owner operation capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-capture-error-"))
  const destination = pino.destination({
    dest: join(directory, "owner-capture-error.log"),
    mkdir: true,
    sync: false
  })
  const logger = pino({ base: null, timestamp: false }, destination)
  const flushDescriptor = Object.getOwnPropertyDescriptor(logger, "flush")
  const nativeFlush = logger.flush
  const nativeOn = destination.on
  const injected = new Error("capture error")
  let reads = 0
  let flushCalls = 0
  let captureActionCalls = 0
  let installedErrorListener: ((...args: unknown[]) => void) | null = null
  const admittedFlush = function admittedFlush(callback?: (error?: Error) => void): void {
    flushCalls += 1
    nativeFlush.call(logger, callback)
  }
  Object.defineProperty(logger, "flush", {
    configurable: true,
    value: admittedFlush,
    writable: true
  })
  const server = newPinoServer(logger, destination)
  try {
    await once(destination, "ready")
    const baselineCloseListeners = destination.listenerCount("close")
    Object.defineProperty(logger, "flush", {
      configurable: true,
      get(): typeof admittedFlush {
        reads += 1
        if (reads === 4) {
          captureActionCalls += 1
          destination.emit("error", injected)
        }
        return admittedFlush
      }
    })
    Object.defineProperty(destination, "on", {
      configurable: true,
      value: function observeErrorListener(
        this: typeof destination,
        event: string | symbol,
        listener: (...args: unknown[]) => void
      ): typeof destination {
        if (event === "error") installedErrorListener = listener
        return nativeOn.call(this, event, listener)
      },
      writable: true
    })
    const outcome = await observeStart(server)
    expect(outcome.error).toBe(injected)
    expect(captureActionCalls).toBe(1)
    expect(flushCalls).toBe(0)
    expect(destinationState(destination)).toEqual({ destroyed: false, writable: true })
    expect(installedErrorListener).not.toBeNull()
    expect(destination.listeners("error")).not.toContain(installedErrorListener)
    expect(destination.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    Reflect.deleteProperty(destination, "on")
    if (flushDescriptor === undefined) Reflect.deleteProperty(logger, "flush")
    else Object.defineProperty(logger, "flush", flushDescriptor)
    if (!destinationState(destination).destroyed) {
      const closed = once(destination, "close")
      destination.destroy()
      await closed.catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects a close emitted during owner operation capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-capture-close-"))
  const destination = pino.destination({
    dest: join(directory, "owner-capture-close.log"),
    mkdir: true,
    sync: false
  })
  const logger = pino({ base: null, timestamp: false }, destination)
  const flushDescriptor = Object.getOwnPropertyDescriptor(logger, "flush")
  const nativeFlush = logger.flush
  let reads = 0
  let flushCalls = 0
  let captureActionCalls = 0
  const admittedFlush = function admittedFlush(callback?: (error?: Error) => void): void {
    flushCalls += 1
    nativeFlush.call(logger, callback)
  }
  Object.defineProperty(logger, "flush", {
    configurable: true,
    value: admittedFlush,
    writable: true
  })
  const server = newPinoServer(logger, destination)
  try {
    await once(destination, "ready")
    const baselineErrorListeners = destination.listenerCount("error")
    const baselineCloseListeners = destination.listenerCount("close")
    Object.defineProperty(logger, "flush", {
      configurable: true,
      get(): typeof admittedFlush {
        reads += 1
        if (reads === 4) {
          captureActionCalls += 1
          destination.emit("close")
        }
        return admittedFlush
      }
    })
    const outcome = await observeStart(server)
    expect(outcome.error).toMatchObject({ code: "GO_LIKE_PINO_DESTINATION_CLOSED" })
    expect(captureActionCalls).toBe(1)
    expect(flushCalls).toBe(0)
    expect(destinationState(destination)).toEqual({ destroyed: false, writable: true })
    expect(destination.listenerCount("error")).toBe(baselineErrorListeners)
    expect(destination.listenerCount("close")).toBe(baselineCloseListeners)
  } finally {
    if (flushDescriptor === undefined) Reflect.deleteProperty(logger, "flush")
    else Object.defineProperty(logger, "flush", flushDescriptor)
    if (!destinationState(destination).destroyed) {
      const closed = once(destination, "close")
      destination.destroy()
      await closed.catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test("uses the admitted prototype end after ownership transfer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-prototype-"))
  const destination = pino.destination({
    dest: join(directory, "owner-prototype.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const server = newPinoServer(logger, destination, pinoDrainTimeout(100))
  const running = server.start(background())
  const destinationPrototype = Object.getPrototypeOf(destination) as {
    end: typeof destination.end
  }
  const originalEnd = destinationPrototype.end
  let replacementCalls = 0
  try {
    await once(destination, "ready")
    destinationPrototype.end = function changedAfterOwnership(): void {
      replacementCalls += 1
    }
    await server.stop(background())
    await running
    expect(replacementCalls).toBe(0)
  } finally {
    destinationPrototype.end = originalEnd
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("uses admitted own lifecycle targets after destination method drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-own-methods-"))
  const destination = pino.destination({
    dest: join(directory, "owner-own-methods.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const server = newPinoServer(logger, destination, pinoDrainTimeout(100))
  const running = server.start(background())
  let endCalls = 0
  let destroyCalls = 0
  try {
    await once(destination, "ready")
    Object.defineProperties(destination, {
      end: {
        configurable: true,
        value: function changedOwnEnd(): void {
          endCalls += 1
        },
        writable: true
      },
      destroy: {
        configurable: true,
        value: function changedOwnDestroy(): void {
          destroyCalls += 1
        },
        writable: true
      }
    })
    const stopping = server.stop(background())
    const stopped = await stopping.then(
      function resolved() {
        return Object.freeze({ error: null })
      },
      function rejected(error: unknown) {
        return Object.freeze({ error })
      }
    )
    Reflect.deleteProperty(destination, "end")
    Reflect.deleteProperty(destination, "destroy")
    if (stopped.error !== null) destroyIfOpen(destination)
    const terminal = await running.then(
      function resolved() {
        return Object.freeze({ error: null })
      },
      function rejected(error: unknown) {
        return Object.freeze({ error })
      }
    )
    expect(stopped.error).toBeNull()
    expect(terminal.error).toBeNull()
    expect(endCalls).toBe(0)
    expect(destroyCalls).toBe(0)
  } finally {
    Reflect.deleteProperty(destination, "end")
    Reflect.deleteProperty(destination, "destroy")
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("uses the admitted Logger flush target after method drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-logger-method-"))
  const destination = pino.destination({
    dest: join(directory, "owner-logger-method.log"),
    mkdir: true,
    sync: false
  })
  const closed = once(destination, "close")
  const logger = pino({ base: null, timestamp: false }, destination)
  const flushDescriptor = Object.getOwnPropertyDescriptor(logger, "flush")
  const nativeFlush = logger.flush.bind(logger)
  let admittedCalls = 0
  let replacementCalls = 0
  try {
    await once(destination, "ready")
    Object.defineProperty(logger, "flush", {
      configurable: true,
      value: function admittedLoggerFlush(callback?: (error?: Error) => void): void {
        admittedCalls += 1
        nativeFlush(callback)
      },
      writable: true
    })
    const server = newPinoServer(logger, destination, pinoDrainTimeout(100))
    const running = server.start(background())
    Object.defineProperty(logger, "flush", {
      configurable: true,
      value: function changedLoggerFlush(): void {
        replacementCalls += 1
      },
      writable: true
    })
    await server.stop(background())
    await running
    expect(admittedCalls).toBe(1)
    expect(replacementCalls).toBe(0)
  } finally {
    if (flushDescriptor === undefined) Reflect.deleteProperty(logger, "flush")
    else Object.defineProperty(logger, "flush", flushDescriptor)
    destroyIfOpen(destination)
    await closed.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails closed on owner Logger stream drift while closing the transferred destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-owner-stream-drift-"))
  const first = pino.destination({
    dest: join(directory, "owner-first.log"),
    mkdir: true,
    sync: false
  })
  const second = pino.destination({
    dest: join(directory, "owner-second.log"),
    mkdir: true,
    sync: false
  })
  const firstClosed = once(first, "close")
  const secondClosed = once(second, "close")
  const logger = pino({ base: null, timestamp: false }, first)
  const server = newPinoServer(logger, first)
  const running = server.start(background())
  const streamDescriptor = Object.getOwnPropertyDescriptor(logger, symbols.streamSym)
  try {
    await Promise.all([once(first, "ready"), once(second, "ready")])
    Object.defineProperty(logger, symbols.streamSym, {
      configurable: true,
      value: second,
      writable: true
    })
    const stopping = server.stop(background())
    const stopError = await stopping.then(
      function resolved(): unknown {
        return null
      },
      function rejected(error: unknown): unknown {
        return error
      }
    )
    const runningError = await running.then(
      function resolved(): unknown {
        return null
      },
      function rejected(error: unknown): unknown {
        return error
      }
    )
    expect(stopError).toBeInstanceOf(TypeError)
    expect(runningError).toBe(stopError)
    expect(destinationState(first).destroyed).toBeTrue()
    expect(destinationState(second)).toEqual({ destroyed: false, writable: true })
  } finally {
    if (streamDescriptor !== undefined)
      Object.defineProperty(logger, symbols.streamSym, streamDescriptor)
    destroyIfOpen(first)
    destroyIfOpen(second)
    await Promise.all([firstClosed.catch(() => {}), secondClosed.catch(() => {})])
    await rm(directory, { recursive: true, force: true })
  }
})
