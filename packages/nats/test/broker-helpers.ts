import type { ConsumerMessages, ConsumerNotification, JsMsg } from "@nats-io/jetstream"
import { headers, type Msg, type PublishOptions, type Subscription } from "@nats-io/transport-node"

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly values: T[] = []
  readonly waiters: Array<Deferred<IteratorResult<T>>> = []
  ended = false;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    const waiter = deferred<IteratorResult<T>>()
    this.waiters.push(waiter)
    return waiter.promise
  }

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ done: false, value })
  }

  finish(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined })
    }
  }

  fail(reason: unknown): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason)
  }
}

export class FakeSubscription implements Subscription {
  readonly queue = new AsyncQueue<Msg>()
  readonly terminal = deferred<void | Error>()
  readonly closed = this.terminal.promise
  callback = () => {}
  drainCalls = 0
  unsubscribeCalls = 0
  closedFlag = false;

  [Symbol.asyncIterator](): AsyncIterator<Msg> {
    return this.queue[Symbol.asyncIterator]()
  }

  push(message: Msg): void {
    this.queue.push(message)
  }

  finish(reason?: Error): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.queue.finish()
    this.terminal.resolve(reason)
  }

  failIterator(reason: unknown): void {
    this.queue.fail(reason)
  }

  unsubscribe(): void {
    this.unsubscribeCalls += 1
    this.finish()
  }

  async drain(): Promise<void> {
    this.drainCalls += 1
    this.finish()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.drain()
  }

  isDraining(): boolean {
    return this.drainCalls > 0
  }

  isClosed(): boolean {
    return this.closedFlag
  }

  getSubject(): string {
    return "events"
  }

  getReceived(): number {
    return 0
  }

  getProcessed(): number {
    return 0
  }

  getPending(): number {
    return 0
  }

  getID(): number {
    return 1
  }

  getMax(): number | undefined {
    return undefined
  }
}

export class FakeConsumerMessages implements ConsumerMessages {
  readonly queue = new AsyncQueue<JsMsg>()
  readonly terminal = deferred<void | Error>()
  closeCalls = 0
  stopCalls = 0
  closedFlag = false;

  [Symbol.asyncIterator](): AsyncIterator<JsMsg> {
    return this.queue[Symbol.asyncIterator]()
  }

  push(message: JsMsg): void {
    this.queue.push(message)
  }

  finish(reason?: Error): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.queue.finish()
    this.terminal.resolve(reason)
  }

  failIterator(reason: unknown): void {
    this.queue.fail(reason)
  }

  close(): Promise<void | Error> {
    this.closeCalls += 1
    this.finish()
    return this.terminal.promise
  }

  closed(): Promise<void | Error> {
    return this.terminal.promise
  }

  stop(_reason?: Error): void {
    this.stopCalls += 1
    this.finish()
  }

  getProcessed(): number {
    return 0
  }

  getPending(): number {
    return 0
  }

  getReceived(): number {
    return 0
  }

  status(): AsyncIterable<ConsumerNotification> {
    return { async *[Symbol.asyncIterator]() {} }
  }
}

export function coreMessage(subject: string, body: readonly number[], values = ["one"]): Msg {
  const nativeHeaders = headers()
  for (const value of values) nativeHeaders.append("x-test", value)
  const data = new Uint8Array(body)
  return {
    subject,
    sid: 1,
    data,
    headers: nativeHeaders,
    respond: (_payload?: Uint8Array | string, _options?: PublishOptions) => false,
    json: <T>() => JSON.parse(new TextDecoder().decode(data)) as T,
    string: () => new TextDecoder().decode(data)
  }
}

export function jetStreamMessage(
  subject: string,
  body: readonly number[],
  settlement: { ack: number; nak: number; term: number }
): JsMsg {
  const message = coreMessage(subject, body)
  return {
    ...message,
    redelivered: false,
    info: {},
    seq: 1,
    time: new Date(0),
    timestamp: new Date(0).toISOString(),
    timestampNanos: 0n,
    ack() {
      settlement.ack += 1
    },
    nak() {
      settlement.nak += 1
    },
    working() {},
    next() {},
    term() {
      settlement.term += 1
    },
    async ackAck() {
      settlement.ack += 1
      return true
    }
  } as unknown as JsMsg
}

export async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
