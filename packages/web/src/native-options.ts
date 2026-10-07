export interface NativeServerOptions {
  readonly hostname: string
  readonly port: number
  readonly shutdownTimeoutMs: number
}

/** Produces the next immutable native host options snapshot. */
export type NativeServerOption = (options: NativeServerOptions) => NativeServerOptions

const maximumTimerDelayMs = 2_147_483_647

export const defaultNativeOptions: NativeServerOptions = Object.freeze({
  hostname: "127.0.0.1",
  port: 0,
  shutdownTimeoutMs: 25_000
})

/** Validates and freezes one structural options snapshot returned by application code. */
export function snapshotNativeOptions(
  id: string,
  options: NativeServerOptions
): NativeServerOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError(`${id} server options must be an object`)
  }
  const capturedHostname = options.hostname
  const capturedPort = options.port
  const capturedTimeout = options.shutdownTimeoutMs
  if (typeof capturedHostname !== "string" || capturedHostname === "") {
    throw new TypeError(`${id} hostname must be a non-empty string`)
  }
  if (!Number.isInteger(capturedPort) || capturedPort < 0 || capturedPort > 65_535) {
    throw new TypeError(`${id} port must be an integer in 0..65535`)
  }
  if (
    !Number.isFinite(capturedTimeout) ||
    capturedTimeout < 0 ||
    capturedTimeout > maximumTimerDelayMs
  ) {
    throw new RangeError(
      `${id} shutdownTimeoutMs must be finite and from 0 to ${maximumTimerDelayMs}`
    )
  }
  return Object.freeze({
    hostname: capturedHostname,
    port: capturedPort,
    shutdownTimeoutMs: capturedTimeout
  })
}

/** Replaces one field in a freshly validated snapshot and validates the result again. */
function replaceOption(
  id: string,
  options: NativeServerOptions,
  change: Partial<NativeServerOptions>
): NativeServerOptions {
  return snapshotNativeOptions(id, { ...snapshotNativeOptions(id, options), ...change })
}

/** Creates the hostname option for one native runtime after validating its value. */
export function nativeHostname(id: string, value: string): NativeServerOption {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${id} hostname must be a non-empty string`)
  }
  /** Replaces only the hostname in one validated immutable snapshot. */
  function configureHostname(options: NativeServerOptions): NativeServerOptions {
    return replaceOption(id, options, { hostname: value })
  }
  return configureHostname
}

/** Creates the port option for one native runtime after validating its value. */
export function nativePort(id: string, value: number): NativeServerOption {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError(`${id} port must be an integer in 0..65535`)
  }
  /** Replaces only the port in one validated immutable snapshot. */
  function configurePort(options: NativeServerOptions): NativeServerOptions {
    return replaceOption(id, options, { port: value })
  }
  return configurePort
}

/** Creates the graceful-drain timeout option for one native runtime after validating its value. */
export function nativeShutdownTimeout(id: string, timeoutMs: number): NativeServerOption {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > maximumTimerDelayMs) {
    throw new RangeError(`${id}ShutdownTimeout must be finite and from 0 to ${maximumTimerDelayMs}`)
  }
  /** Replaces only the shutdown timeout in one validated immutable snapshot. */
  function configureShutdownTimeout(options: NativeServerOptions): NativeServerOptions {
    return replaceOption(id, options, { shutdownTimeoutMs: timeoutMs })
  }
  return configureShutdownTimeout
}

/** Captures and validates functional options into private immutable configuration. */
export function captureNativeOptions(
  id: string,
  options: readonly NativeServerOption[]
): NativeServerOptions {
  let config = defaultNativeOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError(`${id} server option must be callable`)
    config = snapshotNativeOptions(id, option(config))
  }
  return config
}
