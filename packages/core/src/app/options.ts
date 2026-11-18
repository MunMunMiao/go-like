import { background, type Context } from "../context/index"
import { coreInstance } from "../internal/instance"
import { timerMs } from "../internal/timer"
import type { ProbeRegistry } from "../health/registry"
import type { Server } from "../lifecycle/index"
import type { Registrar } from "../registry/index"
import { isTelemetry } from "../telemetry/internal/resource"
import type { Telemetry, TelemetryLifecycle } from "../telemetry/types"

import { identityText, snapshotEndpoints, snapshotMetadata } from "./identity"

void coreInstance.version

/** Runs one application lifecycle hook. */
export type AppHook = (ctx: Context) => void | Promise<void>

/** Installs one runtime integration and returns its cleanup callback. */
export type RuntimeInstaller = (stop: () => Promise<void>) => () => void

declare const appOptionBrand: unique symbol

/**
 * Opaque application option.
 * Only the option constructors in this module can create one. `newApp` rejects every other value.
 */
export interface AppOption {
  readonly [appOptionBrand]: "AppOption"
}

/** Immutable application identity. */
export interface AppInfo {
  /** Returns the application instance identifier. */
  id(): string
  /** Returns the application service name. */
  name(): string
  /** Returns the application version. */
  version(): string
  /** Returns immutable application metadata. */
  metadata(): Readonly<Record<string, string>>
  /** Returns the declared application endpoints. */
  endpoint(): readonly string[]
}

/** One-shot application lifecycle. */
export interface App extends AppInfo {
  /** Runs the application lifecycle once. */
  run(): Promise<void>
  /** Requests idempotent graceful shutdown. `stop` takes no Context. */
  stop(): Promise<void>
}

/** Construction-time application configuration. Options mutate this object once. */
export interface AppConfig {
  parent: Context
  appId: string
  appName: string
  appVersion: string
  appMetadata: Readonly<Record<string, string>>
  appEndpoints: readonly string[]
  registrar: Registrar | null
  registrarTimeoutMs: number
  startTimeoutMs: number
  stopTimeoutMs: number
  servers: Server[]
  resources: Server[]
  telemetry: Telemetry | null
  readyProbe: { readonly registry: ProbeRegistry; readonly name: string } | null
  readonly beforeStartHooks: AppHook[]
  readonly afterStartHooks: AppHook[]
  readonly beforeStopHooks: AppHook[]
  readonly afterStopHooks: AppHook[]
  runtimeInstaller: RuntimeInstaller | null
}

const applicators = new WeakMap<AppOption, (config: AppConfig) => void>()

/** Stores `apply` behind an opaque option token. */
export function defineOption(apply: (config: AppConfig) => void): AppOption {
  const option = Object.freeze({}) as AppOption
  applicators.set(option, apply)
  return option
}

/** Applies one option. Any other value is a TypeError. */
export function applyOption(option: AppOption, config: AppConfig): void {
  const apply = applicators.get(option)
  if (apply === undefined) throw new TypeError("app option must come from an option constructor")
  apply(config)
}

/** Builds the default configuration. Identity defaults are filled before options run. */
export function newAppConfig(): AppConfig {
  return {
    parent: background(),
    appId: globalThis.crypto.randomUUID(),
    appName: "",
    appVersion: "",
    appMetadata: Object.freeze({}),
    appEndpoints: Object.freeze([]),
    registrar: null,
    registrarTimeoutMs: 10_000,
    startTimeoutMs: 0,
    stopTimeoutMs: 0,
    servers: [],
    resources: [],
    telemetry: null,
    readyProbe: null,
    beforeStartHooks: [],
    afterStartHooks: [],
    beforeStopHooks: [],
    afterStopHooks: [],
    runtimeInstaller: null
  }
}

/** Compile-time exclusion of a Telemetry bundle from participant lists. */
type NotTelemetry = {
  readonly [K in Exclude<keyof Telemetry, keyof TelemetryLifecycle>]?: never
}

/** Rejects one value that is a telemetry bundle passed to a participant list. */
function assertParticipant(value: unknown, label: "server" | "resource"): Server {
  if (isTelemetry(value)) throw new TypeError("pass telemetry with telemetry(...)")
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Server).start !== "function" ||
    typeof (value as Server).stop !== "function"
  ) {
    throw new TypeError(`${label} must implement Server`)
  }
  return value as Server
}

/** Configures the parent application Context. */
export function context(ctx: Context): AppOption {
  if (ctx === null || typeof ctx !== "object")
    throw new TypeError("app context must implement Context")
  return defineOption((config) => {
    config.parent = ctx
  })
}

/** Configures the application instance identifier. */
export function id(value: string): AppOption {
  const captured = identityText(value, "id")
  return defineOption((config) => {
    config.appId = captured
  })
}

/** Configures the application service name. */
export function name(value: string): AppOption {
  const captured = identityText(value, "name")
  return defineOption((config) => {
    config.appName = captured
  })
}

