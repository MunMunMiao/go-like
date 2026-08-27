import { cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"

import { decodeRows, type ConsulRow } from "./codec"
import {
  isUncertainFailure,
  newConsulStoreHttpError,
  newConsulStoreProtocolError,
  newConsulStoreTransportError,
  newConsulStoreUncertainError
} from "./errors"
import type { CapturedOptions } from "./options"
import type { ConsulStoreOperation } from "./types"

/** Describes one Consul KV mutation mode. */
export type MutationMode =
  | { readonly kind: "plain" }
  | { readonly kind: "cas"; readonly revision: string }
  | { readonly kind: "acquire"; readonly session: string }
  | { readonly kind: "release"; readonly session: string }

/** Carries one recursive KV response and the Consul index that produced it. */
export interface ConsulIndexedRows {
  readonly rows: readonly ConsulRow[]
  readonly index: string
}

/** Observes one intentionally detached best-effort body cancellation. */
export function ignoreFailure(_value: unknown): void {}

/** Returns the exact terminal Context cause while preserving identity. */
export function contextFailure(ctx: Context): Error | null {
  return cause(ctx)
}

/** Encodes one exact Consul key without URL-normalized dot path segments. */
export function encodedKey(key: string): string {
  const parts = key.split("/")
  const encoded: string[] = []
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new TypeError("Consul Store key cannot contain a dot path segment")
    }
    encoded.push(encodeURIComponent(part))
  }
  return encoded.join("/")
}

/** Maps one logical Store key or prefix into its isolated Consul KV root. */
function rootedKey(options: CapturedOptions, key: string): string {
  return `${options.root}/${key}`
}

/** Creates one scoped Consul API URL without placing ACL material in it. */
export function consulUrl(options: CapturedOptions, path: string): URL {
  const url = new URL(path, options.origin)
  if (options.datacenter !== undefined) url.searchParams.set("dc", options.datacenter)
  if (options.namespace !== undefined) url.searchParams.set("ns", options.namespace)
  return url
}

/** Creates secret-bearing headers locally at the final Request boundary. */
function consulHeaders(options: CapturedOptions, json: boolean): Headers {
  const headers = new Headers({ Accept: "application/json" })
  if (json) headers.set("Content-Type", "application/json")
  if (options.token !== undefined) headers.set("X-Consul-Token", options.token)
  return headers
}

/** Creates one provider-owned Request that never follows redirects. */
function consulRequest(
  ctx: Context,
  options: CapturedOptions,
  url: URL,
  method: "GET" | "PUT" | "DELETE",
  body: string | null,
  json: boolean
): Request {
  const signal = ctx.done() ?? new AbortController().signal
  return new Request(url, {
    method,
    headers: consulHeaders(options, json),
    ...(body === null ? {} : { body }),
    redirect: "error",
    signal
  })
}

/** Starts best-effort response-body cancellation without changing status authority. */
function discard(response: Response): void {
  if (response.body === null) return
  try {
    void response.body.cancel().catch(ignoreFailure)
  } catch {
    return
  }
}

/** Executes one borrowed Fetch while Context bounds only the current operation. */
async function execute(
  ctx: Context,
  options: CapturedOptions,
  operation: ConsulStoreOperation,
  request: Request
): Promise<Response> {
  const initial = contextFailure(ctx)
  if (initial !== null) throw initial
  let pending: Promise<Response>
  try {
    pending = Promise.resolve(options.fetch(request))
  } catch (value) {
    throw newConsulStoreTransportError(operation, value, options.token !== undefined)
  }
  let response: Response
  try {
    response = await waitForContext(ctx, pending)
  } catch (value) {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    throw newConsulStoreTransportError(operation, value, options.token !== undefined)
  }
  const canceled = contextFailure(ctx)
  if (canceled !== null) {
    discard(response)
    throw canceled
  }
  if (!(response instanceof Response)) {
    throw newConsulStoreProtocolError(operation)
  }
  return response
}

/** Reads one successful response body while Context remains authoritative. */
async function responseText(
  ctx: Context,
  response: Response,
  operation: ConsulStoreOperation
): Promise<string> {
  let pending: Promise<string>
  try {
    pending = Promise.resolve(response.text())
  } catch {
    throw newConsulStoreProtocolError(operation)
  }
  try {
    return await waitForContext(ctx, pending)
  } catch {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    throw newConsulStoreProtocolError(operation)
  }
}

