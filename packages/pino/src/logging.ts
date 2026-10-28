import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@go-like/broker"
import type { CallOption, CallRequest, Client } from "@go-like/client"
import type { Context } from "@go-like/context"
import type { Middleware } from "@go-like/server"
import type { Infer, Struct } from "@go-like/struct"
import {
  fromServerContext,
  observeResponseBody,
  type Endpoint,
  type ResponseBodyEnd,
  type ServerStream
} from "@go-like/transport"
import { observeCall } from "@go-like/transport/provider"
import type { Logger } from "pino"

type Outcome = "success" | "failure" | "canceled"
/** Handles one standard Web request without a framework-specific contract. */
type WebHandler = (request: Request) => Response | Promise<Response>
/** Calls one raw Client endpoint. */
type RawClientCall = (
  ctx: Context,
  request: CallRequest,
  ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
) => Promise<Response>
/** Calls one runtime-erased typed Client endpoint. */
type UnknownTypedClientCall = (
  ctx: Context,
  endpoint: Endpoint,
  request: unknown,
  ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
) => Promise<unknown>

const completionMessage = "go-like operation completed"
const errorTypePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const errorCodePattern = /^[A-Z0-9_.-]{1,64}$/

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

/** Requires the two native Pino operations used by request logging. */
function loggerValue(logger: Logger): Logger {
  const candidate: unknown = logger
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof logger.info !== "function" ||
    typeof logger.error !== "function"
  ) {
    throw new TypeError("logger must implement the Pino Logger interface")
  }
  return logger
}

/** Returns the bounded completion classification for one Context-first operation. */
function contextOutcome(ctx: Context, failed: boolean): Outcome {
  if (!failed) return "success"
  try {
    return ctx.err() === null ? "failure" : "canceled"
  } catch {
    return "failure"
  }
}

/** Returns the bounded completion classification for one standard Web operation. */
function webOutcome(signal: AbortSignal, failed: boolean): Outcome {
  if (signal.aborted) return "canceled"
  return failed ? "failure" : "success"
}

/** Classifies one body-end or thrown completion without reading payloads. */
function observedOutcome(
  component: "client" | "server" | "web" | "broker",
  ctx: Context,
  end: ResponseBodyEnd | null,
  failure: unknown
): Outcome {
  if (failure !== null) return contextOutcome(ctx, true)
  if (end === null) return "success"
  if (end.reason === "cancel" || end.status.kind === "canceled") return "canceled"
  if (end.stream) return end.status.kind === "success" ? "success" : "failure"
  if (component === "web" && end.httpStatus >= 500) return "failure"
  return "success"
}

/** Writes one completion, adding stream counters only when the body was an event stream. */
function writeObserved(
  logger: Logger,
  component: "client" | "server" | "web" | "broker",
  operation: string,
  ctx: Context,
  startedAt: number,
  httpStatus: number | null,
  end: ResponseBodyEnd | null,
  failure: unknown
): void {
  const outcome = observedOutcome(component, ctx, end, failure)
  const diagnostic =
    failure ??
    (outcome === "failure" && end !== null && !end.stream ? httpFailure(end.httpStatus) : null)
  writeCompletion(logger, component, operation, outcome, startedAt, httpStatus, diagnostic, end)
}

/** Writes exactly one low-cardinality completion record through the native Logger receiver. */
function writeCompletion(
  logger: Logger,
  component: "client" | "server" | "web" | "broker",
  operation: string,
  outcome: Outcome,
  startedAt: number,
  httpStatus: number | null,
  failure: unknown,
  end: ResponseBodyEnd | null = null
): void {
  const record: Record<string, unknown> = {
    component,
    operation,
    outcome,
    durationMs: end?.durationMs ?? Math.max(0, performance.now() - startedAt)
  }
  if (httpStatus !== null) record.httpStatus = httpStatus
  if (end?.stream === true) {
    record.messageCount = end.messageCount
    record.handshakeMs = end.handshakeMs
    record.streamStatus = end.status.kind
    if (end.status.kind === "error") record.serviceCode = end.status.code
  }
  if (outcome === "failure") {
    const errorType = errorIdentifier(failure, "name", errorTypePattern)
    const errorCode = errorIdentifier(failure, "code", errorCodePattern)
    if (errorType !== null) record.errorType = errorType
    if (errorCode !== null) record.errorCode = errorCode
  }
  try {
    if (outcome === "failure") {
      logger.error(record, completionMessage)
      return
    }
    logger.info(record, completionMessage)
  } catch {
    // Observability must not replace the wrapped operation's result.
  }
}

/** Creates the server operation name from TransportInfo, never from request headers. */
function serverOperation(ctx: Context): string {
  let operation = ""
  try {
    const info = fromServerContext(ctx)
    if (info !== null) operation = info.operation()
  } catch {
    operation = ""
  }
  const slash = operation.indexOf("/")
  const service = slash < 0 ? operation : operation.slice(0, slash)
  const endpoint = slash < 0 ? "" : operation.slice(slash + 1)
  const serviceName = operation.length === 0 || service.length === 0 ? "unknown" : service
  const endpointName = operation.length === 0 || endpoint.length === 0 ? "unknown" : endpoint
  return `${serviceName}/${endpointName}`
}

