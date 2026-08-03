import { background, type Context } from "@likego/context"
import { newTokenBucketLimiter, type RateLimiter } from "@likego/resilience"
import { struct } from "@likego/struct"
import {
  endpoint as typedEndpoint,
  type Client,
  type Listener,
  type Message,
  type Options,
  type Transport
} from "@likego/transport"

import {
  address,
  advertise,
  handler,
  listenOption,
  middleware,
  newServer,
  rateLimitMiddleware,
  transport,
  use,
  type Handler,
  type Middleware,
  type Server,
  type ServerOption,
  type ServerOptions
} from "../src/index"

declare const listener: Listener
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
const wrapper: Middleware = (next) => next
const limiter: RateLimiter = newTokenBucketLimiter({
  capacity: 1,
  refillTokens: 1,
  refillIntervalMs: 1_000
})
const limited: Middleware = rateLimitMiddleware(limiter)
const option: ServerOption = handler("orders", "get", operation)
const increment = typedEndpoint("calculator", "increment", NumberValue, NumberValue)
const typedOption: ServerOption = handler(increment, (_ctx, request) => request + 1)
const server: Server = newServer(
  transport(transportValue),
  address("127.0.0.1:0"),
  advertise("server.internal"),
  option,
  typedOption,
  middleware(wrapper, limited),
  use("orders/*", wrapper),
  listenOption()
)
const options: ServerOptions = server.options()
const advertised: string | null = options.advertise
const operationMiddleware: ReadonlyMap<string, readonly Middleware[]> = options.operationMiddleware
const endpoint: Promise<string> = server.endpoint(background())
const running: Promise<void> = server.start(background())
const stopping: Promise<void> = server.stop(background())

void [options, advertised, operationMiddleware, endpoint, running, stopping, limited]

// @ts-expect-error Context is an independent first argument.
operation({ header: {}, body: new Uint8Array() })
// @ts-expect-error Typed handler responses must match the Endpoint response Struct.
handler(increment, () => "invalid")
