import type { Discovery, Selector } from "@go-like/registry"
import type { TLSConfig, TLSEncodedBytes } from "@go-like/transport"

/** Captures the construction-only settings of one managed gRPC Client. */
export interface ClientOptions {
  readonly addresses: readonly string[]
  readonly service: string | null
  readonly discovery: Discovery | null
  readonly selector: Selector | null
  readonly block: boolean
  readonly tlsConfig: TLSConfig | null
}

/** Immutably reduces managed gRPC Client construction settings. */
export type ClientOption = (options: ClientOptions) => ClientOptions

const defaultClientOptions: ClientOptions = Object.freeze({
  addresses: Object.freeze([]),
  service: null,
  discovery: null,
  selector: null,
  block: false,
  tlsConfig: null
})

/** Validates and canonicalizes one native gRPC origin without accepting path routing. */
export function canonicalAddress(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("gRPC address must be a non-empty string")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new TypeError("gRPC address must be an absolute URL", { cause })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("gRPC address must use http or https")
  }
  if (url.username.length !== 0 || url.password.length !== 0) {
    throw new TypeError("gRPC address must not contain credentials")
  }
  if (url.pathname !== "/") throw new TypeError("gRPC address must be a root URL")
  if (url.search.length !== 0) throw new TypeError("gRPC address must not contain a query")
  if (url.hash.length !== 0) throw new TypeError("gRPC address must not contain a fragment")
  return url.origin + "/"
}

/** Reports whether one value implements the public Discovery surface. */
function isDiscovery(value: unknown): value is Discovery {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "getService") === "function" &&
    typeof Reflect.get(value, "watch") === "function"
  )
}

/** Reports whether one value implements the public Selector surface. */
function isSelector(value: unknown): value is Selector {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "select") === "function"
  )
}

/** Copies encoded TLS bytes and returns a fresh copy for every later read. */
function snapshotTLSBytes(value: TLSEncodedBytes | null): TLSEncodedBytes | null {
  if (value === null) return null
  if (value.encoding !== "pem" && value.encoding !== "der") {
    throw new TypeError("TLS material encoding must be pem or der")
  }
  if (!(value.bytes instanceof Uint8Array)) {
    throw new TypeError("TLS material bytes must be a Uint8Array")
  }
  const bytes = new Uint8Array(value.bytes)
  return Object.freeze({
    encoding: value.encoding,
    get bytes(): Uint8Array {
      return new Uint8Array(bytes)
    }
  })
}

/** Copies all portable TLS material without retaining caller-owned byte arrays. */
function snapshotTLSConfig(value: TLSConfig | null): TLSConfig | null {
  if (value === null) return null
  if (value.serverName !== null && typeof value.serverName !== "string") {
    throw new TypeError("TLS serverName must be a string or null")
  }
  return Object.freeze({
    serverName: value.serverName,
    caCertificate: snapshotTLSBytes(value.caCertificate),
    certificateChain: snapshotTLSBytes(value.certificateChain),
    privateKey: snapshotTLSBytes(value.privateKey)
  })
}

/** Copies one complete options candidate after every functional reduction. */
function snapshotOptions(value: ClientOptions): ClientOptions {
  if (!Array.isArray(value.addresses)) throw new TypeError("Client addresses must be an array")
  const addresses = Object.freeze(value.addresses.map(canonicalAddress))
  if (value.service !== null && (typeof value.service !== "string" || value.service.length === 0)) {
    throw new TypeError("Client service must be a non-empty string or null")
  }
  if (value.discovery !== null && !isDiscovery(value.discovery)) {
    throw new TypeError("Client discovery must implement Discovery")
  }
  if (value.selector !== null && !isSelector(value.selector)) {
    throw new TypeError("Client selector must implement Selector")
  }
  if (typeof value.block !== "boolean") throw new TypeError("Client block must be a boolean")
  return Object.freeze({
    addresses,
    service: value.service,
    discovery: value.discovery,
    selector: value.selector,
    block: value.block,
    tlsConfig: snapshotTLSConfig(value.tlsConfig)
  })
}

/** Resolves and validates the mutually exclusive direct and Discovery modes. */
export function clientOptions(options: readonly ClientOption[]): ClientOptions {
  let current = defaultClientOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Client option must be a function")
    current = snapshotOptions(option(current))
  }
  if (new Set(current.addresses).size !== current.addresses.length) {
    throw new TypeError("Client addresses must not contain duplicates")
  }
  if (current.addresses.length > 0 && current.discovery !== null) {
    throw new TypeError("newClient cannot combine direct addresses with discovery")
  }
  if (current.discovery !== null && current.service === null) {
    throw new TypeError("newClient discovery requires a service option")
  }
  if (current.discovery === null && current.service !== null) {
    throw new TypeError("newClient service option requires discovery")
  }
  if (current.addresses.length === 0 && current.discovery === null) {
    throw new TypeError("newClient requires direct addresses or discovery")
  }
  validateTLSConfig(current.tlsConfig)
  const hasHTTPAddress = current.addresses.some((address) => address.startsWith("http:"))
  if (current.tlsConfig !== null && hasHTTPAddress) {
    throw new TypeError("http gRPC addresses cannot use TLS configuration")
  }
  return current
}

