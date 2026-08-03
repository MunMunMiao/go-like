import type { Struct } from "@likego/struct"
import { isStruct } from "@likego/struct/runtime"

/** Describes one typed internal unary endpoint without prescribing an IDL. */
export interface Endpoint<Request extends Struct = Struct, Response extends Struct = Struct> {
  readonly service: string
  readonly endpoint: string
  readonly request: Request
  readonly response: Response
}

/** Validates one unambiguous service or endpoint route token. */
function routeToken(value: string, field: string): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/u.test(value) || /[/*]/u.test(value)) {
    throw new TypeError(`transport endpoint ${field} must be a visible ASCII route token`)
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
): Endpoint<Request, Response> {
  return Object.freeze({
    service: routeToken(service, "service"),
    endpoint: routeToken(name, "endpoint"),
    request: endpointStruct(request, "request"),
    response: endpointStruct(response, "response")
  })
}
