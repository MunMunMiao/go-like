import type { Channel, ConfirmChannel, ConsumeMessage, Options, Replies } from "amqplib"
import { Buffer } from "node:buffer"

export interface FakeChannel {
  readonly native: Channel
  readonly calls: {
    publish: unknown[][]
    assertExchange: unknown[][]
    prefetch: unknown[][]
    assertQueue: unknown[][]
    bindQueue: unknown[][]
    consume: unknown[][]
    cancel: string[]
    ack: ConsumeMessage[]
    nack: unknown[][]
    reject: unknown[][]
    close: number
  }
  publishResult: boolean
  consumeTag: string
  cancelFailure: unknown
  onMessage: ((message: ConsumeMessage | null) => void) | null
}

export interface FakeConfirmChannel extends Omit<FakeChannel, "native"> {
  readonly native: ConfirmChannel
  readonly closeFailure: Error
  readonly pendingConfirms: number
  confirm(index: number, error?: unknown): void
}

/** Creates a complete-enough amqplib Channel fake without emulating provider semantics. */
export function fakeChannel(): FakeChannel {
  const calls = {
    publish: [] as unknown[][],
    assertExchange: [] as unknown[][],
    prefetch: [] as unknown[][],
    assertQueue: [] as unknown[][],
    bindQueue: [] as unknown[][],
    consume: [] as unknown[][],
    cancel: [] as string[],
    ack: [] as ConsumeMessage[],
    nack: [] as unknown[][],
    reject: [] as unknown[][],
    close: 0
  }
  const state: {
    publishResult: boolean
    consumeTag: string
    cancelFailure: unknown
    onMessage: ((message: ConsumeMessage | null) => void) | null
  } = {
    publishResult: true,
    consumeTag: "consumer-1",
    cancelFailure: null,
    onMessage: null
  }
  const native = {
    publish(exchange: string, routingKey: string, body: Buffer, options: Options.Publish) {
      calls.publish.push([exchange, routingKey, body, options])
      body[0] = 99
      return state.publishResult
    },
    async assertExchange(name: string, type: string, options?: Options.AssertExchange) {
      calls.assertExchange.push([name, type, options])
      return { exchange: name }
    },
    async prefetch(count: number, global?: boolean) {
      calls.prefetch.push([count, global])
      return {}
    },
    async assertQueue(name?: string, options?: Options.AssertQueue) {
      calls.assertQueue.push([name, options])
      return {
        queue: name === "" || name === undefined ? "generated-queue" : name,
        messageCount: 0,
        consumerCount: 0
      }
    },
    async bindQueue(queue: string, exchange: string, routingKey: string, args?: unknown) {
      calls.bindQueue.push([queue, exchange, routingKey, args])
      return {}
    },
    async consume(
      queue: string,
      callback: (message: ConsumeMessage | null) => void,
      options?: Options.Consume
    ): Promise<Replies.Consume> {
      calls.consume.push([queue, options])
      state.onMessage = callback
      return { consumerTag: state.consumeTag }
    },
    async cancel(consumerTag: string) {
      calls.cancel.push(consumerTag)
      if (state.cancelFailure !== null) throw state.cancelFailure
      return {}
    },
    ack(message: ConsumeMessage) {
      calls.ack.push(message)
    },
    nack(message: ConsumeMessage, allUpTo?: boolean, requeue?: boolean) {
      calls.nack.push([message, allUpTo, requeue])
    },
    reject(message: ConsumeMessage, requeue?: boolean) {
      calls.reject.push([message, requeue])
    },
    async close() {
      calls.close += 1
    }
  } as unknown as Channel
  return {
    native,
    calls,
    get publishResult() {
      return state.publishResult
    },
    set publishResult(value: boolean) {
      state.publishResult = value
    },
    get consumeTag() {
      return state.consumeTag
    },
    set consumeTag(value: string) {
      state.consumeTag = value
    },
    get cancelFailure() {
      return state.cancelFailure
    },
    set cancelFailure(value: unknown) {
      state.cancelFailure = value
    },
    get onMessage() {
      return state.onMessage
    },
    set onMessage(value: ((message: ConsumeMessage | null) => void) | null) {
      state.onMessage = value
    }
  }
}

/** Creates a controllable ConfirmChannel fake using amqplib's per-publish callbacks. */
export function fakeConfirmChannel(): FakeConfirmChannel {
  const channel = fakeChannel()
  const callbacks: Array<((error: unknown, ok: Replies.Empty) => void) | null> = []
  const closeFailure = new Error("channel closed")
  const native = channel.native as ConfirmChannel
  native.publish = (exchange, routingKey, body, options, callback) => {
    channel.calls.publish.push([exchange, routingKey, body, options])
    body[0] = 99
    if (callback !== undefined) callbacks.push(callback)
    return channel.publishResult
  }
  native.waitForConfirms = async () => {}
  native.close = async () => {
    channel.calls.close += 1
    for (const callback of callbacks) callback?.(closeFailure, {})
    callbacks.fill(null)
  }
  return {
    native,
    calls: channel.calls,
    closeFailure,
    get pendingConfirms() {
      return callbacks.filter((callback) => callback !== null).length
    },
    get publishResult() {
      return channel.publishResult
    },
    set publishResult(value: boolean) {
      channel.publishResult = value
    },
    get consumeTag() {
      return channel.consumeTag
    },
    set consumeTag(value: string) {
      channel.consumeTag = value
    },
    get cancelFailure() {
      return channel.cancelFailure
    },
    set cancelFailure(value: unknown) {
      channel.cancelFailure = value
    },
    get onMessage() {
      return channel.onMessage
    },
    set onMessage(value: ((message: ConsumeMessage | null) => void) | null) {
      channel.onMessage = value
    },
    confirm(index: number, error: unknown = null): void {
      const callback = callbacks[index]
      if (callback === undefined || callback === null) {
        throw new Error(`missing publisher confirm callback ${index}`)
      }
      callbacks[index] = null
      callback(error, {})
    }
  }
}

/** Creates one exact native amqplib delivery for provider tests. */
export function delivery(
  routingKey: string,
  bytes: readonly number[],
  headers: Record<string, unknown> = {}
): ConsumeMessage {
  return {
    content: Buffer.from(bytes),
    fields: {
      consumerTag: "consumer-1",
      deliveryTag: 1,
      redelivered: false,
      exchange: "events",
      routingKey
    },
    properties: {
      contentType: undefined,
      contentEncoding: undefined,
      headers,
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  }
}

/** Lets callback Promise continuations settle. */
export async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
