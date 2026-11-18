/** Creates the Vault headers. Token and namespace are attached only when captured. */
export function vaultHeaders(
  token: string | undefined,
  namespace: string | undefined,
  json: boolean
): Headers {
  const headers = new Headers({ Accept: "application/json" })
  if (json) headers.set("Content-Type", "application/json")
  if (token !== undefined) headers.set("X-Vault-Token", token)
  if (namespace !== undefined) headers.set("X-Vault-Namespace", namespace)
  return headers
}

/** Creates one Vault Request that never follows redirects and never sets an absent signal. */
export function vaultHttpRequest(
  url: URL,
  method: "GET" | "POST",
  headers: Headers,
  body: string | null,
  signal: AbortSignal | null
): Request {
  return new Request(url, {
    method,
    headers,
    ...(body === null ? {} : { body }),
    redirect: "error",
    ...(signal === null ? {} : { signal })
  })
}

/**
 * Reports whether a transport rejection may carry token or namespace bytes.
 * Namespace stays protected, matching the previous store boundary.
 */
export function secretBearing(token: string | undefined, namespace: string | undefined): boolean {
  return token !== undefined || namespace !== undefined
}
