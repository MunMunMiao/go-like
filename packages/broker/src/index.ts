import { background, cause, type Context } from "@likego/context"
import type { Server } from "@likego/core"
import { waitForContext } from "@likego/core/lifecycle"
import { subscriberTerminal } from "@likego/broker/provider"

/** Describes one immutable broker payload at the portable bytes boundary. */
export interface BrokerMessage {
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

/** Preserves the provider's native delivery object without inventing settlement methods. */
export interface BrokerEvent<Native> {
  readonly topic: string
  readonly message: BrokerMessage
  readonly native: Native
}

/** Owns exactly one provider subscription through the go-micro Subscriber contract. */
export interface Subscriber {
  readonly topic: string
  /** Stops this subscription without closing the borrowed Broker connection. */
  unsubscribe(ctx: Context): Promise<void>
}

/** Defines the provider-neutral publish and subscribe byte contract. */
export interface Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent> {
  /** Publishes one detached byte message under the caller-owned Context. */
  publish(
    ctx: Context,
    topic: string,
    message: BrokerMessage,
    options?: PublishOptions
  ): Promise<PublishResult>

  /** Opens one topic subscription and returns its owner handle. */
  subscribe(
    ctx: Context,
    topic: string,
    handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>,
    options?: SubscribeOptions
  ): Promise<Subscriber>

