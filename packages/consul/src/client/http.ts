import { deadlineExceeded } from "@go-like/core/context"

import { boundaryError, newConsulTransportError, type ConsulOperation } from "./errors"
import type { Connection } from "./options"

/** Registry agent and health operations, before the socket prefix is applied. */
export type RegistryWireOperation =
  | "register"
  | "heartbeat"
  | "deregister"
  | "readback"
  | "get"
  | "watch"

/** Connection fields the registry request path reads. */
export interface RegistryWire {
  readonly fetch: Connection["fetch"]
  readonly origin: string
  readonly token: string | undefined
  readonly datacenter: string | undefined
  readonly namespace: string | undefined
}

/** Prefixes a registry wire operation for the shared error family. */
export function registryOperation(operation: RegistryWireOperation): ConsulOperation {
  if (operation === "register") return "registry.register"
  if (operation === "heartbeat") return "registry.heartbeat"
  if (operation === "deregister") return "registry.deregister"
  if (operation === "readback") return "registry.readback"
  if (operation === "get") return "registry.get"
  return "registry.watch"
}

/** Creates the secret-bearing headers without exposing their values elsewhere. */
export function consulHeaders(token: string | undefined, json: boolean, accept: string): Headers {
  const headers = new Headers({ Accept: accept })
  if (json) headers.set("Content-Type", "application/json")
  if (token !== undefined) headers.set("X-Consul-Token", token)
  return headers
}

/** Adds provider scopes to one Consul API URL. Datacenter is omitted on agent endpoints. */
export function consulUrl(options: RegistryWire, path: string, includeDatacenter: boolean): URL {
  const url = new URL(path, options.origin)
  if (includeDatacenter && options.datacenter !== undefined) {
    url.searchParams.set("dc", options.datacenter)
  }
  if (options.namespace !== undefined) url.searchParams.set("ns", options.namespace)
  return url
}

/** Creates one provider-owned Consul Request that never follows redirects. */
export function consulRequest(
  options: RegistryWire,
  url: URL,
  method: "GET" | "PUT" | "DELETE",
  body: string | null,
  signal: AbortSignal | null,
  accept: string
): Request {
  return new Request(url, {
    method,
    headers: consulHeaders(options.token, body !== null && method !== "DELETE", accept),
    ...(body === null ? {} : { body }),
    redirect: "error",
    ...(signal === null ? {} : { signal })
  })
}

/** Cancels an ignored response body without allowing cancellation failure to replace status. */
export function discardBody(response: Response, ignore: (value: unknown) => void): void {
  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    return
  }
  if (body === null) return
  try {
    void body.cancel().catch(ignore)
  } catch {
    return
  }
}

/** Converts an aborted operation into its exact Error identity. */
export function signalFailure(signal: AbortSignal, message: string): Error {
  return boundaryError(signal.reason, message)
}

/** Executes one borrowed Fetch and sanitizes secret-bearing rejection graphs. */
export async function executeRegistry(
  options: RegistryWire,
  operation: RegistryWireOperation,
  request: Request
): Promise<Response> {
  if (request.signal.aborted) {
    throw signalFailure(request.signal, `Consul ${operation} request was aborted`)
  }
  try {
    return await options.fetch(request)
  } catch (value) {
    if (request.signal.aborted) {
      throw signalFailure(request.signal, `Consul ${operation} request was aborted`)
    }
    throw newConsulTransportError(registryOperation(operation), value, options.token !== undefined)
  }
}

/** Reports whether an operation, Fetch, or HTTP failure is availability-retryable. */
export function retryable(value: unknown): boolean {
  if (value === deadlineExceeded) return true
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === "GO_LIKE_CONSUL_TRANSPORT") return true
  if (
    value.code !== "GO_LIKE_CONSUL_HTTP" ||
    !("status" in value) ||
    typeof value.status !== "number"
  ) {
    return false
  }
  return value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500
}
