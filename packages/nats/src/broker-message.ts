import type { BrokerEvent, BrokerMessage } from "@go-like/broker"
import { cause, type Context } from "@go-like/context"
import { headers, type MsgHdrs } from "@nats-io/transport-node"

/** Describes the official message fields shared by NATS Core and JetStream. */
export interface NativeNatsMessage {
  readonly subject: string
  readonly data: Uint8Array
  readonly headers?: MsgHdrs | undefined
}

/** Contains one detached payload and optional official NATS headers. */
export interface PreparedBrokerMessage {
  readonly body: Uint8Array
  readonly headers: MsgHdrs | null
}

/** Returns the caller's exact Context cancellation cause when terminal. */
export function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
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

/** Validates the portable topic boundary before any native NATS I/O. */
export function validateTopic(topic: string): void {
  if (typeof topic !== "string" || topic.length === 0 || !isWellFormed(topic)) {
    throw new TypeError("NATS Broker topic must be a non-empty well-formed string")
  }
}

/** Converts immutable portable headers into one new official NATS header collection. */
function nativeHeaders(source: Readonly<Record<string, string>>): MsgHdrs | null {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TypeError("NATS Broker message headers must be an object")
  }
  const names = Object.keys(source)
  if (names.length === 0) return null
  const result = headers()
  for (const name of names) {
    const value = source[name]
    if (
      name.length === 0 ||
      !isWellFormed(name) ||
      typeof value !== "string" ||
      !isWellFormed(value)
    ) {
      throw new TypeError("NATS Broker message headers must contain well-formed string entries")
    }
    result.set(name, value)
  }
  return result
}

/** Validates and detaches one portable message before any native publish call. */
export function prepareBrokerMessage(message: BrokerMessage): PreparedBrokerMessage {
  if (typeof message !== "object" || message === null) {
    throw new TypeError("NATS Broker message must be an object")
  }
  const body = message.body
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("NATS Broker message body must be Uint8Array")
  }
  const prepared = Object.freeze({
    body: new Uint8Array(body),
    headers: nativeHeaders(message.headers)
  })
  return prepared
}

/** Copies official NATS headers into one frozen single-value portable record. */
function portableHeaders(source: MsgHdrs | undefined): Readonly<Record<string, string>> {
  const entries: Array<[string, string]> = []
  if (source !== undefined) {
    for (const name of source.keys()) entries.push([name, source.last(name)])
  }
  return Object.freeze(Object.fromEntries(entries))
}

/** Converts one official native delivery without hiding its settlement surface. */
export function brokerEvent<Native extends NativeNatsMessage>(native: Native): BrokerEvent<Native> {
  if (typeof native !== "object" || native === null) {
    throw new TypeError("NATS Broker delivery must be an object")
  }
  validateTopic(native.subject)
  if (!(native.data instanceof Uint8Array)) {
    throw new TypeError("NATS Broker delivery data must be Uint8Array")
  }
  const body = new Uint8Array(native.data)
  const message = Object.freeze({
    headers: portableHeaders(native.headers),
    /** Returns one fresh copy so handlers cannot mutate retained delivery bytes. */
    get body(): Uint8Array {
      return new Uint8Array(body)
    }
  })
  return Object.freeze({ topic: native.subject, message, native })
}
