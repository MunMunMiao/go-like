import {
  boundaryError,
  newConsulHttpError,
  newConsulTransportError,
  type ConsulOperation
} from "./errors"
import { consulHeaders } from "./http"
import type { Connection } from "./options"

/** Consul KV read consistency, applied as an empty query flag. */
export type ConsulConsistency = "default" | "consistent" | "stale"

/** One raw KV read, including an absent key observed by a blocking query. */
export interface KvQueryResult {
  readonly text: string
  readonly cursor: KvCursor
  readonly missing: boolean
}

/** A Consul index clamped so the next blocking request cannot busy-loop at zero. */
export interface KvCursor {
  readonly text: string
  readonly value: bigint
}

/** Parameters of one exact raw KV read. */
export interface KvTarget {
  readonly connection: Connection
  readonly keyPath: string
  readonly consistency: ConsulConsistency
  readonly waitMs: number
}

/** Parses and clamps a Consul index so the next blocking request cannot busy-loop at zero. */
export function kvCursor(value: string | null): KvCursor {
  if (value === null || !/^[0-9]+$/u.test(value)) {
    throw new TypeError("Consul response requires a decimal X-Consul-Index")
  }
  const parsed = BigInt(value)
  return parsed === 0n
    ? Object.freeze({ text: "1", value: 1n })
    : Object.freeze({ text: value, value: parsed })
}

/** Returns the official zero cursor used only after observing an index rollback. */
export function resetKvCursor(): KvCursor {
  return Object.freeze({ text: "0", value: 0n })
}

/** Observes a best-effort body cancellation rejection without replacing HTTP status. */
function ignoreBodyCancellationFailure(_error: unknown): void {}

/** Observes a late body rejection after Request cancellation already won the operation. */
function ignoreLateBodyFailure(_error: unknown): void {}

/** Classifies transport and availability failures as retryable. A missing key is not a failure. */
export function retryableKvFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value) || !("status" in value)) {
    if (typeof value === "object" && value !== null && "code" in value) {
      return value.code === "GO_LIKE_CONSUL_TRANSPORT"
    }
    return false
  }
  if (value.code !== "GO_LIKE_CONSUL_HTTP" || typeof value.status !== "number") return false
  return value.status === 408 || value.status === 425 || value.status === 429 || value.status >= 500
}

/** Joins one response-body read while allowing the Request signal to bound non-cooperative Fetch. */
function waitForBody(signal: AbortSignal, pending: Promise<string>): Promise<string> {
  if (signal.aborted) {
    void pending.catch(ignoreLateBodyFailure)
    return Promise.reject(signal.reason)
  }
  /** Owns the signal observer until either response body or cancellation settles. */
  function executor(resolve: (text: string) => void, reject: (error: unknown) => void): void {
    /** Resolves the body branch and detaches its signal observer. */
    function fulfilled(text: string): void {
      signal.removeEventListener("abort", aborted)
      resolve(text)
    }
    /** Rejects the body branch and detaches its signal observer. */
    function rejected(error: unknown): void {
      signal.removeEventListener("abort", aborted)
      reject(error)
    }
    /** Rejects immediately with the exact Request cancellation reason. */
    function aborted(): void {
      reject(signal.reason)
    }
    signal.addEventListener("abort", aborted, { once: true })
    void pending.then(fulfilled, rejected)
  }
  return new Promise<string>(executor)
}

/** Reads one successful response body and classifies every body failure as transport failure. */
async function readSuccessfulBody(
  response: Response,
  signal: AbortSignal | null,
  operation: Extract<ConsulOperation, "config.load" | "config.watch">,
  secret: boolean
): Promise<string> {
  let pending: Promise<string>
  try {
    pending = Promise.resolve(response.text())
  } catch (value) {
    throw newConsulTransportError(operation, value, secret)
  }
  try {
    return signal === null ? await pending : await waitForBody(signal, pending)
  } catch (value) {
    if (signal !== null && signal.aborted) throw signal.reason
    throw newConsulTransportError(operation, value, secret)
  }
}

/** Starts a non-blocking body cancellation so its failure or latency cannot replace HTTP status. */
function discardErrorBody(response: Response): void {
  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    return
  }
  if (body === null) return
  try {
    void Promise.resolve(body.cancel()).catch(ignoreBodyCancellationFailure)
  } catch {
    return
  }
}

/** Performs one raw KV request. HTTP 404 is an absent key, not an HTTP error. */
export async function queryKv(
  target: KvTarget,
  signal: AbortSignal | null,
  index: string | null,
  operation: Extract<ConsulOperation, "config.load" | "config.watch">
): Promise<KvQueryResult> {
  const connection = target.connection
  const headers = consulHeaders(connection.token, false, "text/plain")
  const url = new URL(`/v1/kv/${target.keyPath}`, connection.origin)
  url.searchParams.set("raw", "true")
  if (connection.datacenter !== undefined) url.searchParams.set("dc", connection.datacenter)
  if (connection.namespace !== undefined) url.searchParams.set("ns", connection.namespace)
  if (target.consistency !== "default") url.searchParams.set(target.consistency, "")
  if (index !== null) {
    url.searchParams.set("index", index)
    url.searchParams.set("wait", `${target.waitMs}ms`)
  }
  const request =
    signal === null
      ? new Request(url, { headers, redirect: "error" })
      : new Request(url, { headers, redirect: "error", signal })
  const secret = connection.token !== undefined
  let response: Response
  try {
    response = await connection.fetch(request)
  } catch (value) {
    throw newConsulTransportError(
      operation,
      boundaryError(value, "Consul KV transport failed"),
      secret
    )
  }
  if (response.status === 404) {
    discardErrorBody(response)
    const header = response.headers.get("X-Consul-Index")
    const cursor =
      operation === "config.load" && (header === null || !/^[0-9]+$/u.test(header))
        ? resetKvCursor()
        : kvCursor(header)
    return Object.freeze({ text: "", cursor, missing: true })
  }
  if (!response.ok) {
    discardErrorBody(response)
    throw newConsulHttpError(operation, response.status)
  }
  const text = await readSuccessfulBody(response, signal, operation, secret)
  return Object.freeze({
    text,
    cursor: kvCursor(response.headers.get("X-Consul-Index")),
    missing: false
  })
}
