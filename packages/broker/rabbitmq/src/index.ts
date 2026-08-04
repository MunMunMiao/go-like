import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import { registerSubscriberTerminal, subscriberTerminal } from "@go-like/broker/provider"
import { background, cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import type {
  Channel,
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Options,
  RecoveringChannelModel
} from "amqplib"
import { Buffer } from "node:buffer"

/** Publish properties supported by amqplib, with headers reserved for BrokerMessage. */
export interface RabbitMqPublishProperties {
  readonly expiration?: string | number
  readonly userId?: string
  readonly CC?: string | readonly string[]
  readonly mandatory?: boolean
  readonly persistent?: boolean
  readonly deliveryMode?: boolean | number
  readonly BCC?: string | readonly string[]
  readonly contentType?: string
  readonly contentEncoding?: string
  readonly priority?: number
  readonly correlationId?: string
  readonly replyTo?: string
  readonly messageId?: string
  readonly timestamp?: number
  readonly type?: string
  readonly appId?: string
}

/** Selects the native publish exchange, routing key, and message properties. */
export interface RabbitMqPublishOptions {
  readonly exchange?: string
  readonly routingKey?: string
  readonly properties?: RabbitMqPublishProperties
}

/** Declares and binds one native RabbitMQ exchange during subscription setup. */
export interface RabbitMqExchange {
  readonly name: string
  readonly type: string
  readonly options?: Options.AssertExchange
  readonly bindingArguments?: unknown
}

/** Declares the native queue consumed by one subscription. */
export interface RabbitMqQueue {
  readonly name?: string
  readonly options?: Options.AssertQueue
}

/** Applies native channel QoS before one consumer is created. */
export interface RabbitMqPrefetch {
  readonly count: number
  readonly global?: boolean
}

/** Selects RabbitMQ topology, routing, QoS, and native consumer options. */
export interface RabbitMqSubscribeOptions {
  readonly exchange?: RabbitMqExchange
  readonly queue?: RabbitMqQueue
  readonly routingKey?: string
  readonly prefetch?: RabbitMqPrefetch
  readonly consume?: Options.Consume
}

/** Implements go-like Broker while preserving the exact amqplib delivery object. */
export interface RabbitMqBroker extends Broker<
  RabbitMqPublishOptions,
  boolean,
  RabbitMqSubscribeOptions,
  ConsumeMessage
> {
  /** Acknowledges one exact native delivery on its owning channel generation. */
  ack(native: ConsumeMessage, allUpTo?: boolean): void
  /** Negatively acknowledges one exact native delivery on its owning channel generation. */
  nack(native: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void
  /** Rejects one exact native delivery on its owning channel generation. */
  reject(native: ConsumeMessage, requeue?: boolean): void
  string(): "rabbitmq"
}

/** Rebuilds package-owned channels through amqplib's official recovery setup hook. */
export type RabbitMqRecoveryConnector = (
  setup: (model: ChannelModel) => Promise<void>
) => PromiseLike<RecoveringChannelModel>

/** Returns one stable Broker and its application-owned recovering connection. */
export interface RecoveringRabbitMqBroker {
  readonly broker: RabbitMqBroker
  readonly connection: RecoveringChannelModel
}

interface PreparedMessage {
  readonly body: Buffer
  readonly headers: Readonly<Record<string, string>>
}

type RabbitMqPublishBoundary = (
  ctx: Context,
  exchange: string,
  routingKey: string,
  body: Buffer,
  properties: Options.Publish
) => boolean | PromiseLike<boolean>

interface ConsumerState {
  readonly topic: string
  readonly context: Context
  readonly handler: (ctx: Context, event: BrokerEvent<ConsumeMessage>) => void | PromiseLike<void>
  consumerTag: string
  consumerGeneration: number
  accepting: boolean
  failure: Error | null
  recovering: Promise<void> | null
  recoveryRequested: boolean
  readonly recoveryStop: AbortController
  tail: Promise<void>
  stopping: Promise<void> | null
  settle(error: Error | null): void
}

interface RecoveringSubscription {
  readonly topic: string
  readonly context: Context
  readonly handler: (ctx: Context, event: BrokerEvent<ConsumeMessage>) => void | PromiseLike<void>
  readonly options: RabbitMqSubscribeOptions | undefined
  stopped: boolean
  native: Subscriber | null
  nativeGeneration: number
  attaching: Promise<void> | null
  attachingGeneration: number
  stopping: Promise<void> | null
  settle(error: Error | null): void
}

interface SettlementBinding {
  readonly broker: RabbitMqBroker
  readonly generation: number
}

const rabbitMqRecoveryAttempts = 6
const rabbitMqRecoveryInitialDelayMs = 25
const rabbitMqRecoveryMaximumDelayMs = 400

/** Returns the exact cancellation carried by one terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Reports whether one string contains no unmatched UTF-16 surrogate code units. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Validates one portable non-empty topic before native I/O. */
function validateTopic(topic: string): void {
  if (typeof topic !== "string" || topic.length === 0 || !isWellFormed(topic)) {
    throw new TypeError("RabbitMQ Broker topic must be a non-empty well-formed string")
  }
}

/** Validates one native routing component while allowing RabbitMQ's empty routing key. */
function validateRoutingValue(label: string, value: string): void {
  if (typeof value !== "string" || !isWellFormed(value)) {
    throw new TypeError(`RabbitMQ Broker ${label} must be a well-formed string`)
  }
}

/** Defines one immutable portable header without prototype mutation. */
function defineHeader(target: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  })
}

