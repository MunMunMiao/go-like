/// <reference lib="esnext.disposable" />

import type { Context } from "@go-like/context"
import { struct, type Infer, type Struct } from "@go-like/struct"
import { isStruct } from "@go-like/struct/runtime"

import { endpoint, type Endpoint } from "./endpoint"

const RouteToken = /^[A-Za-z0-9._~-]+$/
const emptyRequest = struct.object({})

/** Active server stream of one response value. */
export interface ServerStream<T> extends AsyncIterable<T>, AsyncDisposable {
  /** Stops the stream and cancels the underlying call. */
  close(): Promise<void>
  /** Releases the stream. */
  [Symbol.asyncDispose](): Promise<void>
}

/** Declares one endpoint on a service contract. */
export interface ServiceEndpointDefinition {
  readonly request?: Struct
  readonly response: Struct
  readonly stream?: true
}

/** Maps endpoint names to their declarations. */
export type ServiceDefinitions = Readonly<Record<string, ServiceEndpointDefinition>>

/** Accepts one existing call option without depending on the client package. */
export interface ServiceCallOption {
  (value: never): unknown
}

/** Accepts one atomic batch of typed handler registrations. */
export interface ServiceServer {
  /** Registers every endpoint after the whole list validates. */
  registerHandlers(
    handlers: readonly {
      readonly endpoint: Endpoint
      readonly handler: (ctx: Context, request: unknown) => unknown
    }[]
  ): void
}

/** Borrows one connection that can perform a unary call. */
export interface ServiceConnection {
  /** Calls one endpoint. Arguments are context, endpoint, request, then call options. */
  call(...args: readonly unknown[]): Promise<unknown>
  /** Performs one server-streaming call. Unary connections may omit it. */
  stream?(...args: readonly unknown[]): Promise<unknown>
}

/** One frozen service contract. */
export interface DefinedService<Definitions extends ServiceDefinitions> {
  /** Contract service name used in the URL path. */
  readonly name: string
  /** Frozen endpoint contracts keyed by declaration name. */
  readonly endpoints: EndpointsOf<Definitions>
  /** Checks every method, then registers the whole service at once. */
  registerHandler(server: ServiceServer, handler: HandlersOf<Definitions>): void
  /** Returns a frozen proxy that only exposes contract methods. */
  newClient(conn: ServiceConnection): ClientsOf<Definitions>
}

type RequestOf<Definition> = Definition extends { readonly request: infer Request extends Struct }
  ? Request
  : never

type ResponseOf<Definition> = Definition extends {
  readonly response: infer Response extends Struct
}
  ? Response
  : never

type HasRequest<Definition> = [RequestOf<Definition>] extends [never] ? false : true

type IsStream<Definition> = Definition extends { readonly stream: true } ? true : false

type EndpointRequest<Definition> =
  HasRequest<Definition> extends true ? RequestOf<Definition> : typeof emptyRequest

type EndpointsOf<Definitions extends ServiceDefinitions> = {
  readonly [Name in keyof Definitions]: Endpoint<
    EndpointRequest<Definitions[Name]>,
    ResponseOf<Definitions[Name]>,
    IsStream<Definitions[Name]>
  >
}

type HandlerOf<Definition> =
  IsStream<Definition> extends true
    ? HasRequest<Definition> extends true
      ? (
          ctx: Context,
          request: Infer<RequestOf<Definition>>
        ) => AsyncIterable<Infer<ResponseOf<Definition>>>
      : (ctx: Context) => AsyncIterable<Infer<ResponseOf<Definition>>>
    : HasRequest<Definition> extends true
      ? (
          ctx: Context,
          request: Infer<RequestOf<Definition>>
        ) => Infer<ResponseOf<Definition>> | Promise<Infer<ResponseOf<Definition>>>
      : (ctx: Context) => Infer<ResponseOf<Definition>> | Promise<Infer<ResponseOf<Definition>>>

type HandlersOf<Definitions extends ServiceDefinitions> = {
  readonly [Name in keyof Definitions]: HandlerOf<Definitions[Name]>
}

