import { withCancel, type Context } from "../context/index"
import { coreInstance } from "../internal/instance"
import { markDetachedRecord } from "../telemetry/internal/carriers"
import { beginUnit, injectRecord } from "../telemetry/provider"
import type { BrokerEvent, BrokerHandler, BrokerMessage, Subscriber } from "./index"

void coreInstance.version

const terminals = new WeakMap<Subscriber, Promise<void>>()

/** Associates one stable provider terminal with an upstream-style Subscriber. */
export function registerSubscriberTerminal(
  subscriber: Subscriber,
  terminal: Promise<void>
): Subscriber {
  if (typeof subscriber !== "object" || subscriber === null) {
    throw new TypeError("broker provider Subscriber must be an object")
  }
  if (typeof terminal !== "object" || terminal === null || typeof terminal.then !== "function") {
    throw new TypeError("broker provider terminal must be a Promise")
  }
  const retained = Promise.resolve(terminal)
  void retained.catch(() => {})
  terminals.set(subscriber, retained)
  return subscriber
}

/** Returns a provider terminal without adding it to the public Subscriber contract. */
export function subscriberTerminal(subscriber: Subscriber): Promise<void> | null {
  return terminals.get(subscriber) ?? null
}

/** Validates one portable topic and returns it unchanged. */
export function brokerTopic(topic: string): string {
  if (typeof topic !== "string" || topic.length === 0 || !topic.isWellFormed()) {
    throw new TypeError("broker topic must be a non-empty well-formed string")
  }
  return topic
}

/** Copies bytes so a later write to the caller's view cannot change the snapshot. */
function copyBytes(body: Uint8Array): Uint8Array {
  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy
}

/** Defines one own header on a null-prototype record. */
function defineHeader(target: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false
  })
}

/** Copies own well-formed header entries and freezes the record. */
function snapshotHeaders(
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new TypeError("broker message headers must be an object")
  }
  const copy: Record<string, string> = Object.create(null) as Record<string, string>
  for (const name of Object.keys(headers)) {
    const value = headers[name]
    if (
      name.length === 0 ||
      !name.isWellFormed() ||
      typeof value !== "string" ||
      !value.isWellFormed()
    ) {
      throw new TypeError("broker message headers must contain well-formed string entries")
    }
    defineHeader(copy, name, value)
  }
  const frozen = Object.freeze(copy)
  markDetachedRecord(frozen)
  return frozen
}

/** Validates a message and returns a detached frozen copy. Each body read is a new copy. */
export function snapshotBrokerMessage(message: BrokerMessage): BrokerMessage {
  if (typeof message !== "object" || message === null) {
    throw new TypeError("broker message must be an object")
  }
  if (!(message.body instanceof Uint8Array)) {
    throw new TypeError("broker message body must be Uint8Array")
  }
  const stored = copyBytes(message.body)
  const headers = snapshotHeaders(message.headers)
  return Object.freeze({
    headers,
    /** Returns one fresh view of the detached payload. */
    get body(): Uint8Array {
      return new Uint8Array(stored)
    }
  })
}

/** Builds one frozen delivery. `native` keeps its identity and `body` copies on every read. */
export function newBrokerEvent<Native>(
  topic: string,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
  native: Native
): BrokerEvent<Native> {
  const selected = brokerTopic(topic)
  if (!(body instanceof Uint8Array)) throw new TypeError("broker message body must be Uint8Array")
  const stored = copyBytes(body)
  const frozenHeaders = snapshotHeaders(headers)
  return Object.freeze({
    topic: selected,
    native,
    message: Object.freeze({
      headers: frozenHeaders,
      /** Returns one fresh view so a handler cannot mutate retained bytes. */
      get body(): Uint8Array {
        return new Uint8Array(stored)
      }
    })
  })
}

/** Replaces caller propagation fields with the unit context's carrier. */
function tracedMessage(ctx: Context, message: BrokerMessage): BrokerMessage {
  const headers = injectRecord(ctx, message.headers)
  const stored = copyBytes(message.body)
  return Object.freeze({
    headers,
    /** Returns one fresh view of the bytes handed to the provider send. */
    get body(): Uint8Array {
      return new Uint8Array(stored)
    }
  })
}

/**
 * Runs one delivery in a fresh child of `subscriptionCtx` and a `process {subscription}` unit.
 * The child is canceled after the handler settles. Failures are rethrown unchanged.
 */
export async function deliver<Native>(
  subscriptionCtx: Context,
  system: string,
  subscription: string,
  event: BrokerEvent<Native>,
  handler: BrokerHandler<Native>
): Promise<void> {
  const [delivery, cancel] = withCancel(subscriptionCtx)
  const unit = beginUnit(
    delivery,
    {
      kind: "messaging.process",
      system,
      subscription,
      destination: event.topic,
      bodySize: event.message.body.byteLength
    },
    event.message.headers
  )
  try {
    await unit.run((ctx) => Promise.resolve(handler(ctx, event)))
    unit.end()
  } catch (error) {
    unit.end({ error })
    throw error
  } finally {
    cancel()
  }
}

/**
 * Runs `send` inside a `publish` unit.
 * `send` receives a detached message whose propagation fields come from the unit context.
 */
export async function publish<Result>(
  ctx: Context,
  system: string,
  topic: string,
  message: BrokerMessage,
  send: (ctx: Context, message: BrokerMessage) => Promise<Result>
): Promise<Result> {
  const unit = beginUnit(ctx, {
    kind: "messaging.publish",
    system,
    destination: topic,
    bodySize: message.body.byteLength
  })
  try {
    const result = await unit.run((unitCtx) => send(unitCtx, tracedMessage(unitCtx, message)))
    unit.end()
    return result
  } catch (error) {
    unit.end({ error })
    throw error
  }
}
