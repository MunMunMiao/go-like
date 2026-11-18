import type { Context } from "../../src/context"
import { newMetadata } from "../../src/metadata"
import { struct, type Infer } from "../../src/struct"

import { chain, type Handler, type Middleware } from "../../src/transport/middleware"
import {
  fromClientContext,
  endpoint,
  isServiceError,
  secure,
  fromServerContext,
  serviceError,
  timeout,
  tlsConfig,
  withConnClose,
  withTimeout,
  type Client,
  type DialOption,
  type DialOptions,
  type Endpoint,
  type ListenOption,
  type ListenOptions,
  type Listener,
  type Option,
  type Options,
  type ServiceError,
  type TLSConfig,
  type TLSEncodedBytes,
  type TLSEncoding,
  type Transport,
  type TransportClosedError,
  type TransportHandler,
  type TransportInfo,
  type TransportProtocolError,
  type TransportStateError,
  type UnsupportedTransportCapabilityError
} from "../../src/transport/index"
import * as Headers from "../../src/transport/internal/headers"
import { decodeMetadataHeader, encodeMetadataHeader } from "../../src/transport/metadata"
import {
  decodeServiceErrorResponse,
  internalServiceError,
  serviceErrorResponse
} from "../../src/transport/errors"
import {
  newServerContext,
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError,
  observeResponseBody
} from "../../src/transport/provider"

type ThenOnly<T> = Pick<Promise<T>, "then">

declare const ctx: Context
declare const request: Request
declare const options: Options
declare const dialOptions: DialOptions
declare const listenOptions: ListenOptions
declare const client: Client
declare const listener: Listener
declare const transport: Transport
declare const transportInfo: TransportInfo
declare const handler: Handler<Request, Promise<Response>>
declare const middleware: Middleware<Request, Promise<Response>>
declare const option: Option
declare const dialOption: DialOption
declare const listenOption: ListenOption
declare const tls: TLSConfig
declare const tlsBytes: TLSEncodedBytes
declare const encoding: TLSEncoding
declare const closedError: TransportClosedError
declare const stateError: TransportStateError
declare const unsupportedError: UnsupportedTransportCapabilityError
declare const protocolError: TransportProtocolError
declare const serviceFailure: ServiceError
declare const thenOnlyResponse: ThenOnly<Response>

const synchronousHandler: TransportHandler = () => new Response(null, { status: 204 })
const asynchronousHandler: TransportHandler = async () => new Response(null, { status: 204 })
// @ts-expect-error TransportHandler accepts only Response or a native Promise of Response.
const thenOnlyHandler: TransportHandler = () => thenOnlyResponse

const RequestStruct = struct.object({ id: struct.string() })
const ResponseStruct = struct.object({ total: struct.number() })
const typedEndpoint = endpoint("orders", "Quote", RequestStruct, ResponseStruct)
const endpointContract: Endpoint<typeof RequestStruct, typeof ResponseStruct> = typedEndpoint
const requestValue: Infer<typeof typedEndpoint.request> = { id: "order-1" }
const responseValue: Infer<typeof typedEndpoint.response> = { total: 1 }

const structuralClient: Client = {
  fetch(_ctx, _request): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 204 }))
  },
  close(_ctx): Promise<void> {
    return Promise.resolve()
  }
}
const structuralListener: Listener = {
  addr(): string {
    return "address"
  },
  close(_ctx): Promise<void> {
    return Promise.resolve()
  },
  serve(_ctx, _handler): Promise<void> {
    return Promise.resolve()
  }
}
const structuralTransport: Transport = {
  init(..._options): void {},
  options(): Options {
    return options
  },
  dial(_ctx, _address, ..._options): Promise<Client> {
    return Promise.resolve(client)
  },
  listen(_ctx, _address, ..._options): Promise<Listener> {
    return Promise.resolve(listener)
  },
  string(): string {
    return "structural"
  }
}
const structuralTransportInfo: TransportInfo = {
  kind: () => "http",
  endpoint: () => "discovery:///orders",
  operation: () => "orders.v1/get",
  requestHeaders: () => newMetadata({ trace: "one" }),
  replyHeaders: () => newMetadata(),
  peerIdentity: () => null
}
// @ts-expect-error TransportInfo requires peerIdentity.
const missingPeerIdentity: TransportInfo = {
  kind: () => "http",
  endpoint: () => "discovery:///orders",
  operation: () => "orders.v1/get",
  requestHeaders: () => newMetadata(),
  replyHeaders: () => newMetadata()
}
const serverInfoContext: Context = newServerContext(ctx, structuralTransportInfo)
const clientInfo: TransportInfo | null = fromClientContext(serverInfoContext)
const serverInfo: TransportInfo | null = fromServerContext(serverInfoContext)
const failureResponse: Response = serviceErrorResponse(serviceError("not_found", "missing", 404))
const observedResponse: Response = observeResponseBody(
  new Response("ok"),
  function ended(): void {}
)
const signaledResponse: Response = observeResponseBody(
  new Response("ok"),
  function ended(): void {},
  { signal: new AbortController().signal }
)
const releasedSource: Response = observeResponseBody(new Response("ok"), function ended(): void {})
// @ts-expect-error observeResponseBody requires a Response.
observeResponseBody("no", function ended(): void {})
const decodedFailure: Promise<ServiceError | null> = decodeServiceErrorResponse(failureResponse)

void [
  ctx,
  request,
  options,
  dialOptions,
  listenOptions,
  client,
  listener,
  transport,
  transportInfo,
  handler,
  middleware,
  option,
  dialOption,
  listenOption,
  tls,
  tlsBytes,
  encoding,
  closedError,
  stateError,
  unsupportedError,
  protocolError,
  serviceFailure,
  endpointContract,
  requestValue,
  responseValue,
  structuralClient,
  structuralListener,
  structuralTransport,
  structuralTransportInfo,
  missingPeerIdentity,
  secure,
  serviceError,
  timeout,
  tlsConfig,
  withConnClose,
  newServerContext,
  withTimeout,
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError,
  internalServiceError,
  isServiceError,
  decodeServiceErrorResponse,
  decodeMetadataHeader,
  encodeMetadataHeader,
  clientInfo,
  serverInfo,
  chain,
  Headers,
  synchronousHandler,
  asynchronousHandler,
  thenOnlyHandler,
  failureResponse,
  decodedFailure,
  observedResponse,
  signaledResponse,
  releasedSource
]
