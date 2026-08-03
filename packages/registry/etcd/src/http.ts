import { deadlineExceeded } from "@likego/context"
import { newRegistryProtocolError } from "@likego/registry/provider"

import { newHttpError, newTransportError } from "./errors"
import type { OperationOptions } from "./options"
import { ignoreFailure, signalFailure } from "./runtime"
import type { EtcdOperation } from "./types"

/** Creates secret-bearing headers without exposing their values elsewhere. */
function etcdHeaders(options: OperationOptions): Headers {
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" })
  if (options.token !== undefined) headers.set("Authorization", options.token)
  return headers
}

/** Builds one provider-owned POST request that never follows redirects. */
function etcdRequest(
  options: OperationOptions,
  path: string,
  body: unknown,
  signal: AbortSignal
): Request {
  return new Request(new URL(path, options.origin), {
    method: "POST",
    headers: etcdHeaders(options),
    body: JSON.stringify(body),
    redirect: "error",
    signal
  })
}

/** Cancels one ignored body without allowing cancellation failure to replace status. */
function discard(response: Response): void {
  if (response.body !== null) void response.body.cancel().catch(ignoreFailure)
}

/** Executes one borrowed Fetch and sanitizes secret-bearing rejection graphs. */
async function execute(
  options: OperationOptions,
  operation: EtcdOperation,
  request: Request
): Promise<Response> {
  if (request.signal.aborted) {
    throw signalFailure(request.signal, `etcd ${operation} request was aborted`)
  }
  try {
    return await options.fetch(request)
  } catch (value) {
    if (request.signal.aborted) {
      throw signalFailure(request.signal, `etcd ${operation} request was aborted`)
    }
    throw newTransportError(operation, value, options.token !== undefined)
  }
}

/** Executes one JSON-gateway request and parses exactly one JSON response. */
export async function postJson(
  options: OperationOptions,
  operation: Exclude<EtcdOperation, "watch">,
  path: string,
  body: unknown,
  signal: AbortSignal
): Promise<unknown> {
  const response = await execute(options, operation, etcdRequest(options, path, body, signal))
  if (!response.ok) {
    discard(response)
    throw newHttpError(operation, response.status)
  }
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch (value) {
    throw newRegistryProtocolError(
      `etcd ${operation} response is not valid JSON`,
      value instanceof Error ? value : undefined
    )
  }
}

/** Opens one successful streaming watch response without consuming its body. */
export async function postWatch(
  options: OperationOptions,
  body: unknown,
  signal: AbortSignal
): Promise<Response> {
  const response = await execute(options, "watch", etcdRequest(options, "/v3/watch", body, signal))
  if (!response.ok) {
    discard(response)
    throw newHttpError("watch", response.status)
  }
  if (response.body === null) {
    throw newRegistryProtocolError("etcd watch response has no body")
  }
  return response
}

/** Reports whether one boundary failure is availability-retryable. */
export function retryable(value: unknown): boolean {
  if (value === deadlineExceeded) return true
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === "LIKEGO_ETCD_TRANSPORT") return true
  if (
    value.code !== "LIKEGO_ETCD_HTTP" ||
    !("status" in value) ||
    typeof value.status !== "number"
  ) {
    return false
  }
  return value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500
}
