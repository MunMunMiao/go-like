import { EventEmitter } from "node:events"

import type { Logger } from "winston"

/** Allows pending event and Promise callbacks to advance without using wall-clock sleeps. */
export async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

/** Controllable native Winston lifecycle used only for failure-boundary tests. */
export class FakeLogger extends EventEmitter {
  endCalls = 0
  autoFinish = true
  endThrown: unknown = null
  finished = false
  closed = false
  readonly retainedFinishListeners: (() => void)[] = []
  readonly retainedCloseListeners: (() => void)[] = []

  /** Retains native lifecycle callbacks to model hostile external callback ownership. */
  override once(eventName: string | symbol, listener: Parameters<EventEmitter["once"]>[1]): this {
    if (eventName === "finish") {
      this.retainedFinishListeners.push(function retainedFinish(): void {
        listener()
      })
    }
    if (eventName === "close") {
      this.retainedCloseListeners.push(function retainedClose(): void {
        listener()
      })
    }
    return super.once(eventName, listener)
  }

  /** Invokes one callback retained before the adapter removed its EventEmitter listener. */
  invokeRetained(eventName: "finish" | "close"): void {
    const listeners =
      eventName === "finish" ? this.retainedFinishListeners : this.retainedCloseListeners
    const listener = listeners[0]
    if (listener === undefined) throw new Error(`missing retained ${eventName} listener`)
    listener()
  }

  /** Mirrors the official Node Writable terminal property. */
  get writableFinished(): boolean {
    return this.finished
  }

  /** Exposes this test double through Winston's unmodified public Logger type. */
  official(): Logger {
    return this as unknown as Logger
  }

  /** Simulates the official writable-stream end operation. */
  end(): this {
    this.endCalls += 1
    if (this.endThrown !== null) throw this.endThrown
    if (this.autoFinish)
      queueMicrotask(() => {
        this.finish()
      })
    return this
  }

  /** Emits one native logger error. */
  fail(value: unknown): void {
    this.emit("error", value)
  }

  /** Emits the official all-transports-flushed terminal event once. */
  finish(): void {
    if (this.finished) return
    this.finished = true
    this.emit("finish")
  }

  /** Emits the separate native logger close event once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit("close")
  }
}
