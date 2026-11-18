/** Creates secret-bearing JSON gateway headers. The token is the raw Authorization value. */
export function etcdHeaders(token: string | undefined): Headers {
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" })
  if (token !== undefined) headers.set("Authorization", token)
  return headers
}

/** Builds one gateway URL from the captured origin and a path. */
export function etcdUrl(origin: string, path: string): URL {
  return new URL(path, origin)
}

interface GatewayErrorCandidate {
  readonly code?: unknown
}

/**
 * Extracts a numeric gRPC code from an error body.
 * Bodies longer than 64 KiB and non-integer codes are absent.
 */
export function grpcCode(value: string): number | null {
  if (value.length > 65_536) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const candidate: GatewayErrorCandidate = parsed
  return typeof candidate.code === "number" && Number.isSafeInteger(candidate.code)
    ? candidate.code
    : null
}