type ClientOf<Definition> =
  IsStream<Definition> extends true
    ? HasRequest<Definition> extends true
      ? (
          ctx: Context,
          request: Infer<RequestOf<Definition>>,
          ...options: readonly ServiceCallOption[]
        ) => Promise<ServerStream<Infer<ResponseOf<Definition>>>>
      : (
          ctx: Context,
          ...options: readonly ServiceCallOption[]
        ) => Promise<ServerStream<Infer<ResponseOf<Definition>>>>
    : HasRequest<Definition> extends true
      ? (
          ctx: Context,
          request: Infer<RequestOf<Definition>>,
          ...options: readonly ServiceCallOption[]
        ) => Promise<Infer<ResponseOf<Definition>>>
      : (
          ctx: Context,
          ...options: readonly ServiceCallOption[]
        ) => Promise<Infer<ResponseOf<Definition>>>

type ClientsOf<Definitions extends ServiceDefinitions> = {
  readonly [Name in keyof Definitions]: ClientOf<Definitions[Name]>
}

type EndpointField = "request" | "response" | "stream"

/** Rewrites unknown declaration keys into an error string. */
type StrictDefinitions<Definitions> = {
  readonly [Name in keyof Definitions]: {
    readonly [Key in keyof Definitions[Name]]: Key extends EndpointField
      ? Definitions[Name][Key]
      : `unknown endpoint field ${Key & string}`
  }
}

/** Handler object derived from one service contract. */
export type ServiceHandler<Service extends DefinedService<ServiceDefinitions>> =
  Service extends DefinedService<infer Definitions> ? HandlersOf<Definitions> : never

/** Client proxy derived from one service contract. */
export type ServiceClient<Service extends DefinedService<ServiceDefinitions>> =
  Service extends DefinedService<infer Definitions> ? ClientsOf<Definitions> : never

interface ContractEndpoint {
  readonly name: string
  readonly endpoint: Endpoint
  readonly hasRequest: boolean
  readonly stream: boolean
}

/** Reports whether a value is a non-array object. */
function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validates one service route token. */
function serviceToken(value: unknown): string {
  if (typeof value !== "string" || !RouteToken.test(value) || value === "." || value === "..") {
    throw new TypeError("transport service name must be a URL unreserved route token")
  }
  return value
}

/** Validates one endpoint key. */
function endpointToken(value: PropertyKey): string {
  if (typeof value !== "string") {
    throw new TypeError("transport service endpoint name must be a string")
  }
  if (!RouteToken.test(value) || value === "." || value === "..") {
    throw new TypeError(`transport service endpoint ${value} must be a URL unreserved route token`)
  }
  if (Object.hasOwn(Object.prototype, value)) {
    throw new TypeError(`transport service endpoint ${value} collides with Object.prototype`)
  }
  return value
}

/** Reads one declared Struct field. */
function structField(value: unknown, name: string, field: string): Struct {
  if (!isStruct(value)) {
    throw new TypeError(`transport service endpoint ${name} ${field} must be a Struct`)
  }
  return value as Struct
}

/** Reads and validates one endpoint declaration. */
function endpointFields(
  value: object,
  name: string
): { readonly request: Struct | null; readonly response: Struct; readonly stream: boolean } {
  let request: Struct | null = null
  let response: Struct | null = null
  let stream = false
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "request" && key !== "response" && key !== "stream") {
      throw new TypeError(`transport service endpoint ${name} has unknown field ${String(key)}`)
    }
    const field = Reflect.get(value, key)
    if (key === "request") {
      request = structField(field, name, "request")
      continue
    }
    if (key === "response") {
      response = structField(field, name, "response")
      continue
    }
    if (field !== true) {
      throw new TypeError(`transport service endpoint ${name} stream must be true or omitted`)
    }
    stream = true
  }
  if (response === null) {
    throw new TypeError(`transport service endpoint ${name} requires response`)
  }
  return { request, response, stream }
}

/** Builds the frozen endpoint list in declaration order. */
function contractEndpoints(serviceName: string, definitions: object): readonly ContractEndpoint[] {
  const keys = Reflect.ownKeys(definitions)
  if (keys.length === 0) throw new TypeError("transport service requires at least one endpoint")
  const records: ContractEndpoint[] = []
  for (const key of keys) {
    const name = endpointToken(key)
    const definition = Reflect.get(definitions, key)
    if (!isRecord(definition)) {
      throw new TypeError(`transport service endpoint ${name} must be an object`)
    }
    const fields = endpointFields(definition, name)
    const request = fields.request ?? emptyRequest
    const built =
      fields.stream === true
        ? endpoint(serviceName, name, request, fields.response, true)
        : endpoint(serviceName, name, request, fields.response)
    records.push({
      name,
      endpoint: built,
      hasRequest: fields.request !== null,
      stream: fields.stream
    })
  }
  return records
}

