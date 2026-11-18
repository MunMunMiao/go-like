import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/core/broker"
import { publish as publishUnit, snapshotBrokerMessage } from "@go-like/core/broker/provider"
import type { Context } from "@go-like/core/context"
import { waitForContext } from "@go-like/core/context"
import type {
  ConsumerMessages,
  JetStreamClient,
  JetStreamPublishOptions,
  JsMsg,
  PubAck
} from "@nats-io/jetstream"
import type { MsgHdrs } from "@nats-io/transport-node"
import { brokerEvent, contextFailure, prepareBrokerMessage, validateTopic } from "../shared/message"
import {
  managedSubscriber,
  nativeBrokerRuntime,
  rejectNativeBrokerAdmission,
  type NativeBrokerLifecycle
} from "../shared/runtime"

/** Exposes official JetStream publish options while reserving headers for BrokerMessage. */
export type NatsJetStreamBrokerPublishOptions = Omit<Partial<JetStreamPublishOptions>, "headers">

/** Creates official ConsumerMessages for one Broker subscription. */
export type NatsJetStreamBrokerMessagesFactory<Options> = (
  ctx: Context,
  topic: string,
  options?: Options
) => ConsumerMessages | Promise<ConsumerMessages>

/**
 * Named Broker returned by `newNatsJetStreamBroker`.
 * The publish result is `PubAck` and the native event is `JsMsg`.
 */
export type NatsJetStreamBroker<SubscribeOptions = void> = Broker<
  NatsJetStreamBrokerPublishOptions,
  PubAck,
  SubscribeOptions,
  JsMsg
>

/** Creates JetStream publish options with BrokerMessage as the only header source. */
function publishOptions(
  messageHeaders: MsgHdrs | null,
  options: NatsJetStreamBrokerPublishOptions | undefined
): Partial<JetStreamPublishOptions> | undefined {
  if (messageHeaders === null && options === undefined) return undefined
  if (messageHeaders === null) return Object.assign({}, options)
  return Object.assign({}, options, { headers: messageHeaders })
}

/** Deliberately observes a retained acquisition or cleanup rejection. */
function consumeFailure(_value: unknown): void {}

/** Preserves startup Error identity while normalizing an invalid rejection value. */
function normalizeStartupError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error("NATS JetStream Broker acquisition rejected with a non-Error value", {
    cause: value
  })
}

/** Reports whether one factory value has the official ConsumerMessages lifecycle surface. */
function isConsumerMessages(value: unknown): value is ConsumerMessages {
  if (typeof value !== "object" || value === null) return false
  return (
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "closed") === "function" &&
    typeof Reflect.get(value, "stop") === "function" &&
    Symbol.asyncIterator in value
  )
}

/** Stops one acquired but unaccepted stream and keeps the admission failure primary. */
function messagesLifecycle(messages: ConsumerMessages): NativeBrokerLifecycle {
  return {
    kind: "jetstream",
    /** Starts the official graceful ConsumerMessages close. */
    graceful(): Promise<void | Error> {
      return messages.close()
    },
    /** Returns the official ConsumerMessages terminal barrier. */
    terminal(): Promise<void | Error> {
      return messages.closed()
    },
    /** Forces only this ConsumerMessages stream to stop. */
    force(): void {
      messages.stop()
    }
  }
}

/** Describes ConsumerMessages that closed outside their owner stop. */
export interface NatsJetStreamUnexpectedExitError extends Error {
  readonly name: "NatsJetStreamUnexpectedExitError"
  readonly code: "GO_LIKE_NATS_JETSTREAM_UNEXPECTED_EXIT"
  readonly cause: Error | null
}

/** Describes ConsumerMessages that required stop after their close boundary. */
export interface NatsJetStreamCloseTimeoutError extends Error {
  readonly name: "NatsJetStreamCloseTimeoutError"
  readonly code: "GO_LIKE_NATS_JETSTREAM_CLOSE_TIMEOUT"
  readonly timeoutMs: number
  readonly forced: true
}

interface NatsJetStreamConfig {
  closeTimeoutMs: number
}

/** Applies one construction-time close boundary to a JetStream broker. */
export type NatsJetStreamOption = (config: NatsJetStreamConfig) => void

const maximumTimerDelayMs = 2_147_483_647
const defaultCloseTimeoutMs = 25_000