/** Requires the current Node HTTP/2 runtime's PEM certificate representation. */
function validatePEM(
  value: TLSEncodedBytes | null,
  field: string,
  labels: readonly string[]
): void {
  if (value === null) return
  if (value.encoding !== "pem") throw new TypeError(`${field} must use PEM encoding`)
  const text = new TextDecoder().decode(value.bytes).trim()
  const valid = labels.some(
    (label) => text.includes(`-----BEGIN ${label}-----`) && text.includes(`-----END ${label}-----`)
  )
  if (!valid) throw new TypeError(`${field} must contain PEM material`)
}

/** Validates the portable TLS snapshot before any address owner can be created. */
export function validateTLSConfig(value: TLSConfig | null): void {
  if (value === null) return
  if ((value.certificateChain === null) !== (value.privateKey === null)) {
    throw new TypeError("TLS certificate and private key must be configured together")
  }
  validatePEM(value.caCertificate, "TLS CA certificate", ["CERTIFICATE"])
  validatePEM(value.certificateChain, "TLS certificate chain", ["CERTIFICATE"])
  validatePEM(value.privateKey, "TLS private key", [
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY"
  ])
}

/** Configures one or more construction-time direct gRPC addresses. */
export function withAddress(...addresses: readonly string[]): ClientOption {
  if (addresses.length === 0) throw new TypeError("withAddress requires at least one address")
  const captured = Object.freeze(addresses.map(canonicalAddress))
  if (new Set(captured).size !== captured.length) {
    throw new TypeError("withAddress must not contain duplicate addresses")
  }
  return (options) => Object.freeze({ ...options, addresses: captured })
}

/** Configures the construction-time Discovery service identity. */
export function withService(service: string): ClientOption {
  if (typeof service !== "string" || service.length === 0) {
    throw new TypeError("withService requires a non-empty service")
  }
  return (options) => Object.freeze({ ...options, service })
}

/** Configures the shared public Discovery implementation. */
export function withDiscovery(discovery: Discovery): ClientOption {
  if (!isDiscovery(discovery)) throw new TypeError("discovery must implement Discovery")
  return (options) => Object.freeze({ ...options, discovery })
}

/** Configures the public Registry Selector used for every call. */
export function withSelector(selector: Selector): ClientOption {
  if (!isSelector(selector)) throw new TypeError("selector must implement Selector")
  return (options) => Object.freeze({ ...options, selector })
}

/** Requests blocking Discovery until the first endpoint becomes available. */
export function withBlock(): ClientOption {
  return (options) => Object.freeze({ ...options, block: true })
}

/** Configures a defensive portable TLS snapshot for future HTTPS owners. */
export function withTLSConfig(config: TLSConfig | null): ClientOption {
  const captured = snapshotTLSConfig(config)
  return (options) => Object.freeze({ ...options, tlsConfig: captured })
}

/** Captures the construction-only settings of one managed gRPC Server. */
export interface ServerOptions {
  readonly address: string
  readonly advertise: string | null
  readonly tlsConfig: TLSConfig | null
  readonly clientAuth: "none" | "require"
}

/** Immutably reduces managed gRPC Server construction settings. */
export type ServerOption = (options: ServerOptions) => ServerOptions

/** One parsed native bind authority. */
export interface ServerBindAddress {
  readonly host: string
  readonly port: number
}

/** One validated advertised authority or absolute endpoint. */
export interface ServerAdvertiseAddress {
  readonly absolute: URL | null
  readonly host: string
  readonly port: string
}

const defaultServerOptions: ServerOptions = Object.freeze({
  address: "127.0.0.1:0",
  advertise: null,
  tlsConfig: null,
  clientAuth: "none"
})

/** Parses one native host:port authority without accepting URL routing. */
export function parseServerAddress(value: unknown): ServerBindAddress {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("gRPC server address must be a non-empty host:port")
  }
  let authority: URL
  try {
    authority = new URL(`go-like-grpc://${value}`)
  } catch (cause) {
    throw new TypeError("gRPC server address must be a host:port", { cause })
  }
  if (
    authority.hostname.length === 0 ||
    authority.port.length === 0 ||
    authority.username.length !== 0 ||
    authority.password.length !== 0 ||
    authority.pathname.length !== 0 ||
    authority.search.length !== 0 ||
    authority.hash.length !== 0
  ) {
    throw new TypeError("gRPC server address must be a host:port")
  }
  const port = Number(authority.port)
  const hostname = authority.hostname
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  return Object.freeze({ host, port })
}