/** Reports whether a value can register a typed handler batch. */
function isServer(value: unknown): value is ServiceServer {
  return isRecord(value) && typeof Reflect.get(value, "registerHandlers") === "function"
}

/** Reports whether a value can carry endpoint methods. */
function isHandler(value: unknown): value is object {
  return isRecord(value)
}

/** Reports whether a value can perform a unary call. */
function isConnection(value: unknown): value is ServiceConnection {
  return isRecord(value) && typeof Reflect.get(value, "call") === "function"
}

/** Invokes one handler method with the registration target as this. */
function applyMethod(method: unknown, receiver: object, args: readonly unknown[]): unknown {
  return Reflect.apply(method as (...values: readonly unknown[]) => unknown, receiver, args)
}

/** Creates one frozen service contract from endpoint declarations. */
export function defineService<const Definitions extends ServiceDefinitions>(
  name: string,
  definitions: Definitions extends StrictDefinitions<Definitions>
    ? Definitions
    : StrictDefinitions<Definitions>
): DefinedService<Definitions> {
  const serviceName = serviceToken(name)
  if (!isRecord(definitions)) {
    throw new TypeError("transport service endpoints must be an object")
  }
  const records = contractEndpoints(serviceName, definitions)
  const endpoints: Record<string, Endpoint> = {}
  for (const record of records) endpoints[record.name] = record.endpoint

  /** Checks every method, then registers the whole service at once. */
  function registerHandler(server: ServiceServer, handler: HandlersOf<Definitions>): void {
    if (!isServer(server)) {
      throw new TypeError("transport service server must implement registerHandlers")
    }
    if (!isHandler(handler)) {
      throw new TypeError("transport service handler must be an object")
    }
    const methods: { readonly record: ContractEndpoint; readonly method: unknown }[] = []
    for (const record of records) {
      const method = Reflect.get(handler, record.name)
      if (typeof method !== "function") {
        throw new TypeError(
          `transport service handler is missing handler for endpoint ${record.name}`
        )
      }
      methods.push({ record, method })
    }
    const bindings: {
      readonly endpoint: Endpoint
      readonly handler: (ctx: Context, request: unknown) => unknown
    }[] = []
    for (const entry of methods) {
      const method = entry.method
      const selected = entry.record
      bindings.push({
        endpoint: selected.endpoint,
        handler(ctx: Context, request: unknown): unknown {
          if (selected.hasRequest) return applyMethod(method, handler, [ctx, request])
          return applyMethod(method, handler, [ctx])
        }
      })
    }
    server.registerHandlers(bindings)
  }

  /** Returns a frozen proxy that borrows the connection. */
  function newClient(conn: ServiceConnection): ClientsOf<Definitions> {
    if (!isConnection(conn)) {
      throw new TypeError("transport service connection must implement call")
    }
    const proxy: Record<string, (ctx: Context, ...args: readonly unknown[]) => Promise<unknown>> =
      {}
    for (const record of records) {
      proxy[record.name] = async function callMethod(
        ctx: Context,
        ...args: readonly unknown[]
      ): Promise<unknown> {
        if (record.stream) {
          if (typeof conn.stream !== "function") {
            throw new TypeError("transport service connection must implement stream")
          }
          if (record.hasRequest) return conn.stream(ctx, record.endpoint, args[0], ...args.slice(1))
          return conn.stream(ctx, record.endpoint, {}, ...args)
        }
        if (record.hasRequest) return conn.call(ctx, record.endpoint, args[0], ...args.slice(1))
        return conn.call(ctx, record.endpoint, {}, ...args)
      }
    }
    return Object.freeze(proxy) as ClientsOf<Definitions>
  }

  return Object.freeze({
    name: serviceName,
    endpoints: Object.freeze(endpoints),
    registerHandler,
    newClient
  }) as DefinedService<Definitions>
}
