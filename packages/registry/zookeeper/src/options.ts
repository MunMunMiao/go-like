import { providerOptions, type ProviderOptions } from "@go-like/registry/provider"

import type {
  ZookeeperAcl,
  ZookeeperClientFactory,
  ZookeeperClientFactoryOptions,
  ZookeeperRegistryOptions
} from "./types"

const maximumTimerMs = 2_147_483_647

/** Captures constructor-only ZooKeeper controls and secret bytes. */
export interface CapturedOptions {
  readonly connectionString: string
  readonly root: string
  readonly auth: {
    readonly scheme: string
    readonly credential: Uint8Array
  } | null
  readonly acl: ZookeeperAcl
  readonly sessionTimeoutMs: number
  readonly spinDelayMs: number
  readonly retries: number
  readonly retryInitialMs: number
  readonly retryMaximumMs: number
  readonly reconcileIntervalMs: number
  readonly watchBufferSize: number
  readonly clientFactory: ZookeeperClientFactory
  readonly common: ProviderOptions
}

/** Binds one operation or owner to an effective common snapshot. */
export interface OperationOptions extends CapturedOptions {
  readonly timeoutMs: number
}

/** Validates one finite inclusive integer provider control. */
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`ZooKeeper ${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Canonicalizes one credentials-free ZooKeeper host and optional port. */
export function zookeeperAddress(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes(",") ||
    value.includes("/") ||
    value.includes("@") ||
    /\s/.test(value)
  ) {
    throw new TypeError("ZooKeeper address must be one credentials-free host[:port]")
  }
  const separator = value.lastIndexOf(":")
  const host = separator < 0 ? value : value.slice(0, separator)
  const port = separator < 0 ? "" : value.slice(separator + 1)
  if (!/^[A-Za-z0-9._-]+$/.test(host)) {
    throw new TypeError("ZooKeeper address host is invalid")
  }
  if (
    separator >= 0 &&
    (port === "" || !/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
  ) {
    throw new TypeError("ZooKeeper address port is invalid")
  }
  return port === "" ? host : `${host}:${Number(port)}`
}

/** Validates one absolute provider-owned znode root without normalizing it. */
export function zookeeperRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 8_192 ||
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    // oxlint-disable-next-line eslint/no-control-regex -- Znode roots reject C0 and DEL exactly.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError("ZooKeeper root must be an absolute non-root znode path")
  }
  for (const segment of value.slice(1).split("/")) {
    if (segment === "." || segment === "..") {
      throw new TypeError("ZooKeeper root must not contain relative path segments")
    }
  }
  return value
}

/** Copies and validates one optional secret-bearing authentication value. */
function authentication(value: ZookeeperRegistryOptions["auth"]): CapturedOptions["auth"] {
  if (value === undefined) return null
  if (value === null || typeof value !== "object") {
    throw new TypeError("ZooKeeper auth must be an object")
  }
  const scheme = value.scheme
  const raw = value.credential
  if (typeof scheme !== "string" || !/^[A-Za-z0-9._-]+$/.test(scheme)) {
    throw new TypeError("ZooKeeper auth scheme is invalid")
  }
  let credential: Uint8Array
  if (typeof raw === "string") credential = new TextEncoder().encode(raw)
  else if (raw instanceof Uint8Array) credential = raw.slice()
  else throw new TypeError("ZooKeeper auth credential must be a string or Uint8Array")
  if (credential.length === 0 || credential.length > 1_048_576) {
    throw new RangeError("ZooKeeper auth credential byte length is invalid")
  }
  return Object.freeze({ scheme, credential })
}

/** Captures every construction getter once without performing network I/O. */
export function captureOptions(
  value: ZookeeperRegistryOptions,
  defaultFactory: ZookeeperClientFactory
): CapturedOptions {
  if (value === null || typeof value !== "object") {
    throw new TypeError("ZooKeeper Registry options must be an object")
  }
  const address = zookeeperAddress(value.address)
  const root = zookeeperRoot(value.root ?? "/go-like/registry/v1")
  const auth = authentication(value.auth)
  const acl = value.acl ?? "open"
  const sessionTimeoutMs = value.sessionTimeoutMs ?? 30_000
  const spinDelayMs = value.spinDelayMs ?? 1_000
  const retries = value.retries ?? 0
  const retryInitialMs = value.retryInitialMs ?? 250
  const retryMaximumMs = value.retryMaximumMs ?? 30_000
  const reconcileIntervalMs = value.reconcileIntervalMs ?? 5_000
  const watchBufferSize = value.watchBufferSize ?? 128
  const clientFactory = value.clientFactory ?? defaultFactory
  if (acl !== "open" && acl !== "creator") {
    throw new TypeError("ZooKeeper acl must be open or creator")
  }
  if (acl === "creator" && auth === null) {
    throw new TypeError("ZooKeeper creator ACL requires authentication")
  }
  if (typeof clientFactory !== "function") {
    throw new TypeError("ZooKeeper clientFactory must be callable")
  }
  boundedInteger(sessionTimeoutMs, 2_000, 600_000, "sessionTimeoutMs")
  boundedInteger(spinDelayMs, 1, 60_000, "spinDelayMs")
  boundedInteger(retries, 0, 100, "retries")
  boundedInteger(retryInitialMs, 1, 60_000, "retryInitialMs")
  boundedInteger(retryMaximumMs, retryInitialMs, 600_000, "retryMaximumMs")
  boundedInteger(reconcileIntervalMs, 100, 60_000, "reconcileIntervalMs")
  boundedInteger(watchBufferSize, 1, 4_096, "watchBufferSize")
  return Object.freeze({
    connectionString: address,
    root,
    auth,
    acl,
    sessionTimeoutMs,
    spinDelayMs,
    retries,
    retryInitialMs,
    retryMaximumMs,
    reconcileIntervalMs,
    watchBufferSize,
    clientFactory,
    common: providerOptions(value)
  })
}

/** Binds one provider snapshot to one effective Registry option snapshot. */
export function operationOptions(
  provider: CapturedOptions,
  common: ProviderOptions,
  timeoutMs = common.timeoutMs
): OperationOptions {
  return Object.freeze({
    connectionString: provider.connectionString,
    root: provider.root,
    auth: provider.auth,
    acl: provider.acl,
    sessionTimeoutMs: provider.sessionTimeoutMs,
    spinDelayMs: provider.spinDelayMs,
    retries: provider.retries,
    retryInitialMs: provider.retryInitialMs,
    retryMaximumMs: provider.retryMaximumMs,
    reconcileIntervalMs: provider.reconcileIntervalMs,
    watchBufferSize: provider.watchBufferSize,
    clientFactory: provider.clientFactory,
    common,
    timeoutMs: boundedInteger(timeoutMs, 1, maximumTimerMs, "operation timeoutMs")
  })
}

/** Creates one fresh secret-bearing native client option snapshot. */
export function clientOptions(options: OperationOptions): ZookeeperClientFactoryOptions {
  const auth =
    options.auth === null
      ? null
      : Object.freeze({
          scheme: options.auth.scheme,
          credential: options.auth.credential.slice()
        })
  return Object.freeze({
    connectionString: options.connectionString,
    sessionTimeoutMs: options.sessionTimeoutMs,
    spinDelayMs: options.spinDelayMs,
    retries: options.retries,
    auth,
    acl: options.acl
  })
}
