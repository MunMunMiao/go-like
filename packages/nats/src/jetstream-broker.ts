import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import type { Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import type {
  ConsumerMessages,
  JetStreamClient,
  JetStreamPublishOptions,
  JsMsg,
  PubAck
} from "@nats-io/jetstream"
import type { MsgHdrs } from "@nats-io/transport-node"
import { brokerEvent, contextFailure, prepareBrokerMessage, validateTopic } from "./broker-message"
import {
  managedSubscriber,
  nativeBrokerRuntime,
  rejectNativeBrokerAdmission,
  type NativeBrokerLifecycle
} from "./broker-runtime"

/** Exposes official JetStream publish options while reserving headers for BrokerMessage. */
export type NatsJetStreamBrokerPublishOptions = Omit<Partial<JetStreamPublishOptions>, "headers">

/** Creates official ConsumerMessages for one Broker subscription. */
export type NatsJetStreamBrokerMessagesFactory<Options> = (
  ctx: Context,
  topic: string,
  options?: Options
) => ConsumerMessages | PromiseLike<ConsumerMessages>

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
    terminal(): PromiseLike<void | Error> {
      return messages.closed()
    },
    /** Forces only this ConsumerMessages stream to stop. */
    force(): void {
      messages.stop()
    }
  }
}

/** Creates a Broker over one borrowed official JetStream client and explicit consumer factory. */
export function newNatsJetStreamBroker<SubscribeOptions = void>(
  client: JetStreamClient,
  messagesFactory: NatsJetStreamBrokerMessagesFactory<SubscribeOptions>
): Broker<NatsJetStreamBrokerPublishOptions, PubAck, SubscribeOptions, JsMsg> {
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
      const prepared = prepareBrokerMessage(message)
      const nativeOptions = publishOptions(prepared.headers, options)
      const operation =
        nativeOptions === undefined
          ? publish.call(client, topic, prepared.body)
          : publish.call(client, topic, prepared.body, nativeOptions)
      return await waitForContext(ctx, operation)
    },
    /** Acquires and owns the lifecycle of one official ConsumerMessages value. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<JsMsg>) => void | PromiseLike<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      const failure = contextFailure(ctx)
      if (failure !== null) throw failure
      validateTopic(topic)
      if (typeof handler !== "function") {
        throw new TypeError("NATS JetStream Broker handler must be callable")
      }
      let supplied: ConsumerMessages | PromiseLike<ConsumerMessages>
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
          await rejectNativeBrokerAdmission(messagesLifecycle(provisional), primary)
        } else {
          void acquisition.then((lateMessages) => {
            void rejectNativeBrokerAdmission(messagesLifecycle(lateMessages), primary).catch(
              consumeFailure
            )
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
        await rejectNativeBrokerAdmission(messagesLifecycle(messages), admissionFailure)
      }
      const runtime = nativeBrokerRuntime(messagesLifecycle(messages))
      return managedSubscriber(ctx, topic, messages, runtime, brokerEvent, handler)
    },
    /** Returns a stable provider diagnostic name. */
    string(): string {
      return "nats-jetstream"
    }
  })
}