/** Configures the application version. */
export function version(value: string): AppOption {
  const captured = identityText(value, "version")
  return defineOption((config) => {
    config.appVersion = captured
  })
}

/** Configures immutable application metadata. */
export function metadata(value: Readonly<Record<string, string>>): AppOption {
  const captured = snapshotMetadata(value)
  return defineOption((config) => {
    config.appMetadata = captured
  })
}

/** Configures the ordered application endpoints. */
export function endpoint(
  ...values: readonly string[] /* go-like-typed-rest: preserves the Go-style functional-option ABI. */
): AppOption {
  const captured = snapshotEndpoints(values)
  return defineOption((config) => {
    config.appEndpoints = captured
  })
}

/** Installs the telemetry bundle. A later call replaces the previous bundle. */
export function telemetry(value: Telemetry): AppOption {
  if (!isTelemetry(value)) throw new TypeError("telemetry must be a Telemetry bundle")
  return defineOption((config) => {
    config.telemetry = value
  })
}

/** Sets the resource tier. A later call replaces the previous list. */
export function resources(
  ...values: readonly (Server &
    NotTelemetry)[] /* go-like-typed-rest: preserves the Go-style functional-option ABI. */
): AppOption {
  const captured = values.map((value) => assertParticipant(value, "resource"))
  return defineOption((config) => {
    config.resources.length = 0
    for (const subject of captured) config.resources.push(subject)
  })
}

/** Registers application servers. A later call replaces the previous list. */
export function server(
  ...servers: readonly (Server &
    NotTelemetry)[] /* go-like-typed-rest: preserves the Go-style functional-option ABI. */
): AppOption {
  const captured = servers.map((value) => assertParticipant(value, "server"))
  return defineOption((config) => {
    config.servers.length = 0
    for (const subject of captured) config.servers.push(subject)
  })
}

/** Configures the service registrar owned by the application lifecycle. */
export function registrar(value: Registrar): AppOption {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.register !== "function" ||
    typeof value.deregister !== "function"
  ) {
    throw new TypeError("registrar must implement Registrar")
  }
  return defineOption((config) => {
    config.registrar = value
  })
}

/** Registers a ready probe. The name defaults to `"app"`. */
export function readyProbe(registry: ProbeRegistry, name = "app"): AppOption {
  if (
    registry === null ||
    typeof registry !== "object" ||
    typeof registry.register !== "function"
  ) {
    throw new TypeError("ready probe registry must implement ProbeRegistry")
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("ready probe name must be a non-empty string")
  }
  return defineOption((config) => {
    config.readyProbe = { registry, name }
  })
}

/** Configures the registration and deregistration timeout. */
export function registrarTimeout(timeoutMs: number): AppOption {
  const captured = timerMs(timeoutMs, "registrar timeout")
  return defineOption((config) => {
    config.registrarTimeoutMs = captured
  })
}

/** Configures one shared startup-admission timeout. */
export function startTimeout(milliseconds: number): AppOption {
  const captured = timerMs(milliseconds, "start timeout")
  return defineOption((config) => {
    config.startTimeoutMs = captured
  })
}

/** Configures one shared graceful-stop Context timeout. */
export function stopTimeout(timeoutMs: number): AppOption {
  const captured = timerMs(timeoutMs, "stop timeout")
  return defineOption((config) => {
    config.stopTimeoutMs = captured
  })
}

/** Builds one hook option. */
function hookOption(
  target: "beforeStart" | "afterStart" | "beforeStop" | "afterStop",
  hook: AppHook
): AppOption {
  if (typeof hook !== "function") throw new TypeError(`app ${target} hook must be a function`)
  return defineOption((config) => {
    if (target === "beforeStart") config.beforeStartHooks.push(hook)
    else if (target === "afterStart") config.afterStartHooks.push(hook)
    else if (target === "beforeStop") config.beforeStopHooks.push(hook)
    else config.afterStopHooks.push(hook)
  })
}

/** Registers a callback that runs before the resource tier starts. */
export function beforeStart(hook: AppHook): AppOption {
  return hookOption("beforeStart", hook)
}

/** Registers a callback that runs after registration. */
export function afterStart(hook: AppHook): AppOption {
  return hookOption("afterStart", hook)
}

/** Registers a callback that runs before servers stop. */
export function beforeStop(hook: AppHook): AppOption {
  return hookOption("beforeStop", hook)
}

/** Registers a callback that runs after the resource tier stops. */
export function afterStop(hook: AppHook): AppOption {
  return hookOption("afterStop", hook)
}

/** Rejects one object that appears in both participant lists. */
export function assertDistinctParticipants(config: AppConfig): void {
  const resources = new Set<Server>(config.resources)
  for (const subject of config.servers) {
    if (resources.has(subject)) {
      throw new TypeError("participant cannot be both a resource and a server")
    }
  }
}
