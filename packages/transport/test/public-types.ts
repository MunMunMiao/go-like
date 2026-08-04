import type { Context } from "@go-like/context"
import { newMetadata } from "@go-like/metadata"
import { struct, type Infer } from "@go-like/struct"

import {
  fromClientContext,
  chain,
  codec,
  endpoint,
  isServiceError,
  logger,
  secure,
  fromServerContext,
  serviceError,
  timeout,
  tlsConfig,
  newClientContext,
  withConnClose,
  newServerContext,
  withTimeout,
  type AcceptHandler,
  type Client,
  type DialOption,
  type DialOptions,
  type Endpoint,
  type Handler,
  type ListenOption,
  type ListenOptions,
  type Listener,
  type Message,
  type MessageCodec,
  type Middleware,
  type Option,
  type Options,
  type ServiceError,
  type Socket,
  type TLSConfig,
  type TLSEncodedBytes,
  type TLSEncoding,
  type Transport,
  type TransportInfo,
  type TransportLogLevel,
  type TransportLogger
} from "../src/index"
import * as Headers from "../src/headers"
import {
  decodeMetadataHeader,
  decodeServiceError,
  encodeMetadataHeader,
  encodeServiceError,
  internalServiceError,
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError,
  snapshotMessage,
  type ServiceErrorEnvelope,
  type ServiceErrorWireKind,
  type TransportClosedError,
  type TransportProtocolError,
  type TransportStateError,
  type UnsupportedTransportCapabilityError
} from "../src/provider"

declare const ctx: Context
declare const message: Message
declare const options: Options
declare const dialOptions: DialOptions
declare const listenOptions: ListenOptions
declare const socket: Socket
declare const client: Client
declare const listener: Listener
declare const transport: Transport
declare const transportInfo: TransportInfo
declare const handler: Handler<Message, Promise<Message>>
declare const middleware: Middleware<Message, Promise<Message>>
declare const acceptHandler: AcceptHandler
declare const option: Option
declare const dialOption: DialOption
declare const listenOption: ListenOption
declare const tls: TLSConfig
declare const tlsBytes: TLSEncodedBytes
declare const encoding: TLSEncoding
declare const level: TransportLogLevel
declare const codecValue: MessageCodec
declare const loggerValue: TransportLogger
declare const closedError: TransportClosedError
declare const stateError: TransportStateError
declare const unsupportedError: UnsupportedTransportCapabilityError
declare const protocolError: TransportProtocolError
declare const serviceFailure: ServiceError
declare const serviceEnvelope: ServiceErrorEnvelope
declare const serviceWireKind: ServiceErrorWireKind

const Request = struct.object({ id: struct.string() })
const Response = struct.object({ total: struct.number() })
const typedEndpoint = endpoint("orders", "Quote", Request, Response)
const endpointContract: Endpoint<typeof Request, typeof Response> = typedEndpoint
const requestValue: Infer<typeof typedEndpoint.request> = { id: "order-1" }
const responseValue: Infer<typeof typedEndpoint.response> = { total: 1 }

const structuralSocket: Socket = {
  recv(_ctx): Promise<Message> {
    return Promise.resolve(message)
  },
  send(_ctx, _message): Promise<void> {
    return Promise.resolve()
  },
  close(_ctx): Promise<void> {
    return Promise.resolve()
  },
  local(): string {
    return "local"
  },
  remote(): string {
    return "remote"
  }
}
const structuralListener: Listener = {
  addr(): string {
    return "address"
  },
  close(_ctx): Promise<void> {
    return Promise.resolve()
  },
  accept(_ctx, _handler): Promise<void> {
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
  operation: () => "/orders.v1.Order/Get",
  requestHeaders: () => newMetadata({ trace: "one" }),
  replyHeaders: () => newMetadata()
}
const clientInfoContext: Context = newClientContext(ctx, structuralTransportInfo)
const serverInfoContext: Context = newServerContext(ctx, structuralTransportInfo)
const clientInfo: TransportInfo | null = fromClientContext(clientInfoContext)
const serverInfo: TransportInfo | null = fromServerContext(serverInfoContext)

void [
  ctx,
  message,
  options,
  dialOptions,
  listenOptions,
  socket,
  client,
  listener,
  transport,
  transportInfo,
  handler,
  middleware,
  acceptHandler,
  option,
  dialOption,
  listenOption,
  tls,
  tlsBytes,
  encoding,
  level,
  codecValue,
  loggerValue,
  closedError,
  stateError,
  unsupportedError,
  protocolError,
  serviceFailure,
  serviceEnvelope,
  serviceWireKind,
  endpointContract,
  requestValue,
  responseValue,
  structuralSocket,
  structuralListener,
  structuralTransportInfo,
  codec,
  logger,
  secure,
  serviceError,
  snapshotMessage,
  timeout,
  tlsConfig,
  withConnClose,
  newClientContext,
  newServerContext,
  withTimeout,
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError,
  internalServiceError,
  isServiceError,
  encodeServiceError,
  decodeServiceError,
  decodeMetadataHeader,
  encodeMetadataHeader,
  clientInfo,
  serverInfo,
  chain,
  Headers
]
