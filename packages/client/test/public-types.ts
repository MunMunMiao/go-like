import { background } from "@go-like/context"
import { filterLabel, filterVersion } from "@go-like/registry"
import type { Discovery, Selector } from "@go-like/registry"
import type { CircuitBreakerOptions } from "@go-like/resilience"
import { struct } from "@go-like/struct"
import { endpoint, type Transport } from "@go-like/transport"

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
  withEndpoint,
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

const TypedRequest = struct.object({ currency: struct.literal("USD") })
const TypedResponse = struct.object({ total: struct.number() })

const request: CallRequest = {
  service: "orders",
  endpoint: "Create",
  headers: { tenant: "one" },
  body: new Uint8Array()
}
const client: Client = newClient(
  withEndpoint("discovery:///orders-registry"),
  withDiscovery(discovery),
  withTransport(transport)
)
const response: Promise<Response> = client.call(background(), request)
const closed: Promise<void> = client.close(background())
const addressOption: ClientOption = withEndpoint("memory://orders")
const serviceOption: ClientOption = withEndpoint("discovery:///orders-registry")
const directClient: Client = newClient(withTransport(transport), addressOption)
const directResponse: Promise<Response> = directClient.call(background(), request)
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
  filters: [],
  retry: callRetry
}
const callOption: CallOption = withFilter(filterVersion("v1"))
const filteredResponse: Promise<Response> = client.call(
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
  addresses: [],
  service: "orders-registry",
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
  withEndpoint("discovery:///orders-registry"),
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
  addressOption,
  serviceOption,
  call,
  typedResponse,
  callOptions,
  filteredResponse,
  operationBreaker,
  options,
  block,
  configured
]

// @ts-expect-error withEndpoint is construction-only, never a per-call option.
const perCallAddress: CallOption = withEndpoint("memory://orders")
void perCallAddress
const readonlyTargets = ["memory://orders-a", "memory://orders-b"] as const
const readonlyEndpoint: ClientOption = withEndpoint(readonlyTargets)
void readonlyEndpoint
// @ts-expect-error withEndpoint takes one target value, not a rest list.
withEndpoint("memory://orders-a", "memory://orders-b")
// @ts-expect-error CallOptions no longer carries a per-call address.
void callOptions.address
// @ts-expect-error ClientOptions address snapshots are immutable.
options.addresses.push("memory://other")
// @ts-expect-error ClientOptions service identity is immutable.
options.service = "billing-registry"

// @ts-expect-error Client.call requires Context as its independent first argument.
client.call(request)
// @ts-expect-error Typed requests are inferred from the Endpoint, not widened from the call.
client.call(background(), typedEndpoint, { currency: "EUR" })
// @ts-expect-error CallRequest service is a string.
const invalidRequest: CallRequest = { service: 1, endpoint: "Create", headers: {}, body: null }
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
