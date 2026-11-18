import type { Context } from "../context"

const requests = new WeakMap<Request, Context>()

/** Stores the host Context for this exact Request object. */
export function bindRequestContext(request: Request, ctx: Context): void {
  requests.set(request, ctx)
}

/**
 * Returns the Context the core web host created for this exact Request.
 * A cloned Request, or one the host did not deliver, returns null.
 */
export function requestContext(request: Request): Context | null {
  if (!(request instanceof Request)) return null
  return requests.get(request) ?? null
}