/**
 * Configures the JetStream close boundary before requesting native stop.
 *
 * The provider boundary is necessary because ConsumerMessages.close() has no AbortSignal.
 */
export function natsJetStreamCloseTimeout(timeoutMs: number): NatsJetStreamOption {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > maximumTimerDelayMs
  ) {
    throw new RangeError(
      "NATS JetStream close timeout must be an integer from 0 to 2147483647 milliseconds"
    )
  }
  return (config) => {
    config.closeTimeoutMs = timeoutMs
  }
}

/** Creates a Broker over one borrowed official JetStream client and explicit consumer factory. */
export function newNatsJetStreamBroker<SubscribeOptions = void>(
  client: JetStreamClient,
  messagesFactory: NatsJetStreamBrokerMessagesFactory<SubscribeOptions>,
  ...options: readonly NatsJetStreamOption[]
): NatsJetStreamBroker<SubscribeOptions> {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("NATS JetStream Broker client must be an object")
  }
  const publish = client.publish
  if (typeof publish !== "function") {
    throw new TypeError("NATS JetStream Broker publish method must be callable")
  }
  if (typeof messagesFactory !== "function") {
    throw new TypeError("NATS JetStream Broker messages factory must be callable")
  }
  const config: NatsJetStreamConfig = { closeTimeoutMs: defaultCloseTimeoutMs }
  for (const option of options) {
    if (typeof option !== "function") {
      throw new TypeError("NATS JetStream Broker option must be callable")
    }
    option(config)
  }
  const closeTimeoutMs = config.closeTimeoutMs

  return Object.freeze({
    /** Publishes detached bytes and preserves the exact official PubAck result. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: NatsJetStreamBrokerPublishOptions
    ): Promise<PubAck> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      validateTopic(topic)
      const prepared = snapshotBrokerMessage(message)
      return await publishUnit(ctx, "nats", topic, prepared, async (unitCtx, traced) => {
        const nativeMessage = prepareBrokerMessage(traced)
        const nativeOptions = publishOptions(nativeMessage.headers, options)
        const operation =
          nativeOptions === undefined
            ? publish.call(client, topic, nativeMessage.body)
            : publish.call(client, topic, nativeMessage.body, nativeOptions)
        return await waitForContext(unitCtx, operation)
      })
    },
    /** Acquires and owns the lifecycle of one official ConsumerMessages value. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<JsMsg>) => void | Promise<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      validateTopic(topic)
      if (typeof handler !== "function") {
        throw new TypeError("NATS JetStream Broker handler must be callable")
      }
      let supplied: ConsumerMessages | Promise<ConsumerMessages>
      try {
        supplied =
          options === undefined ? messagesFactory(ctx, topic) : messagesFactory(ctx, topic, options)
      } catch (value) {
        throw normalizeStartupError(value)
      }
      const provisional = isConsumerMessages(supplied) ? supplied : null
      const acquisition =
        provisional === null
          ? Promise.resolve(supplied).then((value) => {
              if (!isConsumerMessages(value)) {
                throw new TypeError(
                  "NATS JetStream Broker factory must provide official ConsumerMessages"
                )
              }
              return value
            })
          : Promise.resolve(provisional)
      let messages: ConsumerMessages
      try {
        messages = await waitForContext(ctx, acquisition)
      } catch (value) {
        const primary = normalizeStartupError(value)
        if (provisional !== null) {
          await rejectNativeBrokerAdmission(messagesLifecycle(provisional), primary, closeTimeoutMs)
        } else {
          void acquisition.then((lateMessages) => {
            void rejectNativeBrokerAdmission(
              messagesLifecycle(lateMessages),
              primary,
              closeTimeoutMs
            ).catch(consumeFailure)
          }, consumeFailure)
        }
        throw primary
      }
      let admissionFailure: Error | null
      try {
        admissionFailure = contextFailure(ctx)
      } catch (value) {
        admissionFailure = normalizeStartupError(value)
      }
      if (admissionFailure !== null) {
        await rejectNativeBrokerAdmission(
          messagesLifecycle(messages),
          admissionFailure,
          closeTimeoutMs
        )
      }
      const runtime = nativeBrokerRuntime(messagesLifecycle(messages), closeTimeoutMs)
      return managedSubscriber(ctx, topic, messages, runtime, brokerEvent, handler, "nats")
    },
    /** Returns a stable provider diagnostic name. */
    string(): string {
      return "nats-jetstream"
    }
  })
}
