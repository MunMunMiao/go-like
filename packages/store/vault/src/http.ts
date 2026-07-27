import { cause, type Context } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"
import type { StoreRecordInput } from "@likego/store"
import { snapshotStoreRecord } from "@likego/store/provider"

import {
  decodeDataEnvelope,
  decodeDeletedVersion,
  decodeListKeys,
  decodeWriteVersion,
  encodeWriteBody,
  physicalKey,
  type VaultRow
} from "./codec"
import {
  isUncertainFailure,
  newHttpError,
  newProtocolError,
  newTransportError,
  newUncertainError,
  normalizeError
} from "./errors"
import type { CapturedOptions } from "./options"
import type { VaultStoreOperation } from "./types"

/** Returns one exact terminal Context cause while preserving identity. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  return failure === null ? null : (cause(ctx) ?? failure)
}

/** Creates one provider API URL for an exact KV v2 role and optional physical key. */
function apiUrl(
  options: CapturedOptions,
  role: "data" | "delete" | "metadata",
  key: string | null
): URL {
  const suffix = key === null ? options.root : `${options.root}/${key}`
  return new URL(`/v1/${options.mount}/${role}/${suffix}`, options.origin)
}

/** Creates one Vault Request with credentials only at the final HTTP boundary. */
function vaultRequest(
  ctx: Context,
  options: CapturedOptions,
  method: "GET" | "POST",
  url: URL,
  body: string | null
): Request {
  const headers = new Headers({ Accept: "application/json" })
  if (body !== null) headers.set("Content-Type", "application/json")
  if (options.token !== undefined) headers.set("X-Vault-Token", options.token)
  if (options.namespace !== undefined) headers.set("X-Vault-Namespace", options.namespace)
  return new Request(url, {
    method,
    headers,
    body,
    redirect: "error",
    signal: ctx.done() ?? new AbortController().signal
  })
}

/** Observes one intentionally detached best-effort cancellation failure. */
export function ignoreFailure(_value: unknown): void {}

/** Starts best-effort body cancellation without allowing it to replace status authority. */
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
  operation: VaultStoreOperation,
  request: Request
): Promise<Response> {
  const initial = contextFailure(ctx)
  if (initial !== null) throw initial
  let pending: Promise<Response>
  try {
    pending = Promise.resolve(options.fetch(request))
  } catch (value) {
    throw newTransportError(
      operation,
      value,
      options.token !== undefined || options.namespace !== undefined
    )
  }
  let response: Response
  try {
    response = await waitForContext(ctx, pending)
  } catch (value) {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    throw newTransportError(
      operation,
      value,
      options.token !== undefined || options.namespace !== undefined
    )
  }
  const canceled = contextFailure(ctx)
  if (canceled !== null) {
    if (response instanceof Response) discard(response)
    throw canceled
  }
  if (!(response instanceof Response)) throw newProtocolError(operation)
  return response
}

/** Reads one successful response body while Context remains authoritative. */
async function responseText(
  ctx: Context,
  response: Response,
  operation: VaultStoreOperation
): Promise<string> {
  let pending: Promise<string>
  try {
    pending = Promise.resolve(response.text())
  } catch {
    throw newProtocolError(operation)
  }
  try {
    return await waitForContext(ctx, pending)
  } catch {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    throw newProtocolError(operation)
  }
}

/** Parses one successful Vault JSON response without reflecting its text. */
async function responseJson(
  ctx: Context,
  response: Response,
  operation: VaultStoreOperation
): Promise<unknown> {
  const text = await responseText(ctx, response, operation)
  try {
    return JSON.parse(text)
  } catch {
    const failure = contextFailure(ctx)
    if (failure !== null) throw failure
    throw newProtocolError(operation)
  }
}

/** Reads one exact current KV v2 record. */
export async function readVault(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  operation: "read" | "delete" | "list" | "write"
): Promise<VaultRow | null> {
  const response = await execute(
    ctx,
    options,
    operation,
    vaultRequest(ctx, options, "GET", apiUrl(options, "data", physicalKey(key)), null)
  )
  if (response.status === 404) {
    discard(response)
    return null
  }
  if (!response.ok) {
    discard(response)
    throw newHttpError(operation, response.status)
  }
  return decodeDataEnvelope(await responseJson(ctx, response, operation), key, operation)
}

