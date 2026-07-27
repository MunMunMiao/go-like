import type { KubernetesHttpError, KubernetesOperation, KubernetesTransportError } from "./types"

/** Narrows an untrusted rejection without retaining a non-Error carrier. */
export function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Creates one status-only HTTP error without reading response bytes. */
export function newHttpError(operation: KubernetesOperation, status: number): KubernetesHttpError {
  return Object.freeze(
    Object.assign(new Error(`Kubernetes ${operation} request failed with HTTP ${status}`), {
      name: "KubernetesHttpError" as const,
      code: "LIKEGO_KUBERNETES_HTTP" as const,
      operation,
      status
    })
  )
}

/** Creates one Fetch error while stripping secret-bearing rejection graphs. */
export function newTransportError(
  operation: KubernetesOperation,
  value: unknown,
  secretBoundary: boolean
): KubernetesTransportError {
  const cause = secretBoundary
    ? new Error(`Kubernetes ${operation} transport rejected at a secret-bearing boundary`)
    : boundaryError(value, `Kubernetes ${operation} transport rejected with a non-Error value`)
  return Object.freeze(
    Object.assign(new Error(`Kubernetes ${operation} transport failed`, { cause }), {
      name: "KubernetesTransportError" as const,
      code: "LIKEGO_KUBERNETES_TRANSPORT" as const,
      operation,
      cause
    })
  )
}
