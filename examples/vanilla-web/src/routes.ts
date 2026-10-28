/**
 * Handles a request using only standard Web APIs.
 *
 * @param request - Incoming standard Request.
 * @returns A JSON response containing stable request facts.
 */
export function requestSummary(request: Request): Response {
  const url = new URL(request.url)
  return Response.json({ method: request.method, path: url.pathname })
}
