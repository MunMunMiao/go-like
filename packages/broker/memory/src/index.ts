import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import { registerSubscriberTerminal } from "@go-like/broker/provider"
import { cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"

/** Implements the process-local Broker contract without native delivery state. */
export interface MemoryBroker extends Broker<void, void, void, null> {
  string(): "memory"
}

interface PreparedMessage {
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

interface MemorySubscription {
  readonly topic: string
  readonly context: Context
  readonly handler: (ctx: Context, event: BrokerEvent<null>) => void | PromiseLike<void>
  accepting: boolean
  tail: Promise<void>
  drain: Promise<void> | null
  settle(error: Error | null): void
}

/** Reports whether a string contains no unmatched UTF-16 surrogate code units. */
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

/** Returns the exact cancellation carried by one terminal Context. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Rejects admission from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Validates one exact non-empty process-local topic. */
function brokerTopic(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError("Memory Broker topic must be a non-empty well-formed string")
  }
  return value
}

/** Defines one header without allowing special object keys to mutate its prototype. */
function defineHeader(target: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  })
}

/** Validates and detaches one publish payload before subscription admission. */
function prepareMessage(message: BrokerMessage): PreparedMessage {
  if (typeof message !== "object" || message === null) {
    throw new TypeError("Memory Broker message must be an object")
  }
  if (!(message.body instanceof Uint8Array)) {
    throw new TypeError("Memory Broker message body must be Uint8Array")
  }
  if (
    typeof message.headers !== "object" ||
    message.headers === null ||
    Array.isArray(message.headers)
  ) {
    throw new TypeError("Memory Broker message headers must be an object")
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
      throw new TypeError("Memory Broker message headers must contain well-formed string entries")
    }
    defineHeader(headers, name, value)
  }
  return Object.freeze({
    headers: Object.freeze(headers),
    body: new Uint8Array(message.body)
  })
}

/** Creates one delivery-owned immutable message view with copy-on-read bytes. */
function deliveryMessage(prepared: PreparedMessage): BrokerMessage {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(prepared.headers)) {
    defineHeader(headers, name, value)
  }
  const body = new Uint8Array(prepared.body)
  return Object.freeze({
    headers: Object.freeze(headers),
    get body(): Uint8Array {
      return new Uint8Array(body)
    }
  })
}

/** Preserves handler Error identity while normalizing invalid rejection values. */
function handlerFailure(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error("Memory Broker handler rejected with a non-Error value", { cause: value })
}

/** Resolves all admitted deliveries or reports failures in stable subscription order. */
async function settleDeliveries(deliveries: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(deliveries)
  const failures: Error[] = []
  for (const result of results) {
    if (result.status === "rejected") failures.push(handlerFailure(result.reason))
  }
  const first = failures[0]
  if (first === undefined) return
  if (failures.length === 1) throw first
  throw new AggregateError(failures, "Memory Broker deliveries failed", { cause: first })
}

/** Creates one immediately usable exact-topic process-local Broker. */
export function newMemoryBroker(): MemoryBroker {
  const topics = new Map<string, Set<MemorySubscription>>()

  /** Removes one subscription from future admission exactly once. */
  function remove(subscription: MemorySubscription): void {
    if (!subscription.accepting) return
    subscription.accepting = false
    const members = topics.get(subscription.topic)
    if (members === undefined) return
    members.delete(subscription)
    if (members.size === 0) topics.delete(subscription.topic)
  }

  /** Appends one immutable delivery to a subscriber's FIFO handler tail. */
  function admit(subscription: MemorySubscription, prepared: PreparedMessage): Promise<void> {
    const delivery = subscription.tail.then(async () => {
      const event = Object.freeze({
        topic: subscription.topic,
        message: deliveryMessage(prepared),
        native: null
      })
      try {
        await subscription.handler(subscription.context, event)
      } catch (value) {
        const failure = handlerFailure(value)
        remove(subscription)
        subscription.settle(failure)
        throw failure
      }
    })
    subscription.tail = delivery
    return delivery
  }

  const broker: MemoryBroker = {
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: void
    ): Promise<void> {
      checkContext(ctx)
      const selectedTopic = brokerTopic(topic)
      const prepared = prepareMessage(message)
      if (options !== undefined) {
        throw new TypeError("Memory Broker publish options are not supported")
      }
      const members = topics.get(selectedTopic)
      if (members === undefined) return
      const deliveries: Promise<void>[] = []
      for (const subscription of members) {
        if (subscription.accepting) deliveries.push(admit(subscription, prepared))
      }
      await waitForContext(ctx, settleDeliveries(deliveries))
    },
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<null>) => void | PromiseLike<void>,
      options?: void
    ): Promise<Subscriber> {
      checkContext(ctx)
      const selectedTopic = brokerTopic(topic)
      if (typeof handler !== "function") {
        throw new TypeError("Memory Broker handler must be callable")
      }
      if (options !== undefined) {
        throw new TypeError("Memory Broker subscribe options are not supported")
      }
      let settleTerminal: ((error: Error | null) => void) | null = null
      const terminal = new Promise<void>((resolve, reject) => {
        settleTerminal = (error) => {
          settleTerminal = null
          if (error === null) resolve()
          else reject(error)
        }
      })
      void terminal.catch(() => {})
      const subscription: MemorySubscription = {
        topic: selectedTopic,
        context: ctx,
        handler,
        accepting: true,
        tail: Promise.resolve(),
        drain: null,
        settle(error: Error | null): void {
          settleTerminal?.(error)
        }
      }
      let members = topics.get(selectedTopic)
      if (members === undefined) {
        members = new Set()
        topics.set(selectedTopic, members)
      }
      members.add(subscription)

      /** Starts or joins this subscription's caller-independent drain. */
      function beginDrain(): Promise<void> {
        if (subscription.drain !== null) return subscription.drain
        remove(subscription)
        subscription.drain = subscription.tail
        void subscription.drain.catch(() => {})
        void subscription.drain.then(
          () => subscription.settle(null),
          (value: unknown) => subscription.settle(handlerFailure(value))
        )
        return subscription.drain
      }

      return registerSubscriberTerminal(
        Object.freeze({
          topic: selectedTopic,
          /** Stops new admission before waiting for all previously admitted handlers. */
          unsubscribe(stopContext: Context): Promise<void> {
            return waitForContext(stopContext, beginDrain())
          }
        }),
        terminal
      )
    },
    string(): "memory" {
      return "memory"
    }
  }
  return Object.freeze(broker)
}
