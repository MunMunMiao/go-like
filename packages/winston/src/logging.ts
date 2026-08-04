import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import type { CallOption, CallRequest, Client } from "@go-like/client"
import type { Context } from "@go-like/context"
import type { Middleware } from "@go-like/server"
import type { Infer, Struct } from "@go-like/struct"
import type { Endpoint, Message } from "@go-like/transport"
import { endpoint, request as service } from "@go-like/transport/headers"
import type { Handler as WebHandler } from "@go-like/web"
import type { Logger } from "winston"

type Outcome = "success" | "failure" | "canceled"
const errorTypePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const errorCodePattern = /^[A-Z0-9_.-]{1,64}$/
/** Calls one raw Client endpoint. */
type RawClientCall = (
  ctx: Context,
  request: CallRequest,
  ...options: readonly CallOption[]
) => Promise<Message>
/** Calls one runtime-erased typed Client endpoint. */
type UnknownTypedClientCall = (
  ctx: Context,
  endpoint: Endpoint,
  request: unknown,
  ...options: readonly CallOption[]
) => Promise<unknown>

interface CompletionRecord {
  component: "client" | "server" | "web" | "broker"
  operation: string
  outcome: Outcome
  durationMs: number
  httpStatus?: number
  errorType?: string
  errorCode?: string
}

/** Reads one bounded error identifier without exposing or trusting the complete failure object. */
function errorIdentifier(value: unknown, name: "name" | "code", pattern: RegExp): string | null {
  if (typeof value !== "object" || value === null) return null
  try {
    const identifier: unknown =
      name === "name" ? ("name" in value ? value.name : null) : "code" in value ? value.code : null
    return typeof identifier === "string" && pattern.test(identifier) ? identifier : null
  } catch {
    return null
  }
}

/** Validates only the native Winston methods used by request logging. */
function validateLogger(logger: Logger): void {
  const candidate: unknown = logger
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof logger.info !== "function" ||
    typeof logger.error !== "function"
  ) {
    throw new TypeError("request logging requires an official Winston Logger")
  }
}

/** Writes one best-effort native completion record without changing application outcomes. */
function writeCompletion(
  logger: Logger,
  component: CompletionRecord["component"],
  operation: string,
  outcome: Outcome,
  startedAt: number,
  httpStatus: number | null,
  failure: unknown
): void {
  const record: CompletionRecord = {
    component,
    operation,
    outcome,
    durationMs: performance.now() - startedAt
  }
  if (httpStatus !== null) record.httpStatus = httpStatus
  if (outcome === "failure") {
    const errorType = errorIdentifier(failure, "name", errorTypePattern)
    const errorCode = errorIdentifier(failure, "code", errorCodePattern)
    if (errorType !== null) record.errorType = errorType
    if (errorCode !== null) record.errorCode = errorCode
  }
  try {
    if (outcome === "failure") logger.error("go-like operation completed", record)
    else logger.info("go-like operation completed", record)
  } catch {
    // Observability must not replace the wrapped operation's result.
  }
}

/** Classifies one rejected Context-first operation without replacing its original failure. */
function contextFailureOutcome(ctx: Context): Outcome {
  try {
    if (ctx.err() !== null) return "canceled"
  } catch {
    // A hostile external Context cannot replace the wrapped operation's result.
  }
  return "failure"
}

/** Classifies one standard Web completion from its signal and response status. */
function webOutcome(signal: AbortSignal, failed: boolean): Outcome {
  if (signal.aborted) return "canceled"
  return failed ? "failure" : "success"
}

/** Reads one case-insensitive routing field without logging the remaining request headers. */
function routeField(headers: Readonly<Record<string, string>>, expected: string): string {
  const normalized = expected.toLowerCase()
  let found: string | null = null
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== normalized) continue
    if (found !== null) return "unknown"
    found = headers[name] ?? ""
  }
  return found === null || found.length === 0 ? "unknown" : found
}

/** Returns the stable unary service operation carried by go-like routing headers. */
function unaryOperation(message: Message): string {
  return `${routeField(message.header, service)}/${routeField(message.header, endpoint)}`
}

