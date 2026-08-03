import type { Context } from "@likego/context"
import type { ProbeRegistry } from "@likego/health"
import { contextHandler, type Handler } from "./context"

const defaultLivePath = "/livez"
const defaultReadyPath = "/readyz"
const cacheControl = "no-store"
const allowMethods = "GET, HEAD"
const jsonType = "application/json; charset=utf-8"
const unavailablePayload = '{"status":"unavailable","checks":[]}'
const publicNamePattern = /^[A-Za-z0-9._-]+$/

interface Route {
  readonly kind: "live" | "ready"
  readonly path: string
}

export interface HealthHandlerOptions {
  readonly livePath?: string
  readonly readyPath?: string
}

interface PublicProbeResult {
  readonly name: string
  readonly ok: boolean
}

interface PublicProbeReport {
  readonly ok: boolean
  readonly checks: readonly PublicProbeResult[]
}

interface PublicProbePayload {
  readonly name: string
  readonly status: "ok" | "failed"
}

/** Verifies the structural registry boundary used by the Web handler. */
function assertRegistry(registry: ProbeRegistry): void {
  if (
    registry === null ||
    typeof registry !== "object" ||
    typeof registry.register !== "function" ||
    typeof registry.check !== "function"
  ) {
    throw new TypeError("registry must implement ProbeRegistry")
  }
}

/** Captures one normalized absolute health endpoint pathname. */
function snapshotPath(path: string, label: string): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError(`${label} must be an absolute pathname`)
  }
  const parsed = new URL(path, "http://likego.local")
  if (parsed.pathname !== path || parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(`${label} must be an absolute normalized pathname`)
  }
  return parsed.pathname
}

/** Maps a public probe boolean to its stable wire status. */
function statusText(ok: boolean): "ok" | "failed" {
  return ok ? "ok" : "failed"
}

/** Maps one sanitized probe result to its stable public payload. */
function resultEntry(check: PublicProbeResult): PublicProbePayload {
  return Object.freeze({ name: check.name, status: statusText(check.ok) })
}

/** Reports whether one sanitized probe result is healthy. */
function probeSucceeded(check: PublicProbeResult): boolean {
  return check.ok
}

/** Recognizes Error values across realms when the runtime provides Error.isError. */
function isError(value: unknown): value is Error {
  const errorConstructor: unknown = Error
  if (
    typeof errorConstructor === "function" &&
    "isError" in errorConstructor &&
    typeof errorConstructor.isError === "function"
  ) {
    return errorConstructor.isError(value)
  }
  return value instanceof Error
}

/** Serializes only the public health fields into the deterministic JSON contract. */
function resultPayload(report: PublicProbeReport): string {
  return JSON.stringify({
    status: report.ok ? "ok" : "unavailable",
    checks: report.checks.map(resultEntry)
  })
}

/** Snapshots and validates one untrusted structural probe result. */
function snapshotProbeResult(value: unknown): PublicProbeResult | null {
  if (value === null || typeof value !== "object") return null
  const name = "name" in value ? value.name : undefined
  const ok = "ok" in value ? value.ok : undefined
  const error = "error" in value ? value.error : undefined
  if (
    typeof name !== "string" ||
    !publicNamePattern.test(name) ||
    typeof ok !== "boolean" ||
    (ok ? error !== null : !isError(error))
  ) {
    return null
  }
  return Object.freeze({ name, ok })
}

/** Snapshots an untrusted report while rejecting inconsistent aggregate state. */
function snapshotProbeReport(value: unknown, kind: "live" | "ready"): PublicProbeReport | null {
  try {
    if (value === null || typeof value !== "object") return null
    const candidateKind = "kind" in value ? value.kind : undefined
    const ok = "ok" in value ? value.ok : undefined
    const candidateChecks = "checks" in value ? value.checks : undefined
    if (candidateKind !== kind || typeof ok !== "boolean" || !Array.isArray(candidateChecks)) {
      return null
    }

    const length = candidateChecks.length
    const checks: PublicProbeResult[] = []
    for (let index = 0; index < length; index += 1) {
      const check = snapshotProbeResult(candidateChecks[index])
      if (check === null) return null
      checks.push(check)
    }
    const checksOk = checks.every(probeSucceeded)
    const aggregateOk = checksOk && (kind === "live" || checks.length > 0)
    if (ok !== aggregateOk) return null
    return Object.freeze({ ok, checks: Object.freeze(checks) })
  } catch {
    return null
  }
}

/** Builds a cache-disabled JSON response with GET and HEAD metadata parity. */
function jsonResponse(payload: string, status: number, head: boolean): Response {
  return new Response(head ? null : payload, {
    status,
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": jsonType,
      "Content-Length": String(new TextEncoder().encode(payload).byteLength)
    }
  })
}

/** Builds a bodyless cache-disabled health routing response. */
function emptyResponse(status: number, headers?: Record<string, string>): Response {
  const responseHeaders = new Headers({ "Cache-Control": cacheControl })
  if (headers !== undefined) {
    for (const entry of Object.entries(headers)) {
      responseHeaders.set(entry[0], entry[1])
    }
  }
  return new Response(null, {
    status,
    headers: responseHeaders
  })
}

/** Executes one health route and sanitizes every registry boundary failure. */
async function routeHealth(
  registry: ProbeRegistry,
  route: Route,
  ctx: Context,
  request: Request
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return emptyResponse(405, { Allow: allowMethods })
  }

  const head = request.method === "HEAD"
  try {
    const report = await registry.check(ctx, route.kind)
    const snapshot = snapshotProbeReport(report, route.kind)
    if (snapshot === null) {
      return jsonResponse(unavailablePayload, 503, head)
    }
    const payload = resultPayload(snapshot)
    return jsonResponse(payload, snapshot.ok ? 200 : 503, head)
  } catch {
    return jsonResponse(unavailablePayload, 503, head)
  }
}

/** Creates a standard one-argument Web handler for liveness and readiness endpoints. */
export function createHealthHandler(
  registry: ProbeRegistry,
  options?: HealthHandlerOptions
): Handler {
  assertRegistry(registry)
  const capturedRegistry = registry
  const livePath = snapshotPath(options?.livePath ?? defaultLivePath, "livePath")
  const readyPath = snapshotPath(options?.readyPath ?? defaultReadyPath, "readyPath")
  if (livePath === readyPath) throw new TypeError("livePath and readyPath must be distinct")
  const routes: readonly Route[] = Object.freeze([
    Object.freeze({ kind: "live", path: livePath }),
    Object.freeze({ kind: "ready", path: readyPath })
  ])

  /** Routes one request through the captured health endpoint table. */
  function handleHealth(ctx: Context, request: Request): Response | Promise<Response> {
    const pathname = new URL(request.url).pathname
    let route: Route | undefined
    for (const candidate of routes) {
      if (candidate.path === pathname) {
        route = candidate
        break
      }
    }
    if (route === undefined) return emptyResponse(404)
    return routeHealth(capturedRegistry, route, ctx, request)
  }
  return contextHandler(handleHealth)
}