/** Validates and detaches portable message data before native publish. */
function prepareMessage(message: BrokerMessage): PreparedMessage {
  if (typeof message !== "object" || message === null) {
    throw new TypeError("RabbitMQ Broker message must be an object")
  }
  if (!(message.body instanceof Uint8Array)) {
    throw new TypeError("RabbitMQ Broker message body must be Uint8Array")
  }
  if (
    typeof message.headers !== "object" ||
    message.headers === null ||
    Array.isArray(message.headers)
  ) {
    throw new TypeError("RabbitMQ Broker message headers must be an object")
  }
  const headers: Record<string, string> = {}
  for (const name of Object.keys(message.headers)) {
    const value = message.headers[name]
    if (
      name.length === 0 ||
      !isWellFormed(name) ||
      typeof value !== "string" ||
      !isWellFormed(value)
    ) {
      throw new TypeError("RabbitMQ Broker message headers must contain well-formed strings")
    }
    defineHeader(headers, name, value)
  }
  return Object.freeze({
    body: Buffer.from(message.body),
    headers: Object.freeze(headers)
  })
}

/** Detaches one AMQP recipient property without widening readonly input arrays. */
function publishRecipients(
  recipients: string | readonly string[] | undefined
): string | string[] | undefined {
  if (typeof recipients === "string" || recipients === undefined) return recipients
  const result: string[] = []
  for (const recipient of recipients) result.push(recipient)
  return result
}

/** Copies all supported native message properties and installs portable headers. */
function publishProperties(
  headers: Readonly<Record<string, string>>,
  properties: RabbitMqPublishProperties | undefined
): Options.Publish {
  const result: Options.Publish = { headers }
  if (properties === undefined) return result
  if (properties.expiration !== undefined) result.expiration = properties.expiration
  if (properties.userId !== undefined) result.userId = properties.userId
  const CC = publishRecipients(properties.CC)
  if (CC !== undefined) result.CC = CC
  if (properties.mandatory !== undefined) result.mandatory = properties.mandatory
  if (properties.persistent !== undefined) result.persistent = properties.persistent
  if (properties.deliveryMode !== undefined) result.deliveryMode = properties.deliveryMode
  const BCC = publishRecipients(properties.BCC)
  if (BCC !== undefined) result.BCC = BCC
  if (properties.contentType !== undefined) result.contentType = properties.contentType
  if (properties.contentEncoding !== undefined) {
    result.contentEncoding = properties.contentEncoding
  }
  if (properties.priority !== undefined) result.priority = properties.priority
  if (properties.correlationId !== undefined) result.correlationId = properties.correlationId
  if (properties.replyTo !== undefined) result.replyTo = properties.replyTo
  if (properties.messageId !== undefined) result.messageId = properties.messageId
  if (properties.timestamp !== undefined) result.timestamp = properties.timestamp
  if (properties.type !== undefined) result.type = properties.type
  if (properties.appId !== undefined) result.appId = properties.appId
  return result
}

