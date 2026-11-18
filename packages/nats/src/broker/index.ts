import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/core/broker"
import { publish as publishUnit, snapshotBrokerMessage } from "@go-like/core/broker/provider"
import type { Context } from "@go-like/core/context"
import type {
  Msg,
  NatsConnection,
  PublishOptions,
  Subscription,
  SubscriptionOptions
} from "@nats-io/transport-node"
import { brokerEvent, contextFailure, prepareBrokerMessage, validateTopic } from "../shared/message"
import {
  managedSubscriber,
  nativeBrokerRuntime,
  rejectNativeBrokerAdmission,
  type NativeBrokerLifecycle
} from "../shared/runtime"

/** Exposes official NATS Core publish options while reserving headers for BrokerMessage. */
export type NatsCoreBrokerPublishOptions = Omit<PublishOptions, "headers">

/** Exposes iterator subscription options while reserving callback ownership for go-like. */
export type NatsCoreBrokerSubscribeOptions = Omit<SubscriptionOptions, "callback">

/** Named Broker returned by `newNatsCoreBroker`. The native event is `Msg`. */
export type NatsCoreBroker = Broker<
  NatsCoreBrokerPublishOptions,
  void,
  NatsCoreBrokerSubscribeOptions,
  Msg
>

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
    terminal(): Promise<void | Error> {
      return native.closed
    },
    /** Forces only this native subscription to stop. */
    force(): void {
      native.unsubscribe()
    }
  }
}

/** Describes an official Subscription that closed outside its owner stop. */
export interface NatsCoreUnexpectedExitError extends Error {
  readonly name: "NatsCoreUnexpectedExitError"
  readonly code: "GO_LIKE_NATS_CORE_UNEXPECTED_EXIT"
  readonly cause: Error | null
}

/** Describes a Subscription that required unsubscribe after its drain boundary. */
export interface NatsCoreDrainTimeoutError extends Error {
  readonly name: "NatsCoreDrainTimeoutError"
  readonly code: "GO_LIKE_NATS_CORE_DRAIN_TIMEOUT"
  readonly timeoutMs: number
  readonly forced: true
}

interface NatsCoreConfig {
  drainTimeoutMs: number
}

/** Applies one construction-time drain boundary to a NATS Core broker. */
export type NatsCoreOption = (config: NatsCoreConfig) => void

const maximumTimerDelayMs = 2_147_483_647
const defaultDrainTimeoutMs = 25_000

/**
 * Configures the NATS Core drain boundary before requesting native unsubscribe.
 *
 * The provider boundary is necessary because Subscription.drain() has no AbortSignal.
 */
export function natsCoreDrainTimeout(timeoutMs: number): NatsCoreOption {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > maximumTimerDelayMs
  ) {
    throw new RangeError(
      "NATS Core drain timeout must be an integer from 0 to 2147483647 milliseconds"
    )
  }
  return (config) => {
    config.drainTimeoutMs = timeoutMs
  }
}

/** Creates a Broker over one borrowed official NATS Core connection. */
export function newNatsCoreBroker(
  connection: NatsConnection,
  ...options: readonly NatsCoreOption[]
): NatsCoreBroker {
  if (typeof connection !== "object" || connection === null) {
    throw new TypeError("NATS Core Broker connection must be an object")
  }
  const publish = connection.publish
  const subscribe = connection.subscribe
  if (typeof publish !== "function" || typeof subscribe !== "function") {
    throw new TypeError("NATS Core Broker connection methods must be callable")
  }
  const config: NatsCoreConfig = { drainTimeoutMs: defaultDrainTimeoutMs }
  for (const option of options) {
    if (typeof option !== "function") {
      throw new TypeError("NATS Core Broker option must be callable")
    }
    option(config)
  }
  const drainTimeoutMs = config.drainTimeoutMs

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
      const prepared = snapshotBrokerMessage(message)
      await publishUnit(ctx, "nats", topic, prepared, async (_unitCtx, traced) => {
        const nativeMessage = prepareBrokerMessage(traced)
        const nativeOptions = publishOptions(nativeMessage.headers, options)
        if (nativeOptions === undefined) publish.call(connection, topic, nativeMessage.body)
        else publish.call(connection, topic, nativeMessage.body, nativeOptions)
      })
    },
    /** Creates and owns the lifecycle of one official Core subscription. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<Msg>) => void | Promise<void>,
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
        await rejectNativeBrokerAdmission(lifecycle, admissionFailure, drainTimeoutMs)
      }
      const runtime = nativeBrokerRuntime(lifecycle, drainTimeoutMs)
      return managedSubscriber(ctx, topic, native, runtime, brokerEvent, handler, "nats")
    },
    /** Returns a stable provider diagnostic name. */
    string(): string {
      return "nats-core"
    }
  })
}