/** Distinguishes an asynchronous Web Handler without replacing synchronous responses. */
function isResponsePromise(value: Response | Promise<Response>): value is Promise<Response> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return "then" in value && typeof value.then === "function"
}

/** Distinguishes an asynchronous broker handler without replacing synchronous completion. */
function isPromiseLike(value: void | PromiseLike<void>): value is PromiseLike<void> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return "then" in value && typeof value.then === "function"
}

/** Creates one bounded diagnostic for a failed HTTP response without reading its body. */
function httpFailure(status: number): Error {
  return new Error(`HTTP response completed with status ${status}`)
}

/** Reports whether one runtime Client argument is a call option. */
function isCallOption(value: unknown): value is CallOption {
  return typeof value === "function"
}

/** Wraps one unary Client with one native Winston completion record per logical call. */
export function logClient(client: Client, logger: Logger): Client {
  const candidate: unknown = client
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof client.call !== "function" ||
    typeof client.close !== "function"
  ) {
    throw new TypeError("client must implement the go-like Client interface")
  }
  validateLogger(logger)
  const rawCall: RawClientCall = client.call
  const typedCall: UnknownTypedClientCall = client.call
  const close = client.close

  /** Logs one typed Client call. */
  function loggedCall<RequestStruct extends Struct, ResponseStruct extends Struct>(
    ctx: Context,
    endpoint: Endpoint<RequestStruct, ResponseStruct>,
    request: NoInfer<Infer<RequestStruct>>,
    ...options: readonly CallOption[]
  ): Promise<Infer<ResponseStruct>>

  /** Logs one raw Client call. */
  function loggedCall(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[]
  ): Promise<Message>

  /** Logs either public Client call overload through the original receiver. */
  async function loggedCall(
    ctx: Context,
    subject: CallRequest | Endpoint,
    _first?: unknown
  ): Promise<unknown> {
    const values: unknown[] = []
    for (let index = 2; index < arguments.length; index += 1) {
      values.push(arguments[index])
    }
    const startedAt = performance.now()
    try {
      let response: unknown
      if ("message" in subject) {
        const argumentsList: [Context, CallRequest, ...CallOption[]] = [ctx, subject]
        for (const value of values) {
          if (!isCallOption(value)) throw new TypeError("Client call option must be a function")
          argumentsList.push(value)
        }
        response = await rawCall.apply(client, argumentsList)
      } else {
        if (values.length === 0) throw new TypeError("Client typed call requires a request value")
        const argumentsList: [Context, Endpoint, unknown, ...CallOption[]] = [
          ctx,
          subject,
          values[0]
        ]
        for (let index = 1; index < values.length; index += 1) {
          const value = values[index]
          if (!isCallOption(value)) throw new TypeError("Client call option must be a function")
          argumentsList.push(value)
        }
        response = await typedCall.apply(client, argumentsList)
      }
      writeCompletion(
        logger,
        "client",
        `${subject.service}/${subject.endpoint}`,
        "success",
        startedAt,
        null,
        null
      )
      return response
    } catch (value) {
      const outcome = contextFailureOutcome(ctx)
      writeCompletion(
        logger,
        "client",
        `${subject.service}/${subject.endpoint}`,
        outcome,
        startedAt,
        null,
        value
      )
      throw value
    }
  }

  return Object.freeze({
    call: loggedCall,
    /** Closes the wrapped Client through its original receiver without inventing a log operation. */
    close(ctx: Context): Promise<void> {
      return close.call(client, ctx)
    }
  })
}

/** Creates unary Server middleware that logs one completed routed operation. */
export function logUnaryMiddleware(logger: Logger): Middleware {
  validateLogger(logger)
  return (next) => {
    if (typeof next !== "function") throw new TypeError("unary handler must be a function")
    return async (ctx, message) => {
      const operation = unaryOperation(message)
      const startedAt = performance.now()
      try {
        const response = await next(ctx, message)
        writeCompletion(logger, "server", operation, "success", startedAt, null, null)
        return response
      } catch (value) {
        const outcome = contextFailureOutcome(ctx)
        writeCompletion(logger, "server", operation, outcome, startedAt, null, value)
        throw value
      }
    }
  }
}

