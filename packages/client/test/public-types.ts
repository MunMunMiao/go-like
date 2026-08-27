import { background } from "@go-like/context"
import { filterLabel, filterVersion } from "@go-like/registry"
import type { Discovery, Selector } from "@go-like/registry"
import type { CircuitBreakerOptions } from "@go-like/resilience"
import { struct } from "@go-like/struct"
import { endpoint, type Message, type Transport } from "@go-like/transport"

import * as ClientPackage from "../src/index"
import {
  circuitBreakerMiddleware,
  withDiscovery,
  closeTimeout,
  middleware,
  newClient,
  poolSize,
  poolTtl,
  use,
  withBlock,
  withSelector,
  withTransport,
  withAddress,
  withFilter,
  withRetry,
  type Call,
  type CallOption,
  type CallOptions,
  type CallRequest,
  type CallRetryOptions,
  type Client,
  type ClientMiddleware,
  type ClientOption,
  type ClientOptions
} from "../src/index"

declare const discovery: Discovery
declare const selector: Selector
declare const transport: Transport
declare const message: Message

const TypedRequest = struct.object({ currency: struct.literal("USD") })
const TypedResponse = struct.object({ total: struct.number() })

const request: CallRequest = { service: "orders", endpoint: "Create", message }
const client: Client = newClient(withDiscovery(discovery), withTransport(transport))
const response: Promise<Message> = client.call(background(), request)
const closed: Promise<void> = client.close(background())
const directClient: Client = newClient(withTransport(transport))
const directResponse: Promise<Message> = directClient.call(
  background(),
  request,
  withAddress("memory://orders")
)
const call: Call = client.call
const typedEndpoint = endpoint("orders", "Quote", TypedRequest, TypedResponse)
const typedResponse: Promise<{ readonly total: number }> = client.call(
  background(),
  typedEndpoint,
  {
    currency: "USD"
  }
)
const callRetry: CallRetryOptions = {
  authorization: "idempotent",
  maxAttempts: 2,
  shouldRetry: () => true,
  backoff: () => 0
}
const callOptions: CallOptions = {
  address: null,
  filters: [],
  retry: callRetry
}
const callOption: CallOption = withAddress("memory://orders")
const filteredResponse: Promise<Message> = client.call(
  background(),
  request,
  callOption,
  withFilter(filterVersion("v1"), filterLabel("zone", "a")),
  withRetry(callRetry)
)
const clientMiddleware: ClientMiddleware = (next) => next
const circuitOptions: CircuitBreakerOptions = {
  failureThreshold: 3,
  resetTimeoutMs: 1_000
}
const operationBreaker: ClientMiddleware = circuitBreakerMiddleware(circuitOptions)
const options: ClientOptions = {
  discovery,
  selector,
  transport,
  middleware: [clientMiddleware, operationBreaker],
  operationMiddleware: new Map(),
  closeTimeoutMs: 1_000,
  poolSize: 100,
  poolTtlMs: 60_000
}
const option: ClientOption = middleware(clientMiddleware)
const operationOption: ClientOption = use("orders/*", clientMiddleware)
const closeOption: ClientOption = closeTimeout(1_000)
const poolSizeOption: ClientOption = poolSize(100)
const poolTtlOption: ClientOption = poolTtl(60_000)
const blockOption: ClientOption = withBlock()
const block: boolean | undefined = options.block
const configured: Client = newClient(
  blockOption,
  withDiscovery(discovery),
  withSelector(selector),
  withTransport(transport),
  option,
  operationOption,
  closeOption,
  poolSizeOption,
  poolTtlOption
)
void [
  request,
  client,
  response,
  closed,
  directClient,
  directResponse,
  call,
  typedResponse,
  callOptions,
  filteredResponse,
  operationBreaker,
  options,
  block,
  configured
]

// @ts-expect-error Client.call requires Context as its independent first argument.
client.call(request)
// @ts-expect-error Typed requests are inferred from the Endpoint, not widened from the call.
client.call(background(), typedEndpoint, { currency: "EUR" })
// @ts-expect-error CallRequest service is a string.
const invalidRequest: CallRequest = { service: 1, endpoint: "Create", message }
void invalidRequest
// @ts-expect-error The package has no PascalCase callable alias.
ClientPackage.NewClient(discovery, selector, transport)
// @ts-expect-error Client options use ordinary TypeScript lower-case exports.
ClientPackage.CloseTimeout(1)
// @ts-expect-error Call options use ordinary TypeScript lower-case exports.
ClientPackage.WithAddress("memory://orders")
// @ts-expect-error Client is type-only at runtime.
void ClientPackage.Client
// @ts-expect-error Residency is part of Client.close, not a second Client type.
void ClientPackage.ResidentClient
// @ts-expect-error newClient is the only Client constructor.
ClientPackage.newResidentClient(discovery, selector, transport)
