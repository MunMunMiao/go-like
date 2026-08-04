import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import type { Context } from "@go-like/context"
import type {
  Msg,
  NatsConnection,
  PublishOptions,
  Subscription,
  SubscriptionOptions
} from "@nats-io/transport-node"
import { brokerEvent, contextFailure, prepareBrokerMessage, validateTopic } from "./broker-message"
import {
  managedSubscriber,
  nativeBrokerRuntime,
  rejectNativeBrokerAdmission,
  type NativeBrokerLifecycle
} from "./broker-runtime"

/** Exposes official NATS Core publish options while reserving headers for BrokerMessage. */
export type NatsCoreBrokerPublishOptions = Omit<PublishOptions, "headers">

/** Exposes iterator subscription options while reserving callback ownership for go-like. */
export type NatsCoreBrokerSubscribeOptions = Omit<SubscriptionOptions, "callback">

/** Creates native publish options with BrokerMessage as the only header source. */
function publishOptions(
  messageHeaders: ReturnType<typeof prepareBrokerMessage>["headers"],
  options: NatsCoreBrokerPublishOptions | undefined
): PublishOptions | undefined {
  if (messageHeaders === null && options === undefined) return undefined
  if (messageHeaders === null) return Object.assign({}, options)
  return Object.assign({}, options, { headers: messageHeaders })
}

/** Reports whether a native subscribe result has the official lifecycle surface go-like owns. */
function isSubscription(value: unknown): value is Subscription {
  if (typeof value !== "object" || value === null) return false
  return (
    typeof Reflect.get(value, "drain") === "function" &&
    typeof Reflect.get(value, "unsubscribe") === "function" &&
    "closed" in value &&
    Symbol.asyncIterator in value
  )
}

/** Captures one provisional Core subscription behind the shared rollback lifecycle. */
function subscriptionLifecycle(native: Subscription): NativeBrokerLifecycle {
  return {
    kind: "core",
    /** Starts the official graceful subscription drain. */
    graceful(): Promise<void> {
      return native.drain()
    },
    /** Returns the official subscription terminal barrier. */
    terminal(): PromiseLike<void | Error> {
      return native.closed
    },
    /** Forces only this native subscription to stop. */
    force(): void {
      native.unsubscribe()
    }
  }
}

/** Creates a Broker over one borrowed official NATS Core connection. */
export function newNatsCoreBroker(
  connection: NatsConnection
): Broker<NatsCoreBrokerPublishOptions, void, NatsCoreBrokerSubscribeOptions, Msg> {
  if (typeof connection !== "object" || connection === null) {
    throw new TypeError("NATS Core Broker connection must be an object")
  }
  const publish = connection.publish
  const subscribe = connection.subscribe
  if (typeof publish !== "function" || typeof subscribe !== "function") {
    throw new TypeError("NATS Core Broker connection methods must be callable")
  }

  return Object.freeze({
    /** Publishes detached bytes synchronously after the Context preflight. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: NatsCoreBrokerPublishOptions
    ): Promise<void> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      validateTopic(topic)
      const prepared = prepareBrokerMessage(message)
      const nativeOptions = publishOptions(prepared.headers, options)
      if (nativeOptions === undefined) publish.call(connection, topic, prepared.body)
      else publish.call(connection, topic, prepared.body, nativeOptions)
    },
    /** Creates and owns the lifecycle of one official Core subscription. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<Msg>) => void | PromiseLike<void>,
      options?: NatsCoreBrokerSubscribeOptions
    ): Promise<Subscriber> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      validateTopic(topic)
      if (typeof handler !== "function")
        throw new TypeError("NATS Core Broker handler must be callable")
      if (options !== undefined && Reflect.has(options, "callback")) {
        throw new TypeError("NATS Core Broker owns the native subscription callback")
      }
      const native =
        options === undefined
          ? subscribe.call(connection, topic)
          : subscribe.call(connection, topic, options)
      if (!isSubscription(native)) {
        throw new TypeError("NATS Core Broker subscribe must return an official Subscription")
      }
      const lifecycle = subscriptionLifecycle(native)
      let admissionFailure: Error | null
      try {
        admissionFailure = contextFailure(ctx)
      } catch (value) {
        admissionFailure =
          value instanceof Error
            ? value
            : new Error("NATS Core Broker admission rejected with a non-Error value", {
                cause: value
              })
      }
      if (admissionFailure !== null) {
        await rejectNativeBrokerAdmission(lifecycle, admissionFailure)
      }
      const runtime = nativeBrokerRuntime(lifecycle)
      return managedSubscriber(ctx, topic, native, runtime, brokerEvent, handler)
    },
    /** Returns a stable provider diagnostic name. */
    string(): string {
      return "nats-core"
    }
  })
}
