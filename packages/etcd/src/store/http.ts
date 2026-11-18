import { cause, type Context } from "@go-like/core/context"
import { waitForContext } from "@go-like/core/context"

import { etcdHeaders, etcdUrl, grpcCode } from "../client/http"
import {
  newEtcdStoreHttpError,
  newEtcdStoreProtocolError,
  newEtcdStoreTransportError
} from "./errors"
import type { CapturedOptions } from "./options"
import type { EtcdStoreOperation } from "./types"

/** Observes one intentionally detached best-effort body cancellation. */
function ignoreFailure(_value: unknown): void {}

/** Returns one Context's exact terminal cause while it is canceled. */
export function contextFailure(ctx: Context): Error | null {
  return cause(ctx)
}

/** Creates one provider-owned POST request that never follows redirects. */
function etcdRequest(
  ctx: Context,
  options: CapturedOptions,
  operation: EtcdStoreOperation,
  path: string,
  body: unknown
): Request {
  let encoded: string
  try {
    encoded = JSON.stringify(body)
  } catch {
    throw newEtcdStoreProtocolError(operation)
  }
  return new Request(etcdUrl(options.origin, path), {
    method: "POST",
    headers: etcdHeaders(options.token),
    body: encoded,
    redirect: "error",
    signal: ctx.done() ?? new AbortController().signal
  })
}

/** Starts best-effort response-body cancellation without replacing a primary result. */
export function discard(response: Response): void {
  if (response.body === null) return
  try {
    void response.body.cancel().catch(ignoreFailure)
  } catch {
    return
  }
}

/** Executes one borrowed Fetch while the caller Context bounds only this operation. */
async function execute(
  ctx: Context,
  options: CapturedOptions,
  operation: EtcdStoreOperation,
  request: Request
): Promise<Response> {
  const initial = contextFailure(ctx)
  if (initial !== null) throw initial
  let pending: Promise<Response>
  try {
    pending = Promise.resolve(options.fetch(request))
  } catch (value) {
    throw newEtcdStoreTransportError(operation, value, options.token !== undefined)
  }
  let response: Response
  try {
    response = await waitForContext(ctx, pending)
  } catch (value) {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    throw newEtcdStoreTransportError(operation, value, options.token !== undefined)
  }
  const canceled = contextFailure(ctx)
  if (canceled !== null) {
    discard(response)
    throw canceled
  }
  if (!(response instanceof Response)) throw newEtcdStoreProtocolError(operation)
  return response
}

/** Reads one response body while retaining Context cancellation authority. */
async function responseText(
  ctx: Context,
  response: Response,
  operation: EtcdStoreOperation
): Promise<string> {
  let pending: Promise<string>
  try {
    pending = Promise.resolve(response.text())
  } catch {
    throw newEtcdStoreProtocolError(operation)
  }
  try {
    return await waitForContext(ctx, pending)
  } catch {
    const canceled = contextFailure(ctx)
    if (canceled !== null) throw canceled
    throw newEtcdStoreProtocolError(operation)
  }
}

/** Executes one etcd v3 JSON gateway request and parses exactly one JSON document. */
export async function postJson(
  ctx: Context,
  options: CapturedOptions,
  operation: EtcdStoreOperation,
  path: string,
  body: unknown
): Promise<unknown> {
  const request = etcdRequest(ctx, options, operation, path, body)
  const response = await execute(ctx, options, operation, request)
  if (!response.ok) {
    let code: number | null = null
    try {
      code = grpcCode(await responseText(ctx, response, operation))
    } catch {
      const canceled = contextFailure(ctx)
      if (canceled !== null) throw canceled
      discard(response)
    }
    throw newEtcdStoreHttpError(operation, response.status, code)
  }
  const text = await responseText(ctx, response, operation)
  try {
    return JSON.parse(text)
  } catch {
    throw newEtcdStoreProtocolError(operation)
  }
}