/** Copies string-valued AMQP headers into the portable single-value view. */
function portableHeaders(native: ConsumeMessage): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  const source: unknown = native.properties.headers
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    for (const name of Object.keys(source)) {
      const value: unknown = Reflect.get(source, name)
      if (name.length > 0 && isWellFormed(name) && typeof value === "string") {
        defineHeader(result, name, value)
      }
    }
  }
  return Object.freeze(result)
}

/** Converts one native delivery without hiding its acknowledgement identity. */
function brokerEvent(native: ConsumeMessage): BrokerEvent<ConsumeMessage> {
  const body = new Uint8Array(native.content)
  const message = Object.freeze({
    headers: portableHeaders(native),
    /** Returns fresh bytes so portable handlers cannot mutate the native delivery. */
    get body(): Uint8Array {
      return new Uint8Array(body)
    }
  })
  return Object.freeze({
    topic: native.fields.routingKey,
    message,
    native
  })
}

/** Preserves Error identity while normalizing invalid rejection values. */
function normalizeError(operation: string, value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(`RabbitMQ Broker ${operation} rejected with a non-Error value`, {
    cause: value
  })
}

/** Combines independent failures without replacing the only exact error. */
function combinedFailure(failures: readonly Error[]): Error | null {
  const first = failures[0]
  if (first === undefined) return null
  if (failures.length === 1) return first
  return new AggregateError(failures, "RabbitMQ Broker delivery or unsubscribe failed", {
    cause: first
  })
}

/** Deliberately observes a retained internal rejection. */
function consumeFailure(_value: unknown): void {}

/** Waits one recovery delay while allowing owner stop to release it immediately. */
function waitForRecoveryDelay(ctx: Context, stop: AbortSignal, delayMs: number): Promise<void> {
  if (stop.aborted) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  let listening = true
  const pending = new Promise<void>((resolve) => {
    /** Releases the timer and stop listener exactly once. */
    const finish = (): void => {
      if (!listening) return
      listening = false
      if (timer !== null) clearTimeout(timer)
      stop.removeEventListener("abort", finish)
      resolve()
    }
    stop.addEventListener("abort", finish, { once: true })
    timer = setTimeout(finish, delayMs)
  })
  return waitForContext(ctx, pending)
}

/** Describes exhaustion of the bounded same-channel consumer recovery loop. */
function recoveryFailure(cause: Error): Error {
  const failure = new Error(
    `RabbitMQ Broker consumer recovery failed after ${rabbitMqRecoveryAttempts} attempts`,
    { cause }
  )
  failure.name = "RabbitMqConsumerRecoveryError"
  return failure
}

/** Rejects malformed borrowed channels before provider construction. */
function validateChannel(channel: Channel): void {
  if (
    typeof channel !== "object" ||
    channel === null ||
    typeof channel.publish !== "function" ||
    typeof channel.consume !== "function" ||
    typeof channel.cancel !== "function"
  ) {
    throw new TypeError("RabbitMQ Broker channel must be an amqplib Channel")
  }
}

/** Creates a Broker over one borrowed plain channel with flow-control-only publish completion. */
export function newRabbitMqBroker(channel: Channel): RabbitMqBroker {
  validateChannel(channel)
  return createRabbitMqBroker(channel, (_ctx, exchange, routingKey, body, properties) =>
    channel.publish(exchange, routingKey, body, properties)
  )
}

