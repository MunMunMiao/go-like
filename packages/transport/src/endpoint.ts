/** Converts one typed value to and from a transport body. */
export interface BodyCodec<T> {
  /** Declares the media type carried by encoded Messages. */
  readonly contentType: string
  /** Encodes one typed value. */
  readonly encode: (value: T) => Uint8Array | PromiseLike<Uint8Array>
  /** Decodes and validates one body. */
  readonly decode: (body: Uint8Array) => T | PromiseLike<T>
}

/** Describes one typed internal unary endpoint without prescribing an IDL. */
export interface Endpoint<Request, Response> {
  readonly service: string
  readonly endpoint: string
  readonly requestCodec: BodyCodec<Request>
  readonly responseCodec: BodyCodec<Response>
}

/** Reports whether one string contains only complete UTF-16 scalar sequences. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Validates one non-empty endpoint field. */
function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormed(value)) {
    throw new TypeError(`transport endpoint ${field} must be a non-empty well-formed string`)
  }
  return value
}

/** Validates one unambiguous service or endpoint route token. */
function routeToken(value: string, field: string): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/u.test(value) || /[/*]/u.test(value)) {
    throw new TypeError(`transport endpoint ${field} must be a visible ASCII route token`)
  }
  return value
}

/** Captures one structural body codec without retaining mutable methods. */
function snapshotCodec<T>(value: BodyCodec<T>, field: string): BodyCodec<T> {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.encode !== "function" ||
    typeof value.decode !== "function"
  ) {
    throw new TypeError(`transport endpoint ${field} must implement BodyCodec`)
  }
  const receiver = value
  const encode = value.encode
  const decode = value.decode
  const contentType = requiredText(value.contentType, `${field}.contentType`)

  /** Calls the captured encoder with its original receiver. */
  function encodeBody(input: T): Uint8Array | PromiseLike<Uint8Array> {
    return encode.call(receiver, input)
  }

  /** Calls the captured decoder with a detached body. */
  function decodeBody(body: Uint8Array): T | PromiseLike<T> {
    return decode.call(receiver, body.slice())
  }

  return Object.freeze({ contentType, encode: encodeBody, decode: decodeBody })
}

/** Creates one immutable typed unary endpoint contract. */
export function endpoint<Request, Response>(
  service: string,
  name: string,
  requestCodec: BodyCodec<Request>,
  responseCodec: BodyCodec<Response>
): Endpoint<Request, Response> {
  return Object.freeze({
    service: routeToken(service, "service"),
    endpoint: routeToken(name, "endpoint"),
    requestCodec: snapshotCodec(requestCodec, "requestCodec"),
    responseCodec: snapshotCodec(responseCodec, "responseCodec")
  })
}