/** Reads whether one exact KV v2 version is absent or soft-deleted. */
async function versionDeleted(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  expectedVersion: number
): Promise<boolean> {
  const url = apiUrl(options, "data", physicalKey(key))
  url.searchParams.set("version", String(expectedVersion))
  const response = await execute(
    ctx,
    options,
    "delete",
    vaultRequest(ctx, options, "GET", url, null)
  )
  if (response.status === 404) {
    discard(response)
    return true
  }
  if (!response.ok) {
    discard(response)
    throw newHttpError("delete", response.status)
  }
  return decodeDeletedVersion(await responseJson(ctx, response, "delete"), expectedVersion)
}

/** Writes one idempotency-marked KV v2 record and proves uncertain responses by exact readback. */
export async function writeVault(
  ctx: Context,
  options: CapturedOptions,
  record: StoreRecordInput
): Promise<VaultRow> {
  const marker = crypto.randomUUID()
  const body = encodeWriteBody(record, marker)
  let primary: Error | null = null
  try {
    const response = await execute(
      ctx,
      options,
      "write",
      vaultRequest(ctx, options, "POST", apiUrl(options, "data", physicalKey(record.key)), body)
    )
    if (!response.ok) {
      discard(response)
      const failure = newHttpError("write", response.status)
      if (!isUncertainFailure(failure)) throw failure
      primary = failure
    } else {
      try {
        const revision = decodeWriteVersion(await responseJson(ctx, response, "write"))
        return Object.freeze({
          record: snapshotStoreRecord({
            key: record.key,
            value: record.value,
            metadata: record.metadata ?? {},
            revision,
            expiresAt: null
          }),
          operation: marker
        })
      } catch (value) {
        const canceled = contextFailure(ctx)
        if (canceled !== null) throw canceled
        if (!isUncertainFailure(value)) throw value
        primary = normalizeError(value)
      }
    }
  } catch (value) {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    if (!isUncertainFailure(value)) throw value
    primary = normalizeError(value)
  }
  try {
    const row = await readVault(ctx, options, record.key, "write")
    if (row !== null && row.operation === marker) return row
  } catch {
    throw newUncertainError("write", primary ?? newProtocolError("write"))
  }
  throw newUncertainError("write", primary ?? newProtocolError("write"))
}

/** Deletes one exact observed version and proves uncertain responses by version readback. */
export async function deleteVault(
  ctx: Context,
  options: CapturedOptions,
  key: string,
  expectedVersion: number
): Promise<void> {
  const body = JSON.stringify({ versions: [expectedVersion] })
  let primary: Error | null = null
  try {
    const response = await execute(
      ctx,
      options,
      "delete",
      vaultRequest(ctx, options, "POST", apiUrl(options, "delete", physicalKey(key)), body)
    )
    if (response.ok) {
      discard(response)
      return
    }
    discard(response)
    const failure = newHttpError("delete", response.status)
    if (!isUncertainFailure(failure)) throw failure
    primary = failure
  } catch (value) {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    if (!isUncertainFailure(value)) throw value
    primary = normalizeError(value)
  }
  try {
    if (await versionDeleted(ctx, options, key, expectedVersion)) return
  } catch {
    throw newUncertainError("delete", primary ?? newProtocolError("delete"))
  }
  throw newUncertainError("delete", primary ?? newProtocolError("delete"))
}

/** Lists every direct physical key under the isolated provider root. */
export async function listVault(
  ctx: Context,
  options: CapturedOptions
): Promise<readonly string[]> {
  const url = apiUrl(options, "metadata", null)
  url.searchParams.set("list", "true")
  const response = await execute(ctx, options, "list", vaultRequest(ctx, options, "GET", url, null))
  if (response.status === 404) {
    discard(response)
    return Object.freeze([])
  }
  if (!response.ok) {
    discard(response)
    throw newHttpError("list", response.status)
  }
  return decodeListKeys(await responseJson(ctx, response, "list"), "list")
}