/** Creates a Broker whose publish waits for the exact borrowed ConfirmChannel callback. */
export function newConfirmRabbitMqBroker(channel: ConfirmChannel): RabbitMqBroker {
  validateChannel(channel)
  if (typeof channel.waitForConfirms !== "function") {
    throw new TypeError("RabbitMQ Broker channel must be an amqplib ConfirmChannel")
  }
  return createRabbitMqBroker(channel, (ctx, exchange, routingKey, body, properties) => {
    let accepted = false
    const confirmation = new Promise<void>((resolve, reject) => {
      accepted = channel.publish(exchange, routingKey, body, properties, (error: unknown) => {
        if (error === null || error === undefined) resolve()
        else reject(normalizeError("publisher confirm", error))
      })
    })
    return waitForContext(ctx, confirmation).then(() => accepted)
  })
}

/** Creates the shared Broker surface over one selected native publish boundary. */
function createRabbitMqBroker(
  channel: Channel,
  publishNative: RabbitMqPublishBoundary
): RabbitMqBroker {
  /** Starts or joins exact-consumer cancellation and handler drain. */
  function beginStop(state: ConsumerState): Promise<void> {
    if (state.stopping !== null) return state.stopping
    state.accepting = false
    state.recoveryStop.abort()
    const operation = Promise.resolve().then(async () => {
      const failures: Error[] = []
      if (state.recovering !== null) await state.recovering
      const consumerTag = state.consumerTag
      state.consumerTag = ""
      if (consumerTag.length > 0) {
        try {
          await channel.cancel(consumerTag)
        } catch (value) {
          failures.push(normalizeError("cancel", value))
        }
      }
      try {
        await state.tail
      } catch (value) {
        failures.push(normalizeError("handler", value))
      }
      if (state.failure !== null && !failures.includes(state.failure)) {
        failures.push(state.failure)
      }
      const failure = combinedFailure(failures)
      if (failure !== null) throw failure
    })
    state.stopping = operation
    void operation.catch(consumeFailure)
    void operation.then(
      () => state.settle(null),
      (value: unknown) => state.settle(normalizeError("unsubscribe", value))
    )
    return operation
  }

  /** Admits one native delivery to the subscription's serial handler tail. */
  function admit(state: ConsumerState, native: ConsumeMessage): void {
    if (!state.accepting) return
    const delivery = state.tail.then(async () => {
      await state.handler(state.context, brokerEvent(native))
    })
    state.tail = delivery.catch((value: unknown) => {
      const failure = normalizeError("handler", value)
      state.failure = failure
      state.accepting = false
      void beginStop(state)
      throw failure
    })
    void state.tail.catch(consumeFailure)
  }

  return Object.freeze({
    /** Publishes detached bytes and reports amqplib's native flow-control boolean. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: RabbitMqPublishOptions
    ): Promise<boolean> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      validateTopic(topic)
      const exchange = options?.exchange ?? ""
      const routingKey = options?.routingKey ?? topic
      validateRoutingValue("exchange", exchange)
      validateRoutingValue("routing key", routingKey)
      const prepared = prepareMessage(message)
      return publishNative(
        ctx,
        exchange,
        routingKey,
        prepared.body,
        publishProperties(prepared.headers, options?.properties)
      )
    },
    /** Declares native topology and owns only the resulting RabbitMQ consumer. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<ConsumeMessage>) => void | PromiseLike<void>,
      options?: RabbitMqSubscribeOptions
    ): Promise<Subscriber> {
      const initialFailure = contextFailure(ctx)
      if (initialFailure !== null) throw initialFailure
      validateTopic(topic)
      if (typeof handler !== "function") {
        throw new TypeError("RabbitMQ Broker handler must be callable")
      }
      const exchange = options?.exchange
      const routingKey = options?.routingKey ?? topic
      validateRoutingValue("routing key", routingKey)
      if (exchange !== undefined) {
        validateTopic(exchange.name)
        validateTopic(exchange.type)
      }
      const requestedQueue = options?.queue?.name ?? (exchange === undefined ? topic : "")
      validateRoutingValue("queue", requestedQueue)
      const queueOptions =
        requestedQueue === "" && options?.queue?.options === undefined
          ? { durable: false, exclusive: true, autoDelete: true }
          : options?.queue?.options

      let settleTerminal: ((error: Error | null) => void) | null = null
      const terminal = new Promise<void>((resolve, reject) => {
        settleTerminal = (error) => {
          settleTerminal = null
          if (error === null) resolve()
          else reject(error)
        }
      })
      void terminal.catch(consumeFailure)
      const state: ConsumerState = {
        topic,
        context: ctx,
        handler,
        consumerTag: "",
        consumerGeneration: 0,
        accepting: true,
        failure: null,
        recovering: null,
        recoveryRequested: false,
        recoveryStop: new AbortController(),
        tail: Promise.resolve(),
        stopping: null,
        settle(error: Error | null): void {
          settleTerminal?.(error)
        }
      }

      /** Rebuilds the configured topology and returns one exact native consumer tag. */
      async function acquireConsumer(): Promise<string> {
        const generation = state.consumerGeneration + 1
        state.consumerGeneration = generation
        if (exchange !== undefined) {
          await channel.assertExchange(exchange.name, exchange.type, exchange.options)
        }
        if (options?.prefetch !== undefined) {
          await channel.prefetch(options.prefetch.count, options.prefetch.global)
        }
        const queue = await channel.assertQueue(requestedQueue, queueOptions)
        if (exchange !== undefined) {
          await channel.bindQueue(queue.queue, exchange.name, routingKey, exchange.bindingArguments)
        }
        state.accepting = state.stopping === null && contextFailure(ctx) === null
        try {
          const consumed = await channel.consume(
            queue.queue,
            (native) => {
              if (generation !== state.consumerGeneration) return
              if (native === null) {
                state.accepting = false
                state.consumerTag = ""
                recoverConsumer()
                return
              }
              admit(state, native)
            },
            options?.consume
          )
          return consumed.consumerTag
        } catch (value) {
          if (generation === state.consumerGeneration) state.accepting = false
          throw value
        }
      }

      /** Reattaches one server-canceled consumer with bounded same-channel retries. */
      function recoverConsumer(): void {
        if (state.stopping !== null) return
        if (state.recovering !== null) {
          state.recoveryRequested = true
          return
        }
        state.recoveryRequested = false
        const operation = (async (): Promise<void> => {
          let delayMs = rabbitMqRecoveryInitialDelayMs
          let lastFailure: Error | null = null
          for (let attempt = 1; attempt <= rabbitMqRecoveryAttempts; attempt += 1) {
            if (state.stopping !== null) return
            if (attempt > 1) {
              await waitForRecoveryDelay(ctx, state.recoveryStop.signal, delayMs)
              delayMs = Math.min(rabbitMqRecoveryMaximumDelayMs, delayMs * 2)
              if (state.stopping !== null) return
            }
            const ownerFailure = contextFailure(ctx)
            if (ownerFailure !== null) {
              state.failure = ownerFailure
              return
            }
            try {
              const consumerTag = await acquireConsumer()
              state.consumerTag = consumerTag
              const postAcquireFailure = contextFailure(ctx)
              if (postAcquireFailure !== null) {
                state.failure = postAcquireFailure
                return
              }
              state.failure = null
              return
            } catch (value) {
              lastFailure = normalizeError("recover", value)
            }
          }
          if (lastFailure !== null) state.failure = recoveryFailure(lastFailure)
        })().catch((value: unknown) => {
          state.failure = normalizeError("recover", value)
        })
        state.recovering = operation
        void operation.then(() => {
          if (state.recovering === operation) state.recovering = null
          if (state.failure !== null && state.stopping === null) void beginStop(state)
          else if (state.recoveryRequested) recoverConsumer()
        })
      }

      const acquisition = acquireConsumer()
      try {
        state.consumerTag = await waitForContext(ctx, acquisition)
      } catch (value) {
        state.accepting = false
        void acquisition.then((consumerTag) => {
          state.consumerTag = consumerTag
          void beginStop(state)
        }, consumeFailure)
        throw normalizeError("subscribe", value)
      }

      const admissionFailure = contextFailure(ctx)
      if (admissionFailure !== null) {
        state.accepting = false
        void beginStop(state)
        throw admissionFailure
      }

      return registerSubscriberTerminal(
        Object.freeze({
          topic,
          /** Cancels only this consumer; caller Context limits only its wait. */
          unsubscribe(stopContext: Context): Promise<void> {
            return waitForContext(stopContext, beginStop(state))
          }
        }),
        terminal
      )
    },
    /** Delegates exact native acknowledgement without closing or replacing the channel. */
    ack(native: ConsumeMessage, allUpTo?: boolean): void {
      channel.ack(native, allUpTo)
    },
    /** Delegates exact native negative acknowledgement. */
    nack(native: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void {
      channel.nack(native, allUpTo, requeue)
    },
    /** Delegates exact native rejection. */
    reject(native: ConsumeMessage, requeue?: boolean): void {
      channel.reject(native, requeue)
    },
    string(): "rabbitmq" {
      return "rabbitmq"
    }
  })
}

