import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { background } from "@go-like/context"
import { pinoDrainTimeout, newPinoServer } from "@go-like/pino"
import pino, { symbols } from "pino"

interface FileDestinationState {
  readonly destroyed: boolean
  readonly writable: boolean
}

type NativeServer = ReturnType<typeof newPinoServer>

interface StartOutcome {
  readonly error: unknown
}

interface TerminalOutcome {
  readonly stopError: unknown
  readonly runningError: unknown
}

/** Reads Pino's file-destination runtime state absent from its published declarations. */
function fileDestinationState(value: unknown): FileDestinationState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("destroyed" in value) ||
    typeof value.destroyed !== "boolean" ||
    !("writable" in value) ||
    typeof value.writable !== "boolean"
  ) {
    throw new Error("Pino file-destination runtime state shape changed")
  }
  return Object.freeze({
    destroyed: value.destroyed,
    writable: value.writable
  })
}

/** Returns whether one temporary path has been removed. */
async function removed(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return true
    throw error
  }
}

/** Observes the synchronous ownership-admission result without waiting for termination. */
async function observeStart(server: NativeServer): Promise<StartOutcome> {
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

/** Requires a fail-closed TypeError from synchronous ownership admission. */
async function requireRejectedStart(label: string, outcome: StartOutcome): Promise<void> {
  if (!(outcome.error instanceof TypeError)) {
    if (outcome.error === null)
      throw new Error(`${label} unexpectedly transferred destination ownership`)
    throw outcome.error
  }
}

/** Observes stop and the full runtime without losing either owner failure identity. */
async function observeTerminal(
  server: NativeServer,
  running: Promise<void>
): Promise<TerminalOutcome> {
  const stopError = await server.stop(background()).then(
    function stopped(): unknown {
      return null
    },
    function stopRejected(error: unknown): unknown {
      return error
    }
  )
  const runningError = await running.then(
    function terminated(): unknown {
      return null
    },
    function terminalRejected(error: unknown): unknown {
      return error
    }
  )
  return Object.freeze({ stopError, runningError })
}

/** Closes one Pino file destination after an intentionally rejected admission. */
function destroyIfOpen(destination: ReturnType<typeof pino.destination>): void {
  if (!fileDestinationState(destination).destroyed) destination.destroy()
}

interface ListenerProbe {
  /** Reports whether both adapter admission listeners were observed. */
  captured(): boolean
  /** Reports whether neither observed adapter listener remains installed. */
  clean(): boolean
  /** Restores the destination's original EventEmitter method descriptors. */
  restore(): void
}

/** Observes the exact adapter listeners without relying on unrelated native listener counts. */
function installListenerProbe(destination: ReturnType<typeof pino.destination>): ListenerProbe {
  const onDescriptor = Object.getOwnPropertyDescriptor(destination, "on")
  const onceDescriptor = Object.getOwnPropertyDescriptor(destination, "once")
  const nativeOn = destination.on
  const nativeOnce = destination.once
  let errorListener: ((...values: unknown[]) => void) | null = null
  let closeListener: ((...values: unknown[]) => void) | null = null
  Object.defineProperties(destination, {
    on: {
      configurable: true,
      value: function observeAdapterOn(
        this: typeof destination,
        event: string | symbol,
        listener: (...values: unknown[]) => void
      ): typeof destination {
        if (event === "error") errorListener = listener
        return nativeOn.call(this, event, listener)
      },
      writable: true
    },
    once: {
      configurable: true,
      value: function observeAdapterOnce(
        this: typeof destination,
        event: string | symbol,
        listener: (...values: unknown[]) => void
      ): typeof destination {
        if (event === "close") closeListener = listener
        return nativeOnce.call(this, event, listener)
      },
      writable: true
    }
  })
  return Object.freeze({
    captured(): boolean {
      return errorListener !== null && closeListener !== null
    },
    clean(): boolean {
      return (
        errorListener !== null &&
        closeListener !== null &&
        !destination.listeners("error").includes(errorListener) &&
        !destination.listeners("close").includes(closeListener)
      )
    },
    restore(): void {
      if (onDescriptor === undefined) Reflect.deleteProperty(destination, "on")
      else Object.defineProperty(destination, "on", onDescriptor)
      if (onceDescriptor === undefined) Reflect.deleteProperty(destination, "once")
      else Object.defineProperty(destination, "once", onceDescriptor)
    }
  })
}

const directory = await mkdtemp(resolve(tmpdir(), "go-like-pino-e2e-"))
let destinationComponent: unknown = null
let destinationRedacted: unknown = null
let destinationFileLanded = false
let destinationCloseObserved = false
let destinationPreterminalOwnershipCalls = 0
let destinationPreterminalListenersRestored = false
let destinationEndingWindowOwnershipCalls = 0
let destinationEndingWindowListenersRestored = false
let startPrototypeMutationOwnershipCalls = 0
let startPrototypeMutationListenersRestored = false
let startOwnMethodMutationOwnershipCalls = 0
let startOwnMethodMutationListenersRestored = false
let startLoggerBindingOwnershipUnchanged = false
let startLoggerBindingListenersRestored = false
let startRegistrationReentryOwnershipCalls = 0
let startRegistrationReentryListenersRestored = false
let startCaptureDestroyOwnershipCalls = 0
let startCaptureDestroyListenersRestored = false
let startCaptureErrorRejected = false
let startCaptureErrorIdentityPreserved = false
let startCaptureErrorOwnershipCalls = 0
let startCaptureErrorListenersRestored = false
let startCaptureCloseOwnershipCalls = 0
let startCaptureCloseListenersRestored = false
let startCaptureCloseDestinationOpen = false
let ownerPrototypeMethodCaptured = false
let ownerPrototypeReplacementCalls = 0
let ownerOwnMethodsCaptured = false
let ownerOwnEndCalls = 0
let ownerOwnDestroyCalls = 0
let ownerLoggerMethodCaptured = false
let ownerAdmittedFlushCalls = 0
let ownerReplacementFlushCalls = 0
let ownerStreamDriftRejected = false
let ownerStreamDriftErrorStable = false
let ownerStreamOriginalClosed = false
let ownerStreamReplacementOpen = false
let transportComponent: unknown = null
let transportFileLanded = false
let transportCloseObserved = false
let transportPreterminalOwnershipCalls = 0
let transportPreterminalListenersRestored = false

try {
  const destinationPath = resolve(directory, "destination.log")
  const destination = pino.destination({ dest: destinationPath, mkdir: true, sync: false })
  destination.once("close", function observeDestinationClose(): void {
    destinationCloseObserved = true
  })
  const destinationLogger = pino({ base: null, timestamp: false, redact: ["secret"] }, destination)
  const destinationServer = newPinoServer(destinationLogger, destination)
  const destinationRunning = destinationServer.start(background())
  destinationLogger.info({ component: "file", secret: "hidden" }, "native destination")
  await destinationServer.stop(background())
  await destinationRunning
  if (!destinationCloseObserved)
    throw new Error("Pino destination runtime settled before native close")
  const destinationLines = (await readFile(destinationPath, "utf8")).trim().split("\n")
  destinationFileLanded = destinationLines.length === 1
  const destinationRecord = JSON.parse(destinationLines[0] ?? "null") as Readonly<
    Record<string, unknown>
  >
  destinationComponent = destinationRecord.component
  destinationRedacted = destinationRecord.secret
  if (
    !destinationFileLanded ||
    destinationComponent !== "file" ||
    destinationRedacted !== "[Redacted]"
  ) {
    throw new Error("Pino native destination record or redaction changed")
  }

  const prototypeMutationDestination = pino.destination({
    dest: resolve(directory, "start-prototype-mutation.log"),
    mkdir: true,
    sync: false
  })
  const prototypeMutationClosed = once(prototypeMutationDestination, "close")
  const prototypeMutationLogger = pino(
    { base: null, timestamp: false },
    prototypeMutationDestination
  )
  const prototypeMutationServer = newPinoServer(
    prototypeMutationLogger,
    prototypeMutationDestination
  )
  const fileDestinationPrototype = Object.getPrototypeOf(prototypeMutationDestination) as {
    end: typeof prototypeMutationDestination.end
  }
  const originalPrototypeEnd = fileDestinationPrototype.end
  try {
    await once(prototypeMutationDestination, "ready")
    const errorListeners = prototypeMutationDestination.listenerCount("error")
    const closeListeners = prototypeMutationDestination.listenerCount("close")
    fileDestinationPrototype.end = function changedAfterConstruction(): void {
      startPrototypeMutationOwnershipCalls += 1
    }
    const outcome = await observeStart(prototypeMutationServer)
    fileDestinationPrototype.end = originalPrototypeEnd
    await requireRejectedStart("prototype mutation", outcome)
    startPrototypeMutationListenersRestored =
      prototypeMutationDestination.listenerCount("error") === errorListeners &&
      prototypeMutationDestination.listenerCount("close") === closeListeners
    if (startPrototypeMutationOwnershipCalls !== 0 || !startPrototypeMutationListenersRestored) {
      throw new Error("Prototype mutation rejection changed destination ownership or listeners")
    }
  } finally {
    fileDestinationPrototype.end = originalPrototypeEnd
    destroyIfOpen(prototypeMutationDestination)
    await prototypeMutationClosed.catch(() => {})
  }

  const ownMutationDestination = pino.destination({
    dest: resolve(directory, "start-own-method-mutation.log"),
    mkdir: true,
    sync: false
  })
  const ownMutationClosed = once(ownMutationDestination, "close")
  const ownMutationLogger = pino({ base: null, timestamp: false }, ownMutationDestination)
  const ownMutationServer = newPinoServer(ownMutationLogger, ownMutationDestination)
  try {
    await once(ownMutationDestination, "ready")
    const errorListeners = ownMutationDestination.listenerCount("error")
    const closeListeners = ownMutationDestination.listenerCount("close")
    Object.defineProperty(ownMutationDestination, "end", {
      configurable: true,
      value: function changedOwnEnd(): void {
        startOwnMethodMutationOwnershipCalls += 1
      },
      writable: true
    })
    const outcome = await observeStart(ownMutationServer)
    Reflect.deleteProperty(ownMutationDestination, "end")
    await requireRejectedStart("own method mutation", outcome)
    startOwnMethodMutationListenersRestored =
      ownMutationDestination.listenerCount("error") === errorListeners &&
      ownMutationDestination.listenerCount("close") === closeListeners
    if (startOwnMethodMutationOwnershipCalls !== 0 || !startOwnMethodMutationListenersRestored) {
      throw new Error("Own method mutation rejection changed destination ownership or listeners")
    }
  } finally {
    Reflect.deleteProperty(ownMutationDestination, "end")
    destroyIfOpen(ownMutationDestination)
    await ownMutationClosed.catch(() => {})
  }

  const loggerBindingDestination = pino.destination({
    dest: resolve(directory, "start-logger-binding.log"),
    mkdir: true,
    sync: false
  })
  const loggerBindingReplacement = pino.destination({
    dest: resolve(directory, "start-logger-binding-replacement.log"),
    mkdir: true,
    sync: false
  })
  const loggerBindingClosed = once(loggerBindingDestination, "close")
  const loggerBindingReplacementClosed = once(loggerBindingReplacement, "close")
  const loggerBindingLogger = pino({ base: null, timestamp: false }, loggerBindingDestination)
  const loggerBindingServer = newPinoServer(loggerBindingLogger, loggerBindingDestination)
  const loggerStreamDescriptor = Object.getOwnPropertyDescriptor(
    loggerBindingLogger,
    symbols.streamSym
  )
  try {
    await Promise.all([
      once(loggerBindingDestination, "ready"),
      once(loggerBindingReplacement, "ready")
    ])
    const errorListeners = loggerBindingDestination.listenerCount("error")
    const closeListeners = loggerBindingDestination.listenerCount("close")
    Object.defineProperty(loggerBindingLogger, symbols.streamSym, {
      configurable: true,
      value: loggerBindingReplacement,
      writable: true
    })
    const outcome = await observeStart(loggerBindingServer)
    if (loggerStreamDescriptor !== undefined) {
      Object.defineProperty(loggerBindingLogger, symbols.streamSym, loggerStreamDescriptor)
    }
    await requireRejectedStart("logger binding drift", outcome)
    startLoggerBindingOwnershipUnchanged =
      !fileDestinationState(loggerBindingDestination).destroyed &&
      fileDestinationState(loggerBindingDestination).writable
    startLoggerBindingListenersRestored =
      loggerBindingDestination.listenerCount("error") === errorListeners &&
      loggerBindingDestination.listenerCount("close") === closeListeners
    if (!startLoggerBindingOwnershipUnchanged || !startLoggerBindingListenersRestored) {
      throw new Error("Logger binding rejection changed destination ownership or listeners")
    }
  } finally {
    if (loggerStreamDescriptor !== undefined) {
      Object.defineProperty(loggerBindingLogger, symbols.streamSym, loggerStreamDescriptor)
    }
    destroyIfOpen(loggerBindingDestination)
    destroyIfOpen(loggerBindingReplacement)
    await Promise.all([
      loggerBindingClosed.catch(() => {}),
      loggerBindingReplacementClosed.catch(() => {})
    ])
  }

  const reentryDestination = pino.destination({
    dest: resolve(directory, "start-registration-reentry.log"),
    mkdir: true,
    sync: false
  })
  const reentryClosed = once(reentryDestination, "close")
  const reentryLogger = pino({ base: null, timestamp: false }, reentryDestination)
  const reentryServer = newPinoServer(reentryLogger, reentryDestination)
  const nativeOn = reentryDestination.on
  try {
    await once(reentryDestination, "ready")
    const errorListeners = reentryDestination.listenerCount("error")
    const closeListeners = reentryDestination.listenerCount("close")
    Object.defineProperty(reentryDestination, "on", {
      configurable: true,
      value: function mutateDuringRegistration(
        this: typeof reentryDestination,
        event: string | symbol,
        listener: (...values: unknown[]) => void
      ): typeof reentryDestination {
        if (event === "error") {
          fileDestinationPrototype.end = function changedDuringRegistration(): void {
            startRegistrationReentryOwnershipCalls += 1
          }
        }
        return nativeOn.call(this, event, listener)
      },
      writable: true
    })
    const outcome = await observeStart(reentryServer)
    fileDestinationPrototype.end = originalPrototypeEnd
    Reflect.deleteProperty(reentryDestination, "on")
    await requireRejectedStart("listener registration re-entry", outcome)
    startRegistrationReentryListenersRestored =
      reentryDestination.listenerCount("error") === errorListeners &&
      reentryDestination.listenerCount("close") === closeListeners
    if (
      startRegistrationReentryOwnershipCalls !== 0 ||
      !startRegistrationReentryListenersRestored
    ) {
      throw new Error("Listener registration re-entry changed destination ownership or listeners")
    }
  } finally {
    fileDestinationPrototype.end = originalPrototypeEnd
    Reflect.deleteProperty(reentryDestination, "on")
    destroyIfOpen(reentryDestination)
    await reentryClosed.catch(() => {})
  }

  const captureDestroyDestination = pino.destination({
    dest: resolve(directory, "start-capture-destroy.log"),
    mkdir: true,
    sync: false
  })
  const captureDestroyClosed = once(captureDestroyDestination, "close")
  const captureDestroyLogger = pino({ base: null, timestamp: false }, captureDestroyDestination)
  const captureDestroyFlushDescriptor = Object.getOwnPropertyDescriptor(
    captureDestroyLogger,
    "flush"
  )
  const captureDestroyNativeFlush = captureDestroyLogger.flush
  let captureDestroyReads = 0
  const admittedCaptureDestroyFlush = function admittedCaptureDestroyFlush(
    callback?: (error?: Error) => void
  ): void {
    startCaptureDestroyOwnershipCalls += 1
    captureDestroyNativeFlush.call(captureDestroyLogger, callback)
  }
  Object.defineProperty(captureDestroyLogger, "flush", {
    configurable: true,
    value: admittedCaptureDestroyFlush,
    writable: true
  })
  const captureDestroyServer = newPinoServer(captureDestroyLogger, captureDestroyDestination)
  const captureDestroyListeners = installListenerProbe(captureDestroyDestination)
  try {
    await once(captureDestroyDestination, "ready")
    Object.defineProperty(captureDestroyLogger, "flush", {
      configurable: true,
      get(): typeof admittedCaptureDestroyFlush {
        captureDestroyReads += 1
        if (captureDestroyReads === 4) captureDestroyDestination.destroy()
        return admittedCaptureDestroyFlush
      }
    })
    const outcome = await observeStart(captureDestroyServer)
    if (
      !(outcome.error instanceof Error) ||
      !("code" in outcome.error) ||
      outcome.error.code !== "GO_LIKE_PINO_DESTINATION_CLOSED"
    )
      throw outcome.error
    startCaptureDestroyListenersRestored =
      captureDestroyListeners.captured() && captureDestroyListeners.clean()
    if (startCaptureDestroyOwnershipCalls !== 0 || !startCaptureDestroyListenersRestored) {
      throw new Error("capture destroy rejection changed owner calls or listeners")
    }
  } finally {
    captureDestroyListeners.restore()
    if (captureDestroyFlushDescriptor === undefined)
      Reflect.deleteProperty(captureDestroyLogger, "flush")
    else Object.defineProperty(captureDestroyLogger, "flush", captureDestroyFlushDescriptor)
    destroyIfOpen(captureDestroyDestination)
    await captureDestroyClosed.catch(() => {})
  }

  const captureErrorDestination = pino.destination({
    dest: resolve(directory, "start-capture-error.log"),
    mkdir: true,
    sync: false
  })
  const captureErrorLogger = pino({ base: null, timestamp: false }, captureErrorDestination)
  const captureErrorFlushDescriptor = Object.getOwnPropertyDescriptor(captureErrorLogger, "flush")
  const captureErrorNativeFlush = captureErrorLogger.flush
  const captureError = new Error("capture admission error")
  let captureErrorReads = 0
  const admittedCaptureErrorFlush = function admittedCaptureErrorFlush(
    callback?: (error?: Error) => void
  ): void {
    startCaptureErrorOwnershipCalls += 1
    captureErrorNativeFlush.call(captureErrorLogger, callback)
  }
  Object.defineProperty(captureErrorLogger, "flush", {
    configurable: true,
    value: admittedCaptureErrorFlush,
    writable: true
  })
  const captureErrorServer = newPinoServer(captureErrorLogger, captureErrorDestination)
  const captureErrorListeners = installListenerProbe(captureErrorDestination)
  try {
    await once(captureErrorDestination, "ready")
    Object.defineProperty(captureErrorLogger, "flush", {
      configurable: true,
      get(): typeof admittedCaptureErrorFlush {
        captureErrorReads += 1
        if (captureErrorReads === 4) captureErrorDestination.emit("error", captureError)
        return admittedCaptureErrorFlush
      }
    })
    const outcome = await observeStart(captureErrorServer)
    startCaptureErrorRejected = outcome.error !== null
    startCaptureErrorIdentityPreserved = outcome.error === captureError
    startCaptureErrorListenersRestored =
      captureErrorListeners.captured() && captureErrorListeners.clean()
    if (
      !startCaptureErrorRejected ||
      !startCaptureErrorIdentityPreserved ||
      startCaptureErrorOwnershipCalls !== 0 ||
      !startCaptureErrorListenersRestored ||
      fileDestinationState(captureErrorDestination).destroyed ||
      !fileDestinationState(captureErrorDestination).writable
    ) {
      throw new Error("capture error rejection did not preserve application ownership")
    }
  } finally {
    captureErrorListeners.restore()
    if (captureErrorFlushDescriptor === undefined)
      Reflect.deleteProperty(captureErrorLogger, "flush")
    else Object.defineProperty(captureErrorLogger, "flush", captureErrorFlushDescriptor)
    if (!fileDestinationState(captureErrorDestination).destroyed) {
      const closed = once(captureErrorDestination, "close")
      captureErrorDestination.destroy()
      await closed.catch(() => {})
    }
  }

  const captureCloseDestination = pino.destination({
    dest: resolve(directory, "start-capture-close.log"),
    mkdir: true,
    sync: false
  })
  const captureCloseLogger = pino({ base: null, timestamp: false }, captureCloseDestination)
  const captureCloseFlushDescriptor = Object.getOwnPropertyDescriptor(captureCloseLogger, "flush")
  const captureCloseNativeFlush = captureCloseLogger.flush
  let captureCloseReads = 0
  const admittedCaptureCloseFlush = function admittedCaptureCloseFlush(
    callback?: (error?: Error) => void
  ): void {
    startCaptureCloseOwnershipCalls += 1
    captureCloseNativeFlush.call(captureCloseLogger, callback)
  }
  Object.defineProperty(captureCloseLogger, "flush", {
    configurable: true,
    value: admittedCaptureCloseFlush,
    writable: true
  })
  const captureCloseServer = newPinoServer(captureCloseLogger, captureCloseDestination)
  const captureCloseListeners = installListenerProbe(captureCloseDestination)
  try {
    await once(captureCloseDestination, "ready")
    Object.defineProperty(captureCloseLogger, "flush", {
      configurable: true,
      get(): typeof admittedCaptureCloseFlush {
        captureCloseReads += 1
        if (captureCloseReads === 4) captureCloseDestination.emit("close")
        return admittedCaptureCloseFlush
      }
    })
    const outcome = await observeStart(captureCloseServer)
    if (
      !(outcome.error instanceof Error) ||
      !("code" in outcome.error) ||
      outcome.error.code !== "GO_LIKE_PINO_DESTINATION_CLOSED"
    )
      throw outcome.error
    const state = fileDestinationState(captureCloseDestination)
    startCaptureCloseDestinationOpen = !state.destroyed && state.writable
    startCaptureCloseListenersRestored =
      captureCloseListeners.captured() && captureCloseListeners.clean()
    if (
      startCaptureCloseOwnershipCalls !== 0 ||
      !startCaptureCloseDestinationOpen ||
      !startCaptureCloseListenersRestored
    ) {
      throw new Error("capture close rejection did not preserve application ownership")
    }
  } finally {
    captureCloseListeners.restore()
    if (captureCloseFlushDescriptor === undefined)
      Reflect.deleteProperty(captureCloseLogger, "flush")
    else Object.defineProperty(captureCloseLogger, "flush", captureCloseFlushDescriptor)
    if (!fileDestinationState(captureCloseDestination).destroyed) {
      const closed = once(captureCloseDestination, "close")
      captureCloseDestination.destroy()
      await closed.catch(() => {})
    }
  }

  const ownerPrototypeDestination = pino.destination({
    dest: resolve(directory, "owner-prototype.log"),
    mkdir: true,
    sync: false
  })
  const ownerPrototypeClosed = once(ownerPrototypeDestination, "close")
  const ownerPrototypeLogger = pino({ base: null, timestamp: false }, ownerPrototypeDestination)
  try {
    await once(ownerPrototypeDestination, "ready")
    const server = newPinoServer(
      ownerPrototypeLogger,
      ownerPrototypeDestination,
      pinoDrainTimeout(100)
    )
    const running = server.start(background())
    fileDestinationPrototype.end = function changedAfterOwnership(): void {
      ownerPrototypeReplacementCalls += 1
    }
    const outcome = await observeTerminal(server, running)
    fileDestinationPrototype.end = originalPrototypeEnd
    ownerPrototypeMethodCaptured =
      outcome.stopError === null &&
      outcome.runningError === null &&
      ownerPrototypeReplacementCalls === 0
    if (!ownerPrototypeMethodCaptured) {
      throw new Error("Owner prototype method drift replaced the admitted lifecycle target")
    }
  } finally {
    fileDestinationPrototype.end = originalPrototypeEnd
    destroyIfOpen(ownerPrototypeDestination)
    await ownerPrototypeClosed.catch(() => {})
  }

  const ownerOwnDestination = pino.destination({
    dest: resolve(directory, "owner-own-methods.log"),
    mkdir: true,
    sync: false
  })
  const ownerOwnClosed = once(ownerOwnDestination, "close")
  const ownerOwnLogger = pino({ base: null, timestamp: false }, ownerOwnDestination)
  try {
    await once(ownerOwnDestination, "ready")
    const server = newPinoServer(ownerOwnLogger, ownerOwnDestination, pinoDrainTimeout(100))
    const running = server.start(background())
    Object.defineProperties(ownerOwnDestination, {
      end: {
        configurable: true,
        value: function changedOwnerEnd(): void {
          ownerOwnEndCalls += 1
        },
        writable: true
      },
      destroy: {
        configurable: true,
        value: function changedOwnerDestroy(): void {
          ownerOwnDestroyCalls += 1
        },
        writable: true
      }
    })
    const outcome = await observeTerminal(server, running)
    Reflect.deleteProperty(ownerOwnDestination, "end")
    Reflect.deleteProperty(ownerOwnDestination, "destroy")
    ownerOwnMethodsCaptured =
      outcome.stopError === null &&
      outcome.runningError === null &&
      ownerOwnEndCalls === 0 &&
      ownerOwnDestroyCalls === 0
    if (!ownerOwnMethodsCaptured) {
      throw new Error("Owner own-method drift replaced the admitted lifecycle targets")
    }
  } finally {
    Reflect.deleteProperty(ownerOwnDestination, "end")
    Reflect.deleteProperty(ownerOwnDestination, "destroy")
    destroyIfOpen(ownerOwnDestination)
    await ownerOwnClosed.catch(() => {})
  }

  const ownerLoggerDestination = pino.destination({
    dest: resolve(directory, "owner-logger-method.log"),
    mkdir: true,
    sync: false
  })
  const ownerLoggerClosed = once(ownerLoggerDestination, "close")
  const ownerLogger = pino({ base: null, timestamp: false }, ownerLoggerDestination)
  const ownerLoggerFlushDescriptor = Object.getOwnPropertyDescriptor(ownerLogger, "flush")
  const ownerNativeFlush = ownerLogger.flush.bind(ownerLogger)
  try {
    await once(ownerLoggerDestination, "ready")
    Object.defineProperty(ownerLogger, "flush", {
      configurable: true,
      value: function admittedOwnerFlush(callback?: (error?: Error) => void): void {
        ownerAdmittedFlushCalls += 1
        ownerNativeFlush(callback)
      },
      writable: true
    })
    const server = newPinoServer(ownerLogger, ownerLoggerDestination)
    const running = server.start(background())
    Object.defineProperty(ownerLogger, "flush", {
      configurable: true,
      value: function changedOwnerFlush(): void {
        ownerReplacementFlushCalls += 1
      },
      writable: true
    })
    const outcome = await observeTerminal(server, running)
    ownerLoggerMethodCaptured =
      outcome.stopError === null &&
      outcome.runningError === null &&
      ownerAdmittedFlushCalls === 1 &&
      ownerReplacementFlushCalls === 0
    if (!ownerLoggerMethodCaptured) {
      throw new Error("Owner Logger method drift replaced the admitted flush target")
    }
  } finally {
    if (ownerLoggerFlushDescriptor === undefined) Reflect.deleteProperty(ownerLogger, "flush")
    else Object.defineProperty(ownerLogger, "flush", ownerLoggerFlushDescriptor)
    destroyIfOpen(ownerLoggerDestination)
    await ownerLoggerClosed.catch(() => {})
  }

  const ownerStreamOriginal = pino.destination({
    dest: resolve(directory, "owner-stream-original.log"),
    mkdir: true,
    sync: false
  })
  const ownerStreamReplacement = pino.destination({
    dest: resolve(directory, "owner-stream-replacement.log"),
    mkdir: true,
    sync: false
  })
  const ownerStreamOriginalClose = once(ownerStreamOriginal, "close")
  const ownerStreamReplacementClose = once(ownerStreamReplacement, "close")
  const ownerStreamLogger = pino({ base: null, timestamp: false }, ownerStreamOriginal)
  const ownerStreamDescriptor = Object.getOwnPropertyDescriptor(
    ownerStreamLogger,
    symbols.streamSym
  )
  try {
    await Promise.all([once(ownerStreamOriginal, "ready"), once(ownerStreamReplacement, "ready")])
    const server = newPinoServer(ownerStreamLogger, ownerStreamOriginal)
    const running = server.start(background())
    Object.defineProperty(ownerStreamLogger, symbols.streamSym, {
      configurable: true,
      value: ownerStreamReplacement,
      writable: true
    })
    const outcome = await observeTerminal(server, running)
    const originalState = fileDestinationState(ownerStreamOriginal)
    const replacementState = fileDestinationState(ownerStreamReplacement)
    ownerStreamDriftRejected = outcome.stopError instanceof TypeError
    ownerStreamDriftErrorStable = outcome.runningError === outcome.stopError
    ownerStreamOriginalClosed = originalState.destroyed
    ownerStreamReplacementOpen = !replacementState.destroyed && replacementState.writable
    if (
      !ownerStreamDriftRejected ||
      !ownerStreamDriftErrorStable ||
      !ownerStreamOriginalClosed ||
      !ownerStreamReplacementOpen
    ) {
      throw new Error(
        "Owner Logger stream drift was not rejected after cleaning the transferred destination"
      )
    }
  } finally {
    if (ownerStreamDescriptor !== undefined) {
      Object.defineProperty(ownerStreamLogger, symbols.streamSym, ownerStreamDescriptor)
    }
    destroyIfOpen(ownerStreamOriginal)
    destroyIfOpen(ownerStreamReplacement)
    await Promise.all([
      ownerStreamOriginalClose.catch(() => {}),
      ownerStreamReplacementClose.catch(() => {})
    ])
  }

  const destinationErrorListeners = destination.listenerCount("error")
  const destinationCloseListeners = destination.listenerCount("close")
  const rejectedDestinationServer = newPinoServer(destinationLogger, destination)
  const destinationFlushDescriptor = Object.getOwnPropertyDescriptor(destinationLogger, "flush")
  Object.defineProperty(destinationLogger, "flush", {
    configurable: true,
    value: function observeRejectedFlush(): void {
      destinationPreterminalOwnershipCalls += 1
    },
    writable: true
  })
  try {
    await rejectedDestinationServer.start(background())
    throw new Error("Pino adapter accepted a terminal file destination")
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "GO_LIKE_PINO_DESTINATION_CLOSED"
    )
      throw error
  } finally {
    if (destinationFlushDescriptor === undefined) Reflect.deleteProperty(destinationLogger, "flush")
    else Object.defineProperty(destinationLogger, "flush", destinationFlushDescriptor)
  }
  destinationPreterminalListenersRestored =
    destination.listenerCount("error") === destinationErrorListeners &&
    destination.listenerCount("close") === destinationCloseListeners
  if (destinationPreterminalOwnershipCalls !== 0 || !destinationPreterminalListenersRestored) {
    throw new Error("Rejected file destination changed application ownership or listeners")
  }

  const endingDestinationPath = resolve(directory, "destination-ending.log")
  const endingDestination = pino.destination({
    dest: endingDestinationPath,
    mkdir: true,
    sync: false
  })
  await once(endingDestination, "ready")
  const endingLogger = pino({ base: null, timestamp: false }, endingDestination)
  endingDestination.write("x".repeat(16 * 1024 * 1024))
  const endingClosed = once(endingDestination, "close")
  const applicationEnd = endingDestination.end.bind(endingDestination)
  applicationEnd()
  const endingServer = newPinoServer(endingLogger, endingDestination)
  const endingState = fileDestinationState(endingDestination)
  if (endingState.destroyed || !endingState.writable) {
    throw new Error("Pino file destination did not expose the reviewed end-in-progress state")
  }
  const endingErrorListeners = endingDestination.listenerCount("error")
  const endingCloseListeners = endingDestination.listenerCount("close")
  const endingFlushDescriptor = Object.getOwnPropertyDescriptor(endingLogger, "flush")
  Object.defineProperty(endingLogger, "flush", {
    configurable: true,
    value: function observeEndingWindowFlush(): void {
      destinationEndingWindowOwnershipCalls += 1
    },
    writable: true
  })
  const endingOutcome = await observeStart(endingServer)
  if (endingFlushDescriptor === undefined) Reflect.deleteProperty(endingLogger, "flush")
  else Object.defineProperty(endingLogger, "flush", endingFlushDescriptor)
  if (
    !(endingOutcome.error instanceof Error) ||
    !("code" in endingOutcome.error) ||
    endingOutcome.error.code !== "GO_LIKE_PINO_DESTINATION_CLOSED"
  ) {
    throw endingOutcome.error
  }
  destinationEndingWindowListenersRestored =
    endingDestination.listenerCount("error") === endingErrorListeners &&
    endingDestination.listenerCount("close") === endingCloseListeners
  if (destinationEndingWindowOwnershipCalls !== 0 || !destinationEndingWindowListenersRestored) {
    throw new Error("Rejected ending file destination changed application ownership or listeners")
  }
  await endingClosed

  const transportPath = resolve(directory, "transport.log")
  const transport = pino.transport({
    target: "pino/file",
    options: { destination: transportPath, mkdir: true }
  })
  transport.once("close", function observeTransportClose(): void {
    transportCloseObserved = true
  })
  const transportLogger = pino({ base: null, timestamp: false }, transport)
  const transportServer = newPinoServer(transportLogger, transport)
  const transportRunning = transportServer.start(background())
  transportLogger.info({ component: "thread" }, "native transport")
  await transportServer.stop(background())
  await transportRunning
  if (!transportCloseObserved) throw new Error("Pino transport runtime settled before native close")
  const transportLines = (await readFile(transportPath, "utf8")).trim().split("\n")
  transportFileLanded = transportLines.length === 1
  const transportRecord = JSON.parse(transportLines[0] ?? "null") as Readonly<
    Record<string, unknown>
  >
  transportComponent = transportRecord.component
  if (!transportFileLanded || transportComponent !== "thread") {
    throw new Error("Pino native transport record changed")
  }
  const transportErrorListeners = transport.listenerCount("error")
  const transportCloseListeners = transport.listenerCount("close")
  const nativeTransportEnd = transport.end.bind(transport)
  transport.end = function observeRejectedTransportEnd(): void {
    transportPreterminalOwnershipCalls += 1
    nativeTransportEnd()
  }
  try {
    await newPinoServer(transportLogger, transport).start(background())
    throw new Error("Pino adapter accepted a terminal ThreadStream transport")
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "GO_LIKE_PINO_DESTINATION_CLOSED"
    )
      throw error
  }
  transportPreterminalListenersRestored =
    transport.listenerCount("error") === transportErrorListeners &&
    transport.listenerCount("close") === transportCloseListeners
  if (transportPreterminalOwnershipCalls !== 0 || !transportPreterminalListenersRestored) {
    throw new Error("Rejected ThreadStream transport changed application ownership or listeners")
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

const directoryRemoved = await removed(directory)
if (!directoryRemoved) throw new Error("Pino E2E temporary directory remained after cleanup")
