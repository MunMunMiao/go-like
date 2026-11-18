import type { Broker, Subscriber } from "@go-like/core/broker"
import type { Context } from "@go-like/core/context"
import type { BrokerConformanceSubject, ConformanceCase } from "@go-like/core/testing"

/**
 * One conformance subject that releases every subscription it opened.
 * `release` runs after those subscriptions stop, for the case queue.
 */
export function brokerCaseSubject<PublishOptions, PublishResult, SubscribeOptions, Native>(
  topic: string,
  open: () => Promise<Broker<PublishOptions, PublishResult, SubscribeOptions, Native>>,
  release?: () => Promise<void>
): BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native> {
  const subscribers: Subscriber[] = []
  return {
    topic,
    async newBroker() {
      const broker = await open()
      return {
        string: () => broker.string(),
        publish: (ctx, publishTopic, message, options) =>
          broker.publish(ctx, publishTopic, message, options),
        async subscribe(ctx, subscribeTopic, handler, options) {
          const subscriber = await broker.subscribe(ctx, subscribeTopic, handler, options)
          subscribers.push(subscriber)
          return subscriber
        }
      }
    },
    async close(ctx: Context) {
      const pending = subscribers.splice(0, subscribers.length)
      let failure: unknown
      let failed = false
      for (const subscriber of pending) {
        try {
          await subscriber.unsubscribe(ctx)
        } catch (error) {
          // A completed stop reports the handler error. An AggregateError means
          // the stop itself failed and the subscription may still be open.
          if (error instanceof AggregateError && !failed) {
            failed = true
            failure = error
          }
        }
      }
      if (release !== undefined) {
        try {
          await release()
        } catch (error) {
          if (!failed) {
            failed = true
            failure = error
          }
        }
      }
      if (failed) throw failure
    }
  }
}

/** Allocates a fresh queue topic for every case and releases that case on close. */
export function isolatedCases<PublishOptions, PublishResult, SubscribeOptions, Native>(
  prefix: string,
  open: () => Promise<Broker<PublishOptions, PublishResult, SubscribeOptions, Native>>,
  release?: (topic: string) => Promise<void>
): () => BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native> {
  let count = 0
  return () => {
    count += 1
    const topic = `${prefix}.${count}`
    return brokerCaseSubject(topic, open, async () => {
      await release?.(topic)
    })
  }
}

/**
 * Runs every case from `define` on a subject `create` has not used before.
 * The name list is taken from a probe that never opens a backend.
 */
export async function runIsolatedBrokerCases<
  PublishOptions,
  PublishResult,
  SubscribeOptions,
  Native
>(
  define: (
    subject: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>
  ) => readonly ConformanceCase[],
  create: () => BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native>
): Promise<void> {
  const probe: BrokerConformanceSubject<PublishOptions, PublishResult, SubscribeOptions, Native> = {
    topic: "probe",
    async newBroker() {
      throw new Error("probe")
    },
    async close() {}
  }
  for (const name of define(probe).map((entry) => entry.name)) {
    const subject = create()
    const entry = define(subject).find((item) => item.name === name)
    if (entry === undefined) throw new Error(`missing broker case ${name}`)
    try {
      await entry.run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${name}: ${message}`, { cause: error })
    }
  }
}
