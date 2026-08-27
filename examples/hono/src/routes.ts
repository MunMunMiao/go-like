import type { Context } from "hono"

/**
 * Returns the selected user identifier from the Hono route context.
 *
 * @param context - Hono request context created by its router.
 * @returns A framework-identifying JSON response.
 */
export function userRoute(context: Context): Response {
  return context.json({ framework: "hono", id: context.req.param("id") })
}
