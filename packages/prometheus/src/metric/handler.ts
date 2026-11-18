import type { Handler } from "@go-like/core/web"
import { Registry, type RegistryContentType } from "prom-client"

/** Options for the scrape handler. */
export interface PrometheusHandlerOptions {
  /** Scrape path. The default is `/metrics`. */
  readonly path?: string
}

const DefaultPath = "/metrics"
const CacheControl = "no-store"
const PlainTextContentType = "text/plain; charset=utf-8"
const MetricsUnavailable = "metrics unavailable\n"
const NotFound = "not found\n"
const MethodNotAllowed = "method not allowed\n"
const Encoder = new TextEncoder()

/** Registry surface required to serve one scrape. */
interface ScrapeRegistry {
  metrics(): Promise<string>
  readonly contentType: string
}

/** Accepts the official registry contract across duplicate prom-client installations. */
function supportsScrape(value: unknown): value is ScrapeRegistry {
  if (typeof value !== "object" || value === null) return false
  try {
    if (!("metrics" in value) || typeof value.metrics !== "function") return false
    if (!("contentType" in value)) return false
    return (
      value.contentType === Registry.PROMETHEUS_CONTENT_TYPE ||
      value.contentType === Registry.OPENMETRICS_CONTENT_TYPE
    )
  } catch {
    return false
  }
}

/** Returns the UTF-8 byte length used for an explicit HTTP Content-Length header. */
function contentLength(body: string): string {
  return String(Encoder.encode(body).byteLength)
}

/** Validates and captures one already-normalized absolute URL pathname. */
function metricsPath(value: string | undefined): string {
  const path = value ?? DefaultPath
  if (path.length === 0 || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new TypeError("path must be a normalized absolute URL pathname")
  }
  const normalized = new URL(path, "http://go-like.invalid").pathname
  if (normalized !== path) {
    throw new TypeError("path must be a normalized absolute URL pathname")
  }
  return path
}

/** Creates a response whose body and byte length remain correct for GET and HEAD. */
function textResponse(
  method: string,
  body: string,
  status: number,
  contentType: string,
  extraHeaders?: Readonly<Record<string, string>>
): Response {
  const headers = new Headers(extraHeaders)
  headers.set("Cache-Control", CacheControl)
  headers.set("Content-Type", contentType)
  headers.set("Content-Length", contentLength(body))
  return new Response(method === "HEAD" ? null : body, { status, headers })
}

/**
 * Adapts one application-owned prom-client Registry to the core Web Handler.
 * GET and HEAD collect a fresh scrape. The application keeps registry ownership.
 */
export function createPrometheusHandler(
  registry: Registry<RegistryContentType>,
  options?: PrometheusHandlerOptions
): Handler {
  if (!supportsScrape(registry)) {
    throw new TypeError("registry must support the prom-client Registry scrape contract")
  }
  const scrapeRegistry = registry
  const path = metricsPath(options?.path)

  /** Collects one scrape while keeping collector failures out of the public response body. */
  async function prometheusHandler(request: Request): Promise<Response> {
    const method = request.method.toUpperCase()
    if (new URL(request.url).pathname !== path) {
      return textResponse(method, NotFound, 404, PlainTextContentType)
    }
    if (method !== "GET" && method !== "HEAD") {
      return textResponse(method, MethodNotAllowed, 405, PlainTextContentType, {
        Allow: "GET, HEAD"
      })
    }
    try {
      const body = await scrapeRegistry.metrics()
      return textResponse(method, body, 200, scrapeRegistry.contentType)
    } catch {
      return textResponse(method, MetricsUnavailable, 500, PlainTextContentType)
    }
  }

  return prometheusHandler
}
