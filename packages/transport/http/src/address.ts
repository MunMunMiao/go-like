/** Carries one normalized unary Fetch endpoint. */
export interface HTTPDialTarget {
  readonly href: string
  readonly origin: string
}

/** Reports whether value begins with an explicit URI scheme. */
function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)
}

/** Parses and validates one absolute HTTP endpoint. */
function absoluteTarget(value: string, requireSecure: boolean): HTTPDialTarget {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new TypeError("HTTP dial address must be a valid absolute URL", { cause: error })
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("HTTP dial URL scheme must be http or https")
  }
  if (requireSecure && parsed.protocol !== "https:") {
    throw new TypeError("secure HTTP transport requires an https URL")
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("HTTP dial URL must not contain credentials")
  }
  if (parsed.href.includes("#")) throw new TypeError("HTTP dial URL must not contain a fragment")
  return Object.freeze({ href: parsed.href, origin: parsed.origin })
}

/** Parses and validates one host-port authority without path, query, or fragment. */
function authorityTarget(value: string, requireSecure: boolean): HTTPDialTarget {
  if (value.includes("/") || value.includes("?") || value.includes("#") || value.includes("@")) {
    throw new TypeError(
      "HTTP dial authority must not contain path, query, fragment, or credentials"
    )
  }
  const bracketed = /^\[[^\]]+\]:\d+$/.test(value)
  const named = /^[^:[\]]+:\d+$/.test(value)
  if (!bracketed && !named) throw new TypeError("HTTP dial authority must be host:port")
  const scheme = requireSecure ? "https" : "http"
  return absoluteTarget(`${scheme}://${value}`, requireSecure)
}

/** Normalizes one accepted absolute URL or host-port authority for unary Fetch. */
export function normalizeHTTPDialTarget(address: string, requireSecure: boolean): HTTPDialTarget {
  if (typeof address !== "string" || address.trim() === "") {
    throw new TypeError("HTTP dial address must be a non-empty string")
  }
  return hasScheme(address)
    ? absoluteTarget(address, requireSecure)
    : authorityTarget(address, requireSecure)
}

/** Validates and returns one host-port listen authority without URL components. */
export function normalizeHTTPListenAddress(address: string): string {
  if (typeof address !== "string" || address.trim() === "") {
    throw new TypeError("HTTP listen address must be a non-empty string")
  }
  if (
    hasScheme(address) ||
    address.includes("/") ||
    address.includes("?") ||
    address.includes("#") ||
    address.includes("@")
  ) {
    throw new TypeError("HTTP listen address must be a host:port authority")
  }
  const bracketed = /^\[[^\]]+\]:\d+$/.test(address)
  const named = /^[^:[\]]+:\d+$/.test(address)
  if (!bracketed && !named) throw new TypeError("HTTP listen address must be host:port")
  return address
}