/** Reports whether a Web handler result is asynchronous without changing its return mode. */
function isResponsePromise(value: Response | Promise<Response>): value is Promise<Response> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false
  return "then" in value && typeof value.then === "function"
}

/** Reports whether one broker handler result requires asynchronous completion observation. */
function isHandlerPromise(value: void | Promise<void>): value is Promise<void> {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  )
}

/** Creates one safe diagnostic for an HTTP failure without reading the response body. */
function httpFailure(status: number): Error {
  return new Error(`HTTP response completed with status ${status}`)
}

/** Reports whether one runtime Client argument is a call option. */
function isCallOption(value: unknown): value is CallOption {
  return typeof value === "function"
}

/** Wraps one unary Client with one completion record per logical call. */
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
  const selectedLogger = loggerValue(logger)
  const rawCall: RawClientCall = client.call
  const typedCall: UnknownTypedClientCall = client.call
  const close = client.close

  /** Logs one typed Client call. */
  function loggedCall<RequestStruct extends Struct, ResponseStruct extends Struct>(
    ctx: Context,
    endpoint: Endpoint<RequestStruct, ResponseStruct>,
    request: NoInfer<Infer<RequestStruct>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
  ): Promise<Infer<ResponseStruct>>

  /** Logs one raw Client call. */
  function loggedCall(
    ctx: Context,
    request: CallRequest,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
  ): Promise<Response>

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
    const operation = `${subject.service}/${subject.endpoint}`
    const startedAt = performance.now()
    return await observeCall(
      ctx,
      startedAt,
      async function invoke(observed: Context): Promise<unknown> {
        if ("headers" in subject && "body" in subject) {
          const arguments_: [Context, CallRequest, ...CallOption[]] = [observed, subject]
          for (const value of values) {
            if (!isCallOption(value)) throw new TypeError("Client call option must be a function")
            arguments_.push(value)
          }
          return await rawCall.apply(client, arguments_)
        }
        if (values.length === 0) throw new TypeError("Client typed call requires a request value")
        const arguments_: [Context, Endpoint, unknown, ...CallOption[]] = [
          observed,
          subject,
          values[0]
        ]
        for (let index = 1; index < values.length; index += 1) {
          const value = values[index]
          if (!isCallOption(value)) throw new TypeError("Client call option must be a function")
          arguments_.push(value)
        }
        return await typedCall.apply(client, arguments_)
      },
      function record(end, failure): void {
        writeObserved(selectedLogger, "client", operation, ctx, startedAt, null, end, failure)
      }
    )
  }

  /** Logs one server stream when its body ends. */
  async function loggedStream<RequestStruct extends Struct, ResponseStruct extends Struct>(
    ctx: Context,
    endpoint: Endpoint<RequestStruct, ResponseStruct, true>,
    request: NoInfer<Infer<RequestStruct>>,
    ...options: readonly CallOption[] /* go-like-typed-rest: preserves the Client call ABI. */
  ): Promise<ServerStream<Infer<ResponseStruct>>> {
    if (typeof client.stream !== "function") throw new TypeError("client must implement stream")
    const operation = `${endpoint.service}/${endpoint.endpoint}`
    const startedAt = performance.now()
    return (await observeCall(
      ctx,
      startedAt,
      function invoke(observed: Context): Promise<unknown> {
        const args: [
          Context,
          Endpoint<RequestStruct, ResponseStruct, true>,
          NoInfer<Infer<RequestStruct>>,
          ...CallOption[]
        ] = [observed, endpoint, request, ...options]
        return client.stream!.apply(client, args)
      },
      function record(end, failure): void {
        writeObserved(selectedLogger, "client", operation, ctx, startedAt, null, end, failure)
      }
    )) as ServerStream<Infer<ResponseStruct>>
  }

  return Object.freeze({
    call: loggedCall,
    stream: loggedStream,
    /** Closes the native Client through its original receiver without creating a log operation. */
    close(ctx: Context): Promise<void> {
      return close.call(client, ctx)
    }
  })
}

/** Creates one unary Server middleware with one completion record per handler execution. */
export function logUnaryMiddleware(logger: Logger): Middleware {
  const selectedLogger = loggerValue(logger)
  return (next) => {
    if (typeof next !== "function") throw new TypeError("unary handler must be a function")
    return async (ctx, request) => {
      const operation = serverOperation(ctx)
      const startedAt = performance.now()
      try {
        const result = await next(ctx, request)
        if (!(result instanceof Response)) {
          writeObserved(selectedLogger, "server", operation, ctx, startedAt, null, null, null)
          return result
        }
        return observeResponseBody(
          result,
          function ended(end: ResponseBodyEnd): void {
            writeObserved(selectedLogger, "server", operation, ctx, startedAt, null, end, null)
          },
          { startedAt }
        )
      } catch (value) {
        writeObserved(selectedLogger, "server", operation, ctx, startedAt, null, null, value)
        throw value
      }
    }
  }
}