/** Parses one advertised host, host:port, or absolute root HTTP endpoint. */
export function parseServerAdvertise(value: unknown): ServerAdvertiseAddress {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("gRPC server advertise must be a non-empty value")
  }
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(value)
  if (scheme !== null) {
    if (scheme[1]?.toLowerCase() !== "http" && scheme[1]?.toLowerCase() !== "https") {
      throw new TypeError("gRPC server advertise endpoint must use http or https")
    }
    let absolute: URL
    try {
      absolute = new URL(value)
    } catch (cause) {
      throw new TypeError("gRPC server advertise endpoint must be an absolute root URL", {
        cause
      })
    }
    if (
      absolute.hostname.length === 0 ||
      absolute.username.length !== 0 ||
      absolute.password.length !== 0 ||
      absolute.pathname !== "/" ||
      absolute.search.length !== 0 ||
      absolute.hash.length !== 0
    ) {
      throw new TypeError("gRPC server advertise endpoint must be an absolute root URL")
    }
    return Object.freeze({ absolute, host: absolute.hostname, port: absolute.port })
  }
  let authority: URL
  try {
    authority = new URL(`go-like-grpc://${value}`)
  } catch (cause) {
    throw new TypeError("gRPC server advertise must be a host, host:port, or HTTP endpoint", {
      cause
    })
  }
  if (
    authority.hostname.length === 0 ||
    authority.username.length !== 0 ||
    authority.password.length !== 0 ||
    authority.pathname.length !== 0 ||
    authority.search.length !== 0 ||
    authority.hash.length !== 0
  ) {
    throw new TypeError("gRPC server advertise must be a host, host:port, or HTTP endpoint")
  }
  let host: string
  try {
    host = new URL(`http://${authority.hostname}/`).hostname
  } catch (cause) {
    throw new TypeError("gRPC server advertise must contain a valid HTTP host", { cause })
  }
  return Object.freeze({ absolute: null, host, port: authority.port })
}

/** Reports whether one normalized host is unspecified for publication. */
export function isWildcardServerHost(value: string): boolean {
  return value === "0.0.0.0" || value === "::" || value === "[::]"
}

/** Validates one immutable managed Server options candidate. */
function snapshotServerOptions(value: ServerOptions): ServerOptions {
  parseServerAddress(value.address)
  if (value.advertise !== null) parseServerAdvertise(value.advertise)
  if (value.clientAuth !== "none" && value.clientAuth !== "require") {
    throw new TypeError("gRPC server clientAuth must be none or require")
  }
  return Object.freeze({
    address: value.address,
    advertise: value.advertise,
    tlsConfig: snapshotTLSConfig(value.tlsConfig),
    clientAuth: value.clientAuth
  })
}

/** Resolves and validates one complete managed gRPC Server snapshot. */
export function serverOptions(options: readonly ServerOption[]): ServerOptions {
  let current = defaultServerOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Server option must be a function")
    current = snapshotServerOptions(option(current))
  }
  const bind = parseServerAddress(current.address)
  const advertised = current.advertise === null ? null : parseServerAdvertise(current.advertise)
  if (isWildcardServerHost(bind.host) && advertised === null) {
    throw new TypeError("gRPC server wildcard bound address requires explicit advertise")
  }
  if (advertised !== null && isWildcardServerHost(advertised.host)) {
    throw new TypeError("gRPC server advertise must not use a wildcard host")
  }
  if (advertised?.port === "0") {
    throw new TypeError("gRPC server advertise port must be greater than zero")
  }
  const config = current.tlsConfig
  if (config === null) {
    if (current.clientAuth === "require") {
      throw new TypeError("gRPC h2c server cannot require TLS client authentication")
    }
  } else {
    if (config.serverName !== null) {
      throw new TypeError("gRPC server TLS does not accept serverName")
    }
    validateTLSConfig(config)
    if (config.certificateChain === null || config.privateKey === null) {
      throw new TypeError("gRPC server TLS requires a certificate and private key")
    }
    if (current.clientAuth === "require" && config.caCertificate === null) {
      throw new TypeError("gRPC server required client authentication requires a PEM CA")
    }
  }
  if (advertised?.absolute !== null && advertised?.absolute !== undefined) {
    const expected = config === null ? "http:" : "https:"
    if (advertised.absolute.protocol !== expected) {
      throw new TypeError("gRPC server advertise scheme must match TLS configuration")
    }
  }
  return current
}

/** Configures the native gRPC bind authority. */
export function address(value: string): ServerOption {
  parseServerAddress(value)
  return (options) => Object.freeze({ ...options, address: value })
}

/** Configures the externally published authority or absolute endpoint. */
export function advertise(value: string): ServerOption {
  parseServerAdvertise(value)
  return (options) => Object.freeze({ ...options, advertise: value })
}

/** Configures a defensive portable TLS snapshot for one native Server. */
export function tlsConfig(value: TLSConfig | null): ServerOption {
  const captured = snapshotTLSConfig(value)
  return (options) => Object.freeze({ ...options, tlsConfig: captured })
}

/** Configures whether the TLS Server requires a trusted client certificate. */
export function clientAuth(value: "none" | "require"): ServerOption {
  if (value !== "none" && value !== "require") {
    throw new TypeError("clientAuth must be none or require")
  }
  return (options) => Object.freeze({ ...options, clientAuth: value })
}
