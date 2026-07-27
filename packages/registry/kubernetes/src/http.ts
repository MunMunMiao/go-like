import { newRegistryProtocolError } from "@likego/registry/provider"

import { newHttpError, newTransportError } from "./errors"
import type { OperationOptions } from "./options"
import type { KubernetesHttpError, KubernetesOperation } from "./types"

/** Reports whether one failure may be retried without changing semantic input. */
export function retryable(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === "LIKEGO_KUBERNETES_TRANSPORT") return true
  if (value.code !== "LIKEGO_KUBERNETES_HTTP" || !("status" in value)) return false
  return (
    typeof value.status === "number" &&
    (value.status === 408 || value.status === 429 || value.status >= 500)
  )
}

/** Reports whether one failure is an optimistic concurrency conflict. */
export function conflict(value: unknown): value is KubernetesHttpError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "LIKEGO_KUBERNETES_HTTP" &&
    "status" in value &&
    value.status === 409
  )
}

/** Reports whether one API response says the requested object does not exist. */
export function notFound(value: unknown): value is KubernetesHttpError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "LIKEGO_KUBERNETES_HTTP" &&
    "status" in value &&
    value.status === 404
  )
}

/** Reports whether one watch cursor has expired. */
export function gone(value: unknown): value is KubernetesHttpError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "LIKEGO_KUBERNETES_HTTP" &&
    "status" in value &&
    value.status === 410
  )
}

/** Creates one secret-safe standard Request for the Kubernetes API. */
function request(
  options: OperationOptions,
  path: string,
  method: string,
  body: string | null,
  signal: AbortSignal
): Request {
  const headers = new Headers({ Accept: "application/json" })
  if (body !== null) headers.set("Content-Type", "application/json")
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`)
  return new Request(new URL(path, options.origin), {
    method,
    headers,
    body,
    signal,
    redirect: "error"
  })
}

/** Executes one borrowed Fetch call and normalizes its boundary failure. */
export async function response(
  options: OperationOptions,
  operation: KubernetesOperation,
  path: string,
  method: string,
  body: string | null,
  signal: AbortSignal
): Promise<Response> {
  let result: Response
  try {
    result = await options.fetch(request(options, path, method, body, signal))
  } catch (value) {
    if (signal.aborted) throw signal.reason
    throw newTransportError(operation, value, options.token !== undefined)
  }
  if (!result.ok) {
    try {
      await result.body?.cancel()
    } catch {
      // Cancellation is only best-effort after the status has already failed the operation.
    }
    throw newHttpError(operation, result.status)
  }
  return result
}

/** Reads one successful Kubernetes JSON response with fail-closed syntax. */
export async function json(
  options: OperationOptions,
  operation: KubernetesOperation,
  path: string,
  method: string,
  body: string | null,
  signal: AbortSignal
): Promise<unknown> {
  const result = await response(options, operation, path, method, body, signal)
  try {
    return await result.json()
  } catch (error) {
    const cause = error instanceof Error ? error : undefined
    throw newRegistryProtocolError(`Kubernetes ${operation} response is not valid JSON`, cause)
  }
}
