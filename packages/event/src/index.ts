import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import type { Context } from "@go-like/context"

/** Converts one typed value to and from its portable byte representation. */
export interface Codec<T> {
  readonly mediaType: string
  encode(value: T): Uint8Array
  decode(bytes: Uint8Array): T
}

/** Publishes typed values through one explicit codec. */
export interface EventPublisher<T, Options, Result> {
  /** Encodes and publishes one value under the caller-owned Context. */
  publish(ctx: Context, topic: string, value: T, options?: Options): Promise<Result>
}

/** Exposes native delivery identity while keeping decode explicit and lazy. */
export interface EventMessage<T, Native> {
  readonly topic: string
  readonly native: Native
  /** Decodes one fresh defensive copy of the delivered bytes. */
  decode(): T
}

/** Combines typed publish and subscribe over the same explicit codec. */
export interface EventBroker<
  T,
  PublishOptions,
  PublishResult,
  SubscribeOptions,
  Native
> extends EventPublisher<T, PublishOptions, PublishResult> {
  /** Opens one typed subscription and returns the underlying provider handle. */
  subscribe(
    ctx: Context,
    topic: string,
    handler: (ctx: Context, event: EventMessage<T, Native>) => void | PromiseLike<void>,
    options?: SubscribeOptions
  ): Promise<Subscriber>
}

interface CapturedCodec<T> {
  readonly receiver: Codec<T>
  readonly mediaType: string
  readonly encode: Codec<T>["encode"]
  readonly decode: Codec<T>["decode"]
}

/** Captures one stable codec capability and rejects later method replacement. */
function captureCodec<T>(codec: Codec<T>): CapturedCodec<T> {
  if (codec === null || typeof codec !== "object")
    throw new TypeError("event codec must be an object")
  const mediaType = codec.mediaType
  const encode = codec.encode
  const decode = codec.decode
  if (typeof mediaType !== "string" || mediaType.length === 0) {
    throw new TypeError("event codec mediaType must be non-empty")
  }
  if (typeof encode !== "function" || typeof decode !== "function") {
    throw new TypeError("event codec encode and decode must be callable")
  }
  return Object.freeze({ receiver: codec, mediaType, encode, decode })
}

/** Creates a broker message whose body getter returns one fresh defensive copy. */
function encodedMessage<T>(codec: CapturedCodec<T>, value: T): BrokerMessage {
  const encoded = codec.encode.call(codec.receiver, value)
  if (!(encoded instanceof Uint8Array)) {
    throw new TypeError("event codec encode must return Uint8Array")
  }
  const body = new Uint8Array(encoded)
  const headers = Object.freeze({ "content-type": codec.mediaType })
  return Object.freeze({
    headers,
    /** Returns one caller-owned view so a provider cannot mutate retained event bytes. */
    get body(): Uint8Array {
      return new Uint8Array(body)
    }
  })
}

/** Creates one frozen lazy event while preserving the native delivery identity. */
function decodedMessage<T, Native>(
  codec: CapturedCodec<T>,
  event: BrokerEvent<Native>
): EventMessage<T, Native> {
  if (event === null || typeof event !== "object")
    throw new TypeError("broker event must be an object")
  const topic = event.topic
  const message = event.message
  if (typeof topic !== "string" || message === null || typeof message !== "object") {
    throw new TypeError("broker event topic and message are invalid")
  }
  const headers = message.headers
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("broker event headers must be an object")
  }
  const mediaTypes = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "content-type")
    .map(([, value]) => value)
  const suppliedBody = message.body
  if (!(suppliedBody instanceof Uint8Array)) {
    throw new TypeError("broker event body must be Uint8Array")
  }
  const body = new Uint8Array(suppliedBody)
  const native = event.native
  return Object.freeze({
    topic,
    native,
    /** Lazily decodes a fresh byte copy and leaves native settlement to the application. */
    decode(): T {
      if (mediaTypes.length !== 1 || mediaTypes[0] !== codec.mediaType) {
        throw new TypeError(`broker event content-type must be exactly ${codec.mediaType}`)
      }
      return codec.decode.call(codec.receiver, new Uint8Array(body))
    }
  })
}

/** Wraps one byte Broker with typed codec publish and lazy subscribe behavior. */
export function eventBroker<T, PublishOptions, PublishResult, SubscribeOptions, Native>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, Native>,
  codec: Codec<T>
): EventBroker<T, PublishOptions, PublishResult, SubscribeOptions, Native> {
  if (broker === null || typeof broker !== "object") throw new TypeError("broker must be an object")
  const publish = broker.publish
  const subscribe = broker.subscribe
  if (typeof publish !== "function" || typeof subscribe !== "function") {
    throw new TypeError("broker publish and subscribe must be callable")
  }
  const capturedCodec = captureCodec(codec)

  return Object.freeze({
    /** Encodes detached bytes once and delegates publish without owning the broker connection. */
    async publish(
      ctx: Context,
      topic: string,
      value: T,
      options?: PublishOptions
    ): Promise<PublishResult> {
      const message = encodedMessage(capturedCodec, value)
      return options === undefined
        ? await publish.call(broker, ctx, topic, message)
        : await publish.call(broker, ctx, topic, message, options)
    },
    /** Wraps delivery with a lazy decoder and returns the exact native subscription owner. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: EventMessage<T, Native>) => void | PromiseLike<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      if (typeof handler !== "function") throw new TypeError("event handler must be callable")
      /** Preserves Context and native identity while delaying codec work until decode(). */
      function receive(deliveryCtx: Context, event: BrokerEvent<Native>): void | PromiseLike<void> {
        return handler(deliveryCtx, decodedMessage(capturedCodec, event))
      }
      return options === undefined
        ? await subscribe.call(broker, ctx, topic, receive)
        : await subscribe.call(broker, ctx, topic, receive, options)
    }
  })
}