/**
 * Creates the canonical recovery-aware provider through amqplib's own recovery setup callback.
 *
 * The returned connection remains application-owned. go-like owns each generated channel and
 * replays active topology and consumers, but never closes the recovering connection.
 */
export async function newRecoveringRabbitMqBroker(
  ctx: Context,
  connector: RabbitMqRecoveryConnector
): Promise<RecoveringRabbitMqBroker> {
  const initialFailure = contextFailure(ctx)
  if (initialFailure !== null) throw initialFailure
  if (typeof connector !== "function") {
    throw new TypeError("RabbitMQ recovery connector must be callable")
  }

  const subscriptions = new Set<RecoveringSubscription>()
  const settlements = new WeakMap<ConsumeMessage, SettlementBinding>()
  let generation = 0
  let activeBroker: RabbitMqBroker | null = null
  let activeChannel: Channel | null = null
  let setupRunning: Promise<void> | null = null
  let setupCompleted = false

  /** Closes the currently retained private generation channel when one exists. */
  async function closeActiveChannel(): Promise<void> {
    const channel = activeChannel
    if (channel === null) return
    try {
      await channel.close()
    } catch {}
    activeChannel = null
  }

  /** Closes a returned recovering connection and every retained private channel without leaking cleanup failures. */
  async function discardConnection(connection: RecoveringChannelModel): Promise<void> {
    try {
      await connection.close()
    } catch {}
    await closeActiveChannel()
    activeBroker = null
  }

  /** Removes one descriptor whose public subscription admission failed. */
  function discardSubscription(subscription: RecoveringSubscription): void {
    subscription.stopped = true
    subscriptions.delete(subscription)
  }

  /** Stops one discarded generation without affecting the recovering connection. */
  async function discard(native: Subscriber): Promise<void> {
    try {
      await native.unsubscribe(background())
    } catch {}
  }

  /** Attaches one stable descriptor at most once to the selected channel generation. */
  async function attach(
    subscription: RecoveringSubscription,
    broker: RabbitMqBroker,
    selectedGeneration: number
  ): Promise<void> {
    if (subscription.stopped || subscription.nativeGeneration === selectedGeneration) return
    if (subscription.attaching !== null) {
      await subscription.attaching
      if (
        !subscription.stopped &&
        subscription.nativeGeneration !== selectedGeneration &&
        generation === selectedGeneration
      ) {
        await attach(subscription, broker, selectedGeneration)
      }
      return
    }
    subscription.attachingGeneration = selectedGeneration
    const operation = (async () => {
      const native = await broker.subscribe(
        background(),
        subscription.topic,
        async (_handlerContext, event) => {
          settlements.set(event.native, Object.freeze({ broker, generation: selectedGeneration }))
          try {
            await subscription.handler(subscription.context, event)
          } catch (value) {
            if (generation === selectedGeneration) {
              subscription.stopped = true
              subscriptions.delete(subscription)
            }
            throw value
          }
        },
        subscription.options
      )
      if (subscription.stopped || generation !== selectedGeneration) {
        await discard(native)
        return
      }
      subscription.native = native
      subscription.nativeGeneration = selectedGeneration
      const terminal = subscriberTerminal(native)
      if (terminal !== null) {
        void terminal.catch((value: unknown) => {
          if (
            subscription.stopping !== null ||
            subscription.nativeGeneration !== selectedGeneration ||
            generation !== selectedGeneration
          ) {
            return
          }
          subscription.stopped = true
          subscriptions.delete(subscription)
          subscription.settle(normalizeError("terminal", value))
        })
      }
    })()
    subscription.attaching = operation
    try {
      await operation
    } finally {
      if (subscription.attachingGeneration === selectedGeneration) {
        subscription.attaching = null
      }
    }
  }

  /** Rebuilds one channel and atomically publishes it only after all topology is ready. */
  async function rebuild(model: ChannelModel): Promise<void> {
    const channel = await model.createConfirmChannel()
    const broker = newConfirmRabbitMqBroker(channel)
    generation += 1
    const selectedGeneration = generation
    activeBroker = null
    try {
      for (const subscription of subscriptions) {
        await attach(subscription, broker, selectedGeneration)
      }
      activeChannel = channel
      activeBroker = broker
    } catch (value) {
      try {
        await channel.close()
      } catch {}
      throw value
    }
  }

  /** Installs one observable setup barrier into amqplib's official recovery callback. */
  async function setup(model: ChannelModel): Promise<void> {
    const operation = rebuild(model)
    setupRunning = operation
    try {
      await operation
      setupCompleted = true
    } finally {
      if (setupRunning === operation) setupRunning = null
    }
  }

  /** Connects while rolling back any channel admitted before connector rejection. */
  async function connectRecovery(): Promise<RecoveringChannelModel> {
    try {
      return await Promise.resolve(connector(setup))
    } catch (value) {
      await closeActiveChannel()
      activeBroker = null
      throw value
    }
  }

  const connecting = connectRecovery()
  let connection: RecoveringChannelModel
  try {
    connection = await waitForContext(ctx, connecting)
  } catch (value) {
    activeBroker = null
    void connecting
      .then((lateConnection) => discardConnection(lateConnection), consumeFailure)
      .catch(consumeFailure)
    await closeActiveChannel()
    throw value
  }
  if (
    typeof connection !== "object" ||
    connection === null ||
    typeof connection.on !== "function" ||
    typeof connection.close !== "function"
  ) {
    await discardConnection(connection)
    throw new TypeError("RabbitMQ recovery connector must return a RecoveringChannelModel")
  }
  if (!setupCompleted || activeBroker === null) {
    await discardConnection(connection)
    throw new Error("RabbitMQ recovery connector must complete its initial setup")
  }

  /** Invalidates exact native handles after amqplib reports one lost generation. */
  const disconnected = (): void => {
    generation += 1
    activeBroker = null
    activeChannel = null
    for (const subscription of subscriptions) {
      subscription.native = null
      subscription.nativeGeneration = 0
    }
  }
  connection.on("disconnect", disconnected)
  connection.on("connect-failed", disconnected)

  const postConnectFailure = contextFailure(ctx)
  if (postConnectFailure !== null) {
    await discardConnection(connection)
    throw postConnectFailure
  }

  /** Starts or joins permanent stable-subscription shutdown. */
  function beginStableStop(subscription: RecoveringSubscription): Promise<void> {
    subscription.stopped = true
    subscriptions.delete(subscription)
    if (subscription.stopping !== null) return subscription.stopping
    subscription.stopping = (async () => {
      if (subscription.attaching !== null) await subscription.attaching
      const native = subscription.native
      subscription.native = null
      subscription.nativeGeneration = 0
      if (native !== null) await native.unsubscribe(background())
    })()
    void subscription.stopping.catch(consumeFailure)
    void subscription.stopping.then(
      () => subscription.settle(null),
      (value: unknown) => subscription.settle(normalizeError("unsubscribe", value))
    )
    return subscription.stopping
  }

  /** Returns the only still-current owner for one native delivery. */
  function settlement(native: ConsumeMessage): RabbitMqBroker {
    const binding = settlements.get(native)
    if (binding === undefined || binding.generation !== generation) {
      throw new Error("RabbitMQ delivery does not belong to the current channel generation")
    }
    return binding.broker
  }

  const broker: RabbitMqBroker = Object.freeze({
    /** Publishes through the current recovered channel without inventing an offline buffer. */
    publish(
      publishContext: Context,
      topic: string,
      message: BrokerMessage,
      options?: RabbitMqPublishOptions
    ): Promise<boolean> {
      const selected = activeBroker
      if (selected === null) {
        return Promise.reject(new Error("RabbitMQ recovering broker is disconnected"))
      }
      return selected.publish(publishContext, topic, message, options)
    },
    /** Creates one stable subscription descriptor replayed by every official setup generation. */
    async subscribe(
      subscribeContext: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<ConsumeMessage>) => void | PromiseLike<void>,
      options?: RabbitMqSubscribeOptions
    ): Promise<Subscriber> {
      const failure = contextFailure(subscribeContext)
      if (failure !== null) throw failure
      validateTopic(topic)
      if (typeof handler !== "function") {
        throw new TypeError("RabbitMQ Broker handler must be callable")
      }
      let settleTerminal: ((error: Error | null) => void) | null = null
      const terminal = new Promise<void>((resolve, reject) => {
        settleTerminal = (error) => {
          settleTerminal = null
          if (error === null) resolve()
          else reject(error)
        }
      })
      void terminal.catch(consumeFailure)
      const subscription: RecoveringSubscription = {
        topic,
        context: subscribeContext,
        handler,
        options,
        stopped: false,
        native: null,
        nativeGeneration: 0,
        attaching: null,
        attachingGeneration: 0,
        stopping: null,
        settle(error: Error | null): void {
          settleTerminal?.(error)
        }
      }
      subscriptions.add(subscription)
      const attachment = (async () => {
        if (activeBroker === null && setupRunning !== null) await setupRunning
        const selected = activeBroker
        const selectedGeneration = generation
        if (selected !== null) await attach(subscription, selected, selectedGeneration)
      })()
      let attachmentAdmitted = false
      try {
        await waitForContext(subscribeContext, attachment)
        attachmentAdmitted = true
        const admissionFailure = contextFailure(subscribeContext)
        if (admissionFailure !== null) throw admissionFailure
      } catch (value) {
        discardSubscription(subscription)
        const cancellation = contextFailure(subscribeContext)
        if (!attachmentAdmitted && cancellation !== null && value === cancellation) {
          void attachment.finally(() => beginStableStop(subscription)).catch(consumeFailure)
          throw cancellation
        }
        const primary = normalizeError("subscribe", value)
        try {
          await beginStableStop(subscription)
        } catch (cleanupValue) {
          const cleanup = normalizeError("unsubscribe", cleanupValue)
          if (cleanup !== primary) {
            throw new AggregateError(
              [primary, cleanup],
              "RabbitMQ Broker subscription admission and rollback failed",
              { cause: primary }
            )
          }
        }
        throw primary
      }
      return registerSubscriberTerminal(
        Object.freeze({
          topic,
          /** Permanently prevents replay before draining the current exact consumer. */
          unsubscribe(stopContext: Context): Promise<void> {
            return waitForContext(stopContext, beginStableStop(subscription))
          }
        }),
        terminal
      )
    },
    /** Routes acknowledgement to the exact generation that delivered this message. */
    ack(native: ConsumeMessage, allUpTo?: boolean): void {
      settlement(native).ack(native, allUpTo)
    },
    /** Routes negative acknowledgement to the exact delivery generation. */
    nack(native: ConsumeMessage, allUpTo?: boolean, requeue?: boolean): void {
      settlement(native).nack(native, allUpTo, requeue)
    },
    /** Routes rejection to the exact delivery generation. */
    reject(native: ConsumeMessage, requeue?: boolean): void {
      settlement(native).reject(native, requeue)
    },
    /** Returns the stable provider diagnostic name. */
    string(): "rabbitmq" {
      return "rabbitmq"
    }
  })

  return Object.freeze({ broker, connection })
}