/** Reads one exact or recursive Consul KV response with optional index authority. */
async function query(
  ctx: Context,
  options: CapturedOptions,
  operation: "read" | "write" | "delete" | "list",
  key: string,
  recurse: boolean,
  requireIndex: boolean
): Promise<{ readonly rows: readonly ConsulRow[]; readonly index: string }> {
  const url = consulUrl(options, `/v1/kv/${encodedKey(rootedKey(options, key))}`)
  url.searchParams.set("consistent", "")
  if (recurse) url.searchParams.set("recurse", "true")
  const response = await execute(
    ctx,
    options,
    operation,
    consulRequest(ctx, options, url, "GET", null, false)
  )
  const suppliedIndex = response.headers.get("X-Consul-Index")
  if (requireIndex && (suppliedIndex === null || !/^[1-9]\d*$/u.test(suppliedIndex))) {
    discard(response)
    throw newConsulStoreProtocolError(operation)
  }
  const index = suppliedIndex ?? ""
  if (response.status === 404) {
    discard(response)
    return Object.freeze({ rows: Object.freeze([]), index })
  }
  if (!response.ok) {
    discard(response)
    throw newConsulStoreHttpError(operation, response.status)
  }
  return Object.freeze({
    rows: decodeRows(
      await responseText(ctx, response, operation),
      operation,
      rootedKey(options, "")
    ),
    index
  })
}

/** Reads one exact or recursive Consul KV response with strong consistency. */
export async function queryRows(
  ctx: Context,
  options: CapturedOptions,
  operation: "read" | "write" | "delete" | "list",
  key: string,
  recurse: boolean
): Promise<readonly ConsulRow[]> {
  return (await query(ctx, options, operation, key, recurse, false)).rows
}

/** Reads one recursive list snapshot and requires its Consul index header. */
export async function queryIndexedRows(
  ctx: Context,
  options: CapturedOptions,
  key: string
): Promise<ConsulIndexedRows> {
  const result = await query(ctx, options, "list", key, true, true)
  return Object.freeze({ rows: result.rows, index: result.index })
}

/** Reads one exact Consul KV row and rejects ambiguous provider responses. */
export async function queryExact(
  ctx: Context,
  options: CapturedOptions,
  operation: "read" | "write" | "delete",
  key: string
): Promise<ConsulRow | null> {
  const rows = await queryRows(ctx, options, operation, key, false)
  if (rows.length === 0) return null
  const row = rows[0]
  if (rows.length !== 1 || row === undefined || row.record.key !== key) {
    throw newConsulStoreProtocolError(operation)
  }
  return row
}

/** Applies one Consul KV mutation mode to a fresh URL. */
function mutationUrl(options: CapturedOptions, key: string, mode: MutationMode): URL {
  const url = consulUrl(options, `/v1/kv/${encodedKey(rootedKey(options, key))}`)
  if (mode.kind === "cas") url.searchParams.set("cas", mode.revision)
  else if (mode.kind === "acquire") url.searchParams.set("acquire", mode.session)
  else if (mode.kind === "release") url.searchParams.set("release", mode.session)
  return url
}

/** Executes one boolean Consul KV write or delete response. */
export async function mutateKey(
  ctx: Context,
  options: CapturedOptions,
  operation: "write" | "delete",
  key: string,
  payload: string | null,
  mode: MutationMode
): Promise<boolean> {
  const method = payload === null ? "DELETE" : "PUT"
  const response = await execute(
    ctx,
    options,
    operation,
    consulRequest(ctx, options, mutationUrl(options, key, mode), method, payload, false)
  )
  if (!response.ok) {
    discard(response)
    throw newConsulStoreHttpError(operation, response.status)
  }
  const body = (await responseText(ctx, response, operation)).trim()
  if (body === "true") return true
  if (body === "false") return false
  throw newConsulStoreProtocolError(operation)
}

