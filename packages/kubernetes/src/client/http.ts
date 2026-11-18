import { kubernetesHttpCode, kubernetesTransportCode } from "./errors"

/** Reads one own data property without invoking accessors. */
function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/** Creates secret-bearing headers without exposing their values elsewhere. */
export function kubernetesHeaders(token: string | undefined, jsonBody: boolean): Headers {
  const headers = new Headers({ Accept: "application/json" })
  if (jsonBody) headers.set("Content-Type", "application/json")
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`)
  return headers
}

/** Reports whether a config failure may be retried. Status 425 is retryable; the old config HTTP code is not. */
export function retryableConfigFailure(value: unknown): boolean {
  if (property(value, "code") === kubernetesTransportCode) return true
  if (property(value, "code") !== kubernetesHttpCode) return false
  const status = property(value, "status")
  return (
    typeof status === "number" &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  )
}

/** Reports whether a config watch cursor has expired. */
export function configWatchExpired(value: unknown): boolean {
  return property(value, "code") === kubernetesHttpCode && property(value, "status") === 410
}
