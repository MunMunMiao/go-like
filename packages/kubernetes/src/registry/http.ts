import { newRegistryProtocolError } from "@go-like/core/registry/provider"

import {
  kubernetesHttpCode,
  newKubernetesHttpError,
  newKubernetesTransportError,
  registryOperation,
  type KubernetesHttpError,
  type RegistryWireOperation
} from "../client/errors"
import { kubernetesHeaders } from "../client/http"
import type { OperationOptions } from "./options"

/** Reports whether one failure may be retried without changing semantic input. */
export function retryable(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) return false
  if (value.code === "GO_LIKE_KUBERNETES_TRANSPORT") return true
  if (value.code !== "GO_LIKE_KUBERNETES_HTTP" || !("status" in value)) return false
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
    value.code === kubernetesHttpCode &&
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
    value.code === kubernetesHttpCode &&
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
    value.code === kubernetesHttpCode &&
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
  return new Request(new URL(path, options.origin), {
    method,
    headers: kubernetesHeaders(options.token, body !== null),
    body,
    signal,
    redirect: "error"
  })
}

/** Executes one borrowed Fetch call and normalizes its boundary failure. */
export async function response(
  options: OperationOptions,
  operation: RegistryWireOperation,
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
    throw newKubernetesTransportError(
      registryOperation(operation),
      value,
      options.token !== undefined
    )
  }
  if (!result.ok) {
    try {
      await result.body?.cancel()
    } catch {
      // Cancellation is only best-effort after the status has already failed the operation.
    }
    throw newKubernetesHttpError(registryOperation(operation), result.status)
  }
  return result
}

/** Reads one successful Kubernetes JSON response with fail-closed syntax. */
export async function json(
  options: OperationOptions,
  operation: RegistryWireOperation,
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