/** Parses one session-list response into exact ID and name tuples. */
function sessionRows(text: string): readonly (readonly [string, string])[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw newConsulStoreProtocolError("session-readback")
  }
  if (!Array.isArray(value)) throw newConsulStoreProtocolError("session-readback")
  const rows: (readonly [string, string])[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw newConsulStoreProtocolError("session-readback")
    }
    const id = Object.getOwnPropertyDescriptor(item, "ID")?.value
    const name = Object.getOwnPropertyDescriptor(item, "Name")?.value
    if (typeof id !== "string" || id.length === 0 || typeof name !== "string") {
      throw newConsulStoreProtocolError("session-readback")
    }
    rows.push(Object.freeze([id, name]))
  }
  return Object.freeze(rows)
}

/** Reads all sessions and resolves one unique operation name. */
async function sessionByName(
  ctx: Context,
  options: CapturedOptions,
  name: string
): Promise<string | null> {
  const response = await execute(
    ctx,
    options,
    "session-readback",
    consulRequest(ctx, options, consulUrl(options, "/v1/session/list"), "GET", null, false)
  )
  if (!response.ok) {
    discard(response)
    throw newConsulStoreHttpError("session-readback", response.status)
  }
  let found: string | null = null
  for (const row of sessionRows(await responseText(ctx, response, "session-readback"))) {
    if (row[1] !== name) continue
    if (found !== null) throw newConsulStoreProtocolError("session-readback")
    found = row[0]
  }
  return found
}

/** Reads whether one exact Consul session remains present. */
async function sessionExists(
  ctx: Context,
  options: CapturedOptions,
  session: string
): Promise<boolean> {
  const response = await execute(
    ctx,
    options,
    "session-readback",
    consulRequest(
      ctx,
      options,
      consulUrl(options, `/v1/session/info/${encodeURIComponent(session)}`),
      "GET",
      null,
      false
    )
  )
  if (!response.ok) {
    discard(response)
    throw newConsulStoreHttpError("session-readback", response.status)
  }
  return sessionRows(await responseText(ctx, response, "session-readback")).length !== 0
}

/** Creates one unrenewed behavior-delete TTL session with uncertain-response readback. */
export async function createSession(
  ctx: Context,
  options: CapturedOptions,
  operationId: string,
  ttlMs: number
): Promise<string> {
  const name = `go-like-store:${operationId}`
  const body = JSON.stringify({
    Name: name,
    Behavior: "delete",
    TTL: `${ttlMs}ms`,
    LockDelay: "0s",
    NodeChecks: []
  })
  let primary: Error | null = null
  try {
    const response = await execute(
      ctx,
      options,
      "session-create",
      consulRequest(ctx, options, consulUrl(options, "/v1/session/create"), "PUT", body, true)
    )
    if (!response.ok) {
      discard(response)
      throw newConsulStoreHttpError("session-create", response.status)
    }
    const text = await responseText(ctx, response, "session-create")
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw newConsulStoreProtocolError("session-create")
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw newConsulStoreProtocolError("session-create")
    }
    const id = Object.getOwnPropertyDescriptor(value, "ID")?.value
    if (typeof id !== "string" || id.length === 0) {
      throw newConsulStoreProtocolError("session-create")
    }
    return id
  } catch (value) {
    if (!isUncertainFailure(value)) throw value
    primary = value instanceof Error ? value : newConsulStoreProtocolError("session-create")
  }
  const found = await sessionByName(ctx, options, name)
  if (found !== null) return found
  throw newConsulStoreUncertainError("session-create", primary)
}

/** Destroys one exact session and proves uncertain responses through session readback. */
export async function destroySession(
  ctx: Context,
  options: CapturedOptions,
  session: string
): Promise<void> {
  let primary: Error | null = null
  try {
    const response = await execute(
      ctx,
      options,
      "session-destroy",
      consulRequest(
        ctx,
        options,
        consulUrl(options, `/v1/session/destroy/${encodeURIComponent(session)}`),
        "PUT",
        null,
        false
      )
    )
    if (!response.ok) {
      discard(response)
      throw newConsulStoreHttpError("session-destroy", response.status)
    }
    const body = (await responseText(ctx, response, "session-destroy")).trim()
    if (body === "true") return
    if (body !== "false") throw newConsulStoreProtocolError("session-destroy")
    primary = newConsulStoreProtocolError("session-destroy")
  } catch (value) {
    if (!isUncertainFailure(value)) throw value
    primary = value instanceof Error ? value : newConsulStoreProtocolError("session-destroy")
  }
  if (!(await sessionExists(ctx, options, session))) return
  throw newConsulStoreUncertainError("session-destroy", primary)
}