/** Wraps one standard Web Handler while preserving its synchronous or asynchronous result shape. */
export function logWebHandler(handler: WebHandler, logger: Logger): WebHandler {
  if (typeof handler !== "function") throw new TypeError("Web handler must be a function")
  validateLogger(logger)
  const captured = handler

  return function loggedWebHandler(request: Request): Response | Promise<Response> {
    const startedAt = performance.now()
    try {
      const result = captured(request)
      if (isResponsePromise(result)) {
        return result.then(
          (response) => {
            const failed = response.status >= 500
            writeCompletion(
              logger,
              "web",
              request.method,
              webOutcome(request.signal, failed),
              startedAt,
              response.status,
              failed ? httpFailure(response.status) : null
            )
            return response
          },
          (value: unknown) => {
            const outcome = webOutcome(request.signal, true)
            writeCompletion(logger, "web", request.method, outcome, startedAt, null, value)
            throw value
          }
        )
      }
      const failed = result.status >= 500
      writeCompletion(
        logger,
        "web",
        request.method,
        webOutcome(request.signal, failed),
        startedAt,
        result.status,
        failed ? httpFailure(result.status) : null
      )
      return result
    } catch (value) {
      const outcome = webOutcome(request.signal, true)
      writeCompletion(logger, "web", request.method, outcome, startedAt, null, value)
      throw value
    }
  }
}

/** Wraps one structural Broker without taking ownership of its connection or subscriptions. */
export function logBroker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>(
  broker: Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent>,
  logger: Logger
): Broker<PublishOptions, PublishResult, SubscribeOptions, NativeEvent> {
  const candidate: unknown = broker
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof broker.publish !== "function" ||
    typeof broker.subscribe !== "function" ||
    typeof broker.string !== "function"
  ) {
    throw new TypeError("broker must implement the go-like Broker interface")
  }
  validateLogger(logger)
  const publish = broker.publish
  const subscribe = broker.subscribe
  const string = broker.string

  return Object.freeze({
    /** Logs one native publish completion and returns its provider result unchanged. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: PublishOptions
    ): Promise<PublishResult> {
      const startedAt = performance.now()
      try {
        const result =
          options === undefined
            ? await publish.call(broker, ctx, topic, message)
            : await publish.call(broker, ctx, topic, message, options)
        writeCompletion(logger, "broker", `publish ${topic}`, "success", startedAt, null, null)
        return result
      } catch (value) {
        const outcome = contextFailureOutcome(ctx)
        writeCompletion(logger, "broker", `publish ${topic}`, outcome, startedAt, null, value)
        throw value
      }
    },

    /** Logs each delivery completion while returning the native Subscriber unchanged. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      if (typeof handler !== "function") throw new TypeError("broker handler must be a function")

      /** Preserves synchronous broker handlers and awaits asynchronous handler completion. */
      function loggedHandler(
        eventContext: Context,
        event: BrokerEvent<NativeEvent>
      ): void | PromiseLike<void> {
        const startedAt = performance.now()
        try {
          const result = handler(eventContext, event)
          if (isPromiseLike(result)) {
            return Promise.resolve(result).then(
              () => {
                writeCompletion(
                  logger,
                  "broker",
                  `consume ${topic}`,
                  "success",
                  startedAt,
                  null,
                  null
                )
              },
              (value: unknown) => {
                const outcome = contextFailureOutcome(eventContext)
                writeCompletion(
                  logger,
                  "broker",
                  `consume ${topic}`,
                  outcome,
                  startedAt,
                  null,
                  value
                )
                throw value
              }
            )
          }
          writeCompletion(logger, "broker", `consume ${topic}`, "success", startedAt, null, null)
        } catch (value) {
          const outcome = contextFailureOutcome(eventContext)
          writeCompletion(logger, "broker", `consume ${topic}`, outcome, startedAt, null, value)
          throw value
        }
      }

      return options === undefined
        ? await subscribe.call(broker, ctx, topic, loggedHandler)
        : await subscribe.call(broker, ctx, topic, loggedHandler, options)
    },

    /** Preserves the wrapped broker's diagnostic receiver. */
    string(): string {
      return string.call(broker)
    }
  })
}
