import type { Broker, BrokerHandler, BrokerMessage, Subscriber } from ".."
import {
  brokerTopic,
  deliver,
  newBrokerEvent,
  publish as publishMessage,
  registerSubscriberTerminal,
  snapshotBrokerMessage
} from "../provider"
import { cause, type Context } from "../../context"
import { waitForContext } from "../../context"

/** Implements the process-local Broker contract without native delivery state. */
export interface MemoryBroker extends Broker<void, void, void, null> {
  string(): "memory"
}

interface MemorySubscription {
  readonly topic: string
  readonly context: Context
  readonly handler: BrokerHandler<null>
  accepting: boolean
  tail: Promise<void>
  drain: Promise<void> | null
  settle(error: Error | null): void
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

  /** Appends one delivery. The event copy is taken when the handler runs, not when it is queued. */
  function admit(
    subscription: MemorySubscription,
    topic: string,
    message: BrokerMessage
  ): Promise<void> {
    const delivery = subscription.tail.then(async () => {
      const event = newBrokerEvent(topic, message.headers, message.body, null)
      try {
        await deliver(
          subscription.context,
          "memory",
          subscription.topic,
          event,
          subscription.handler
        )
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
    /** Publishes one detached message and waits for every admitted handler. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: void
    ): Promise<void> {
      checkContext(ctx)
      const selectedTopic = brokerTopic(topic)
      const prepared = snapshotBrokerMessage(message)
      if (options !== undefined) {
        throw new TypeError("Memory Broker publish options are not supported")
      }
      await publishMessage(ctx, "memory", selectedTopic, prepared, async (unitCtx, traced) => {
        const members = topics.get(selectedTopic)
        if (members === undefined) return
        const deliveries: Promise<void>[] = []
        for (const subscription of members) {
          if (!subscription.accepting) continue
          deliveries.push(admit(subscription, selectedTopic, traced))
        }
        await waitForContext(unitCtx, settleDeliveries(deliveries))
      })
    },
    /** Opens one exact-topic subscription. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: BrokerHandler<null>,
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
        /** Settles the provider terminal once. */
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
    /** Returns the process-local system name. */
    string(): "memory" {
      return "memory"
    }
  }
  return Object.freeze(broker)
}
