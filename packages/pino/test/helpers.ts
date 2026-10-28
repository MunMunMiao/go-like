import { EventEmitter } from "node:events"

import { symbols, type Logger } from "pino"

import { newPinoServer } from "../src/index"
import type { DestinationLifecycle, LoggerFlushLifecycle } from "../src/types"
import type { PinoServer, PinoServerOption } from "../src/types"

interface ThreadStreamTestLifecycle extends DestinationLifecycle {
  readonly destroyed: boolean
  readonly closed: boolean
  readonly writable: boolean
  readonly writableEnded: boolean
  readonly writableFinished: boolean
  readonly writableErrored: unknown
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("missing resolver")
  }
  let rejectPromise: (error: unknown) => void = () => {
    throw new Error("missing rejecter")
  }
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

export function delay(timeoutMs = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs)
  })
}

export class FakeLogger implements LoggerFlushLifecycle {
  flushCalls = 0
  flushError: Error | null = null
  flushThrown: unknown = null
  autoFlush = true
  synchronousFlush = false
  blockForMs = 0
  callback: ((error?: Error) => void) | null = null

  flush(callback?: (error?: Error) => void): void {
    this.flushCalls += 1
    if (this.flushThrown !== null) throw this.flushThrown
    const startedAt = performance.now()
    while (performance.now() - startedAt < this.blockForMs) {}
    if (callback === undefined) return
    if (this.synchronousFlush) callback(this.flushError ?? undefined)
    else if (this.autoFlush)
      queueMicrotask(() => {
        callback(this.flushError ?? undefined)
      })
    else this.callback = callback
  }

  official(destination: DestinationLifecycle): Logger {
    Object.defineProperty(this, symbols.streamSym, {
      configurable: true,
      value: destination
    })
    return this as unknown as Logger
  }
}

export class FakeDestination extends EventEmitter implements DestinationLifecycle {
  _ending = false
  ready = false
  closed = false
  destroyed = false
  writable = true
  writableEnded = false
  writableFinished = false
  writableErrored: unknown = null
  endCalls = 0
  destroyCalls = 0
  autoClose = true
  endThrown: unknown = null
  destroyThrown: unknown = null
  readonly lines: string[] = []

  constructor() {
    super()
    Object.defineProperties(this, {
      write: { configurable: true, value: this.write.bind(this), writable: true },
      flush: { configurable: true, value: this.flush.bind(this), writable: true },
      reopen: { configurable: true, value: this.reopen.bind(this), writable: true },
      flushSync: { configurable: true, value: this.flushSync.bind(this), writable: true },
      end: { configurable: true, value: this.end.bind(this), writable: true },
      destroy: { configurable: true, value: this.destroy.bind(this), writable: true },
      markReady: { configurable: true, value: this.markReady.bind(this), writable: true },
      fail: { configurable: true, value: this.fail.bind(this), writable: true },
      close: { configurable: true, value: this.close.bind(this), writable: true }
    })
  }

  write(line: string): boolean {
    this.lines.push(line)
    return true
  }

  flush(callback?: (error?: Error) => unknown): void {
    callback?.()
  }

  reopen(): void {}

  flushSync(): void {}

  end(): void {
    this.endCalls += 1
    if (this.endThrown !== null) throw this.endThrown
    this._ending = true
    this.writable = false
    this.writableEnded = true
    if (this.autoClose)
      queueMicrotask(() => {
        this.close()
      })
  }

  destroy(): void {
    this.destroyCalls += 1
    if (this.destroyThrown !== null) throw this.destroyThrown
    this._ending = true
    this.destroyed = true
    this.writable = false
    this.writableEnded = true
    queueMicrotask(() => {
      this.close()
    })
  }

  markReady(): void {
    this.ready = true
    this.emit("ready")
  }

  fail(error: unknown): void {
    this.writableErrored = error
    this.emit("error", error)
  }

  close(): void {
    if (this.closed) return
    this._ending = true
    this.closed = true
    this.destroyed = true
    this.writable = false
    this.writableEnded = true
    this.writableFinished = true
    this.emit("close")
  }
}

export function withoutForce(
  subject: FakeDestination
): ReturnType<typeof import("pino").transport> {
  const destination: ThreadStreamTestLifecycle = {
    get destroyed(): boolean {
      return subject.destroyed
    },
    get closed(): boolean {
      return subject.closed
    },
    get writable(): boolean {
      return subject.writable
    },
    get writableEnded(): boolean {
      return subject.writableEnded
    },
    get writableFinished(): boolean {
      return subject.writableFinished
    },
    get writableErrored(): unknown {
      return subject.writableErrored
    },
    end(): void {
      subject.end()
    },
    once(event, listener) {
      subject.once(event, listener)
      return this
    },
    on(event, listener) {
      subject.on(event, listener)
      return this
    },
    removeListener(event, listener) {
      subject.removeListener(event, listener)
      return this
    }
  }
  return destination as unknown as ReturnType<typeof import("pino").transport>
}

/** Constructs a deterministic structural Pino destination for lifecycle tests. */
export function fakePinoServer(
  logger: Logger,
  destination: FakeDestination | ReturnType<typeof import("pino").transport>,
  ...options: readonly PinoServerOption[]
): PinoServer {
  return newPinoServer(logger, destination, ...options)
}
