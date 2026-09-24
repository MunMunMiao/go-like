import { background, type Context } from "@go-like/context"
import { newTokenBucketLimiter, type RateLimiter } from "@go-like/resilience"
import { struct } from "@go-like/struct"
import {
  endpoint as typedEndpoint,
  type Client,
  type Listener,
  type Message,
  type Options,
  type Transport
} from "@go-like/transport"

import {
  address,
  advertise,
  httpRoute,
  listenOption,
  middleware,
  newServer,
  rateLimitMiddleware,
  transport,
  use,
  type Handler,
  type HandlerRegistrar,
  type Middleware,
  type Server,
  type ServerOption,
  type ServerOptions
} from "../src/index"
// @ts-expect-error Construction-time handler registration is not exported.
import { handler as removedHandler } from "../src/index"

type ThenOnly<T> = Pick<Promise<T>, "then">

declare const listener: Listener
declare const thenOnlyMessage: ThenOnly<Message>
const NumberValue = struct.number()
const transportValue: Transport = {
  init(): void {},
  options(): Options {
    throw new Error("type fixture")
  },
  dial(): Promise<Client> {
    throw new Error("type fixture")
  },
  listen(): Promise<Listener> {
    return Promise.resolve(listener)
  },
  string(): string {
    return "fixture"
  }
}
const operation: Handler = async (_ctx: Context, request: Message) => request
const synchronousOperation: Handler = (_ctx, request) => request
// @ts-expect-error Handler accepts only a Message or native Promise.
const thenOnlyOperation: Handler = () => thenOnlyMessage
const wrapper: Middleware = (next) => next
const limiter: RateLimiter = newTokenBucketLimiter({
  capacity: 1,
  refillTokens: 1,
  refillIntervalMs: 1_000
})
const limited: Middleware = rateLimitMiddleware(limiter)
const increment = typedEndpoint("calculator", "increment", NumberValue, NumberValue)
const pathOption: ServerOption = httpRoute("POST", "/v1/orders", "orders", "get", 201)
const server: Server = newServer(
  transport(transportValue),
  address("127.0.0.1:0"),
  advertise("server.internal"),
  pathOption,
  middleware(wrapper, limited),
  use("orders/*", wrapper),
  listenOption()
)
const registrarValue: HandlerRegistrar = server
const rawRegistration: void = server.registerHandler("orders", "get", operation)
const typedRegistration: void = server.registerHandler(increment, (_ctx, request) => request + 1)
const options: ServerOptions = server.options()
const advertised: string | null = options.advertise
const httpRoutes: ServerOptions["httpRoutes"] = options.httpRoutes
const operationMiddleware: ReadonlyMap<string, readonly Middleware[]> = options.operationMiddleware
const protocol: string = server.protocol()
const endpoint: Promise<string> = server.endpoint(background())
const running: Promise<void> = server.start(background())
const stopping: Promise<void> = server.stop(background())

void [
  registrarValue,
  rawRegistration,
  typedRegistration,
  options,
  advertised,
  httpRoutes,
  operationMiddleware,
  protocol,
  endpoint,
  running,
  stopping,
  limited,
  synchronousOperation,
  thenOnlyOperation
]

// @ts-expect-error Construction options no longer expose registration state.
void options.handlers

// @ts-expect-error Context is an independent first argument.
operation({ header: {}, body: new Uint8Array() })
// @ts-expect-error Typed handler responses must match the Endpoint response Struct.
server.registerHandler(increment, () => "invalid")

void removedHandler
