import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@likego/broker"
import type { Context } from "@likego/context"
import { SpanKind, type TextMapPropagator, type Tracer } from "@opentelemetry/api"

import {
  extractHeaders,
  failSpan,
  injectHeaders,
  succeedSpan,
  validatePropagator,
  validateTracer,
  type HeaderCarrier
} from "./instrumentation"

/** Wraps one structural Broker without taking ownership of its connection or native events. */
export function traceBroker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>,
  tracer: Tracer,
  propagator?: TextMapPropagator<HeaderCarrier>
): Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent> {
  const candidate: unknown = broker
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof broker.publish !== "function" ||
    typeof broker.subscribe !== "function" ||
    typeof broker.string !== "function"
  ) {
    throw new TypeError("broker must implement the LikeGo Broker interface")
  }
  validateTracer(tracer)
  validatePropagator(propagator)
  const publish = broker.publish
  const subscribe = broker.subscribe
  const string = broker.string

  return Object.freeze({
    /** Publishes one traced detached message and returns the native result unchanged. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: PublishOptions
    ): Promise<PublishResult> {
      return await tracer.startActiveSpan(
        `likego.broker publish ${topic}`,
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            "likego.kind": "broker_publish",
            "likego.topic": topic
          }
        },
        async (span) => {
          try {
            const tracedMessage: BrokerMessage = {
              headers: injectHeaders(message.headers, propagator),
              body: message.body
            }
            const result =
              options === undefined
                ? await publish.call(broker, ctx, topic, tracedMessage)
                : await publish.call(broker, ctx, topic, tracedMessage, options)
            succeedSpan(span)
            return result
          } catch (value) {
            failSpan(span, ctx, value, "broker_error")
            throw value
          } finally {
            span.end()
          }
        }
      )
    },

    /** Subscribes through the native broker and traces each delivery under its extracted parent. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      if (typeof handler !== "function") throw new TypeError("broker handler must be a function")
      /** Runs one native event handler inside its extracted consumer span. */
      const tracedHandler = async function tracedHandler(
        eventContext: Context,
        event: BrokerEvent<NativeEvent>
      ): Promise<void> {
        const parent = extractHeaders(event.message.headers, propagator)
        await tracer.startActiveSpan(
          `likego.broker consume ${topic}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              "likego.kind": "broker_consume",
              "likego.topic": topic
            }
          },
          parent,
          async (span) => {
            try {
              await handler(eventContext, event)
              succeedSpan(span)
            } catch (value) {
              failSpan(span, eventContext, value, "application_error")
              throw value
            } finally {
              span.end()
            }
          }
        )
      }
      return options === undefined
        ? await subscribe.call(broker, ctx, topic, tracedHandler)
        : await subscribe.call(broker, ctx, topic, tracedHandler, options)
    },

    /** Returns the wrapped broker's stable diagnostic name through its original receiver. */
    string(): string {
      return string.call(broker)
    }
  })
}