  /** Returns one stable provider diagnostic name. */
  string(): string
}

/** Returns the caller's exact Context cancellation cause when terminal. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Preserves Error identity while normalizing invalid provider rejection values. */
function normalizeFailure(operation: string, value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(`subscription ${operation} rejected with a non-Error value`, { cause: value })
}

/** Reports whether a string contains no unpaired UTF-16 surrogate code units. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const following = value.charCodeAt(index + 1)
      if (following < 0xdc00 || following > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/**
 * Adapts one subscription into the Core Server lifecycle without owning the subscriber
 * connection or inventing native acknowledgement semantics.
 */
export function newBrokerServer<Event, Options>(
  broker: {
    subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: Event) => void | PromiseLike<void>,
      options?: Options
    ): Promise<Subscriber>
  },
  topic: string,
  handler: (ctx: Context, event: Event) => void | PromiseLike<void>,
  options?: Options
): Server {
  if (broker === null || typeof broker !== "object") {
    throw new TypeError("broker must be an object")
  }
  const subscribe = broker.subscribe
  if (typeof subscribe !== "function") throw new TypeError("broker subscribe must be callable")
  if (typeof topic !== "string" || topic.length === 0 || !isWellFormed(topic)) {
    throw new TypeError("subscription topic must be a non-empty well-formed string")
  }
  if (typeof handler !== "function") throw new TypeError("subscription handler must be callable")
  let state: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed" = "idle"
  let unsubscribeReceiver: object | null = null
  let unsubscribeMethod: ((ctx: Context) => Promise<void>) | null = null
  let admission: Promise<void> | null = null
  let ownerStop: Promise<void> | null = null
  let settleRuntime: ((failure: Error | null) => void) | null = null
  const runtime = new Promise<void>((resolve, reject) => {
    settleRuntime = (failure) => {
      settleRuntime = null
      if (failure === null) resolve()
      else reject(failure)
    }
  })
  void runtime.catch(() => {})

  /** Settles the single Server runtime at most once. */
  function settle(failure: Error | null): void {
    settleRuntime?.(failure)
  }

  /** Takes and invokes the captured provider owner operation at most once. */
  async function releaseOwner(): Promise<void> {
    const receiver = unsubscribeReceiver
    const unsubscribe = unsubscribeMethod
    if (receiver === null || unsubscribe === null) return
    unsubscribeReceiver = null
    unsubscribeMethod = null
    await Reflect.apply(unsubscribe, receiver, [background()])
  }

  /** Rejects one invalid admission after releasing any captured provider owner. */
  async function rejectAfterRollback(primary: Error): Promise<never> {
    try {
      await releaseOwner()
    } catch (value) {
      const rollback = normalizeFailure("unsubscribe", value)
      throw new AggregateError(
        [primary, rollback],
        "broker subscription admission and rollback failed",
        { cause: primary }
      )
    }
    throw primary
  }

  /** Captures ownership before validating provider-controlled subscription metadata. */
  async function acceptSubscription(value: Subscriber): Promise<void> {
    if (value === null || typeof value !== "object") {
      throw new TypeError("broker subscribe must return a Subscriber")
    }
    let unsubscribe: unknown
    try {
      unsubscribe = Reflect.get(value, "unsubscribe")
    } catch (failure) {
      throw normalizeFailure("admission", failure)
    }
    if (typeof unsubscribe !== "function") {
      throw new TypeError("broker subscribe must return a Subscriber")
    }
    unsubscribeReceiver = value
    unsubscribeMethod = unsubscribe as (ctx: Context) => Promise<void>

    let returnedTopic: unknown
    try {
      returnedTopic = Reflect.get(value, "topic")
    } catch (failure) {
      return await rejectAfterRollback(normalizeFailure("admission", failure))
    }
    if (typeof returnedTopic !== "string") {
      return await rejectAfterRollback(new TypeError("broker subscribe must return a Subscriber"))
    }
    if (returnedTopic !== topic) {
      return await rejectAfterRollback(
        new TypeError("broker subscribe returned a Subscriber for a different topic")
      )
    }

    const accepted = value
    if (state === "starting") state = "running"
    const terminal = subscriberTerminal(accepted)
    if (terminal !== null) {
      void terminal.then(
        () => {
          if (state !== "running") return
          const exit = new Error("broker subscription terminated outside its owner stop")
          state = "failed"
          settle(exit)
        },
        (value: unknown) => {
          if (state !== "running") return
          state = "failed"
          settle(normalizeFailure("terminal", value))
        }
      )
    }
  }

  /** Starts or joins the single provider unsubscribe operation. */
  function beginStop(): Promise<void> {
    if (ownerStop !== null) return ownerStop
    if (state === "idle") return Promise.resolve()
    const admitted = admission
    if (admitted === null) return runtime
    state = "stopping"
    ownerStop = admitted.then(
      async () => {
        try {
          await releaseOwner()
          state = "stopped"
          settle(null)
        } catch (value) {
          const failure = normalizeFailure("unsubscribe", value)
          state = "failed"
          settle(failure)
          throw failure
        }
      },
      (failure: unknown) => {
        state = "failed"
        throw failure
      }
    )
    void ownerStop.catch(() => {})
    return ownerStop
  }

  return Object.freeze({
    /** Opens the captured provider subscription once and remains pending for its full runtime. */
    start(ctx: Context): Promise<void> {
      if (state !== "idle")
        return Promise.reject(new Error("subscription Server has already started"))
      state = "starting"
      let failure: Error | null
      try {
        failure = contextFailure(ctx)
      } catch (value) {
        failure = normalizeFailure("startup", value)
      }
      if (failure !== null) {
        state = "failed"
        settle(failure)
        return runtime
      }
      let supplied: Promise<Subscriber>
      try {
        supplied = Promise.resolve(
          options === undefined
            ? subscribe.call(broker, ctx, topic, handler)
            : subscribe.call(broker, ctx, topic, handler, options)
        )
      } catch (value) {
        supplied = Promise.reject(normalizeFailure("subscribe", value))
      }
      admission = supplied.then(acceptSubscription).catch((value: unknown) => {
        const admissionFailure = normalizeFailure("subscribe", value)
        state = "failed"
        settle(admissionFailure)
        throw admissionFailure
      })
      void admission.catch(() => {})
      const running = admission.then(() => runtime)
      void running.catch(() => {})
      return running
    },
    /** Unsubscribes the accepted provider subscription while bounding only this caller's wait. */
    stop(ctx: Context): Promise<void> {
      return waitForContext(ctx, beginStop())
    }
  })
}