/** Completes one Web response when its body ends, preserving a null body. */
function completeWebResponse(
  logger: Logger,
  request: Request,
  operation: string,
  startedAt: number,
  response: Response
): Response {
  return observeResponseBody(
    response,
    function ended(end: ResponseBodyEnd): void {
      const canceled =
        request.signal.aborted || end.reason === "cancel" || end.status.kind === "canceled"
      const failed =
        !canceled && (end.stream ? end.status.kind !== "success" : response.status >= 500)
      const outcome: Outcome = canceled ? "canceled" : failed ? "failure" : "success"
      writeCompletion(
        logger,
        "web",
        operation,
        outcome,
        startedAt,
        response.status,
        failed && !end.stream ? httpFailure(response.status) : null,
        end
      )
    },
    { startedAt }
  )
}

/** Logs one thrown Web operation and rethrows the exact original value. */
function failWebRequest(
  logger: Logger,
  request: Request,
  operation: string,
  startedAt: number,
  value: unknown
): never {
  writeCompletion(
    logger,
    "web",
    operation,
    webOutcome(request.signal, true),
    startedAt,
    null,
    value
  )
  throw value
}

/** Wraps one standard Web handler without reading request or response payloads. */
export function logWebHandler(handler: WebHandler, logger: Logger): WebHandler {
  if (typeof handler !== "function") throw new TypeError("Web handler must be a function")
  const selectedLogger = loggerValue(logger)
  const captured = handler

  return /** Preserves the wrapped handler's synchronous or asynchronous return mode. */ function loggedWebHandler(
    request: Request
  ): Response | Promise<Response> {
    const operation = request.method
    const startedAt = performance.now()
    try {
      const result = captured(request)
      if (isResponsePromise(result)) {
        return result.then(
          (response) =>
            completeWebResponse(selectedLogger, request, operation, startedAt, response),
          (value) => failWebRequest(selectedLogger, request, operation, startedAt, value)
        )
      }
      return completeWebResponse(selectedLogger, request, operation, startedAt, result)
    } catch (value) {
      return failWebRequest(selectedLogger, request, operation, startedAt, value)
    }
  }
}

/** Wraps one structural Broker with publish and per-delivery completion records. */
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
  const selectedLogger = loggerValue(logger)
  const publish = broker.publish
  const subscribe = broker.subscribe
  const string = broker.string

  return Object.freeze({
    /** Publishes through the native Broker receiver and returns its result unchanged. */
    async publish(
      ctx: Context,
      topic: string,
      message: BrokerMessage,
      options?: PublishOptions
    ): Promise<PublishResult> {
      const operation = `publish ${topic}`
      const startedAt = performance.now()
      try {
        const result =
          options === undefined
            ? await publish.call(broker, ctx, topic, message)
            : await publish.call(broker, ctx, topic, message, options)
        writeCompletion(
          selectedLogger,
          "broker",
          operation,
          contextOutcome(ctx, false),
          startedAt,
          null,
          null
        )
        return result
      } catch (value) {
        writeCompletion(
          selectedLogger,
          "broker",
          operation,
          contextOutcome(ctx, true),
          startedAt,
          null,
          value
        )
        throw value
      }
    },

    /** Subscribes through the native Broker receiver and logs each delivered handler execution. */
    async subscribe(
      ctx: Context,
      topic: string,
      handler: (ctx: Context, event: BrokerEvent<NativeEvent>) => void | Promise<void>,
      options?: SubscribeOptions
    ): Promise<Subscriber> {
      if (typeof handler !== "function") throw new TypeError("broker handler must be a function")
      /** Preserves a synchronous handler and observes an asynchronous handler to completion. */
      function loggedHandler(
        eventContext: Context,
        event: BrokerEvent<NativeEvent>
      ): void | Promise<void> {
        const operation = `consume ${topic}`
        const startedAt = performance.now()
        try {
          const result = handler(eventContext, event)
          if (isHandlerPromise(result)) {
            return Promise.resolve(result).then(
              () => {
                writeCompletion(
                  selectedLogger,
                  "broker",
                  operation,
                  contextOutcome(eventContext, false),
                  startedAt,
                  null,
                  null
                )
              },
              (value: unknown) => {
                writeCompletion(
                  selectedLogger,
                  "broker",
                  operation,
                  contextOutcome(eventContext, true),
                  startedAt,
                  null,
                  value
                )
                throw value
              }
            )
          }
          writeCompletion(
            selectedLogger,
            "broker",
            operation,
            contextOutcome(eventContext, false),
            startedAt,
            null,
            null
          )
        } catch (value) {
          writeCompletion(
            selectedLogger,
            "broker",
            operation,
            contextOutcome(eventContext, true),
            startedAt,
            null,
            value
          )
          throw value
        }
      }
      return options === undefined
        ? await subscribe.call(broker, ctx, topic, loggedHandler)
        : await subscribe.call(broker, ctx, topic, loggedHandler, options)
    },

    /** Returns the wrapped Broker diagnostic name through its native receiver. */
    string(): string {
      return string.call(broker)
    }
  })
}
