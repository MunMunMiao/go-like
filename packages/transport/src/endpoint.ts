import type { Struct } from "@go-like/struct"
import { isStruct } from "@go-like/struct/runtime"

/** Describes one typed internal endpoint without prescribing an IDL. */
export interface Endpoint<
  Request extends Struct = Struct,
  Response extends Struct = Struct,
  Stream extends boolean = boolean
> {
  readonly service: string
  readonly endpoint: string
  readonly request: Request
  readonly response: Response
  readonly stream: Stream
}

const RouteToken = /^[A-Za-z0-9._~-]+$/

/** Validates one unambiguous service or endpoint route token. */
function routeToken(value: string, field: string): string {
  if (typeof value !== "string" || !RouteToken.test(value) || value === "." || value === "..") {
    throw new TypeError(`transport endpoint ${field} must be a URL unreserved route token`)
  }
  return value
}

/** Rejects structural lookalikes that are not real Struct instances. */
function endpointStruct<S extends Struct>(value: S, field: string): S {
  if (!isStruct(value)) throw new TypeError(`transport endpoint ${field} must be a Struct`)
  return value
}

/** Creates one immutable typed unary endpoint contract. */
export function endpoint<const Request extends Struct, const Response extends Struct>(
  service: string,
  name: string,
  request: Request,
  response: Response
): Endpoint<Request, Response, false>

/** Creates one immutable typed server-streaming endpoint contract. */
export function endpoint<const Request extends Struct, const Response extends Struct>(
  service: string,
  name: string,
  request: Request,
  response: Response,
  stream: true
): Endpoint<Request, Response, true>

/** Creates one immutable typed endpoint contract. */
export function endpoint<const Request extends Struct, const Response extends Struct>(
  service: string,
  name: string,
  request: Request,
  response: Response,
  stream?: true
): Endpoint<Request, Response, boolean> {
  if (stream !== undefined && stream !== true) {
    throw new TypeError("transport endpoint stream must be true or omitted")
  }
  return Object.freeze({
    service: routeToken(service, "service"),
    endpoint: routeToken(name, "endpoint"),
    request: endpointStruct(request, "request"),
    response: endpointStruct(response, "response"),
    stream: stream === true
  })
}
