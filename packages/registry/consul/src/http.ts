import { deadlineExceeded } from "@likego/context"

import { newHttpError, newTransportError } from "./errors"
import type { OperationOptions } from "./options"
import { ignoreFailure, signalFailure } from "./runtime"
import type { ConsulOperation } from "./types"

/** Creates the secret-bearing headers without exposing their values elsewhere. */
export function consulHeaders(options: OperationOptions, json: boolean): Headers {
  const headers = new Headers({ Accept: "application/json" })
  if (json) headers.set("Content-Type", "application/json")
  if (options.token !== undefined) headers.set("X-Consul-Token", options.token)
  return headers
}

/** Adds provider scopes to one Consul API URL. */
export function consulUrl(
  options: OperationOptions,
  path: string,
  includeDatacenter: boolean
): URL {
  const url = new URL(path, options.origin)
  if (includeDatacenter && options.datacenter !== undefined)
    url.searchParams.set("dc", options.datacenter)
  if (options.namespace !== undefined) url.searchParams.set("ns", options.namespace)
  return url
}

/** Creates one provider-owned Consul Request that never follows redirects. */
function consulRequest(
  options: OperationOptions,
  url: URL,
  method: "GET" | "PUT",
  body: string | null,
  signal: AbortSignal
): Request {
  return new Request(url, {
    method,
    headers: consulHeaders(options, body !== null),
    body,
    redirect: "error",
    signal
  })
}

/** Cancels an ignored response body without allowing cancellation failure to replace status. */
function discard(response: Response): void {
  if (response.body !== null) void response.body.cancel().catch(ignoreFailure)
}

/** Executes one borrowed Fetch and sanitizes secret-bearing rejection graphs. */
async function execute(
  options: OperationOptions,
  operation: ConsulOperation,
  request: Request
): Promise<Response> {
  if (request.signal.aborted) {
    throw signalFailure(request.signal, `Consul ${operation} request was aborted`)
  }
  try {
    return await options.fetch(request)
  } catch (value) {
    if (request.signal.aborted)
      throw signalFailure(request.signal, `Consul ${operation} request was aborted`)
    throw newTransportError(operation, value, options.token !== undefined)
  }
}

/** Executes one mutation and optionally accepts an already-missing record. */
export async function mutate(
  options: OperationOptions,
  operation: "register" | "heartbeat" | "deregister",
  url: URL,
  body: string | null,
  signal: AbortSignal,
  missingIsSuccess: boolean
): Promise<"accepted" | "missing"> {
  const response = await execute(
    options,
    operation,
    consulRequest(options, url, "PUT", body, signal)
  )
  if (response.ok) {
    discard(response)
    return "accepted"
  }
  if (missingIsSuccess && response.status === 404) {
    discard(response)
    return "missing"
  }
  discard(response)
  throw newHttpError(operation, response.status)
}

/** Executes one JSON query and fully consumes its response before settling. */
export async function queryText(
  options: OperationOptions,
  operation: "readback" | "get" | "watch",
  url: URL,
  signal: AbortSignal,
  missingIsEmpty: boolean
): Promise<readonly [string, string | null, number]> {
  const response = await execute(
    options,
    operation,
    consulRequest(options, url, "GET", null, signal)
  )
  if (missingIsEmpty && response.status === 404) {
    discard(response)
    const result: readonly [string, string | null, number] = [
      "",
      response.headers.get("X-Consul-Index"),
      response.status
    ]
    return Object.freeze(result)
  }
  if (!response.ok) {
    discard(response)
    throw newHttpError(operation, response.status)
  }
  const text = await response.text()
  const result: readonly [string, string | null, number] = [
    text,
    response.headers.get("X-Consul-Index"),
    response.status
  ]
  return Object.freeze(result)
}

/** Reports whether an operation, Fetch, or HTTP failure is availability-retryable. */
export function retryable(value: unknown): boolean {
  if (value === deadlineExceeded) return true
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === "LIKEGO_CONSUL_TRANSPORT") return true
  if (
    value.code !== "LIKEGO_CONSUL_HTTP" ||
    !("status" in value) ||
    typeof value.status !== "number"
  )
    return false
  return value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500
}
