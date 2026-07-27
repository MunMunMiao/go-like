import {
  afterFunc,
  background,
  canceled,
  withCancel,
  withTimeout,
  withValue,
  withoutCancel,
  type CancelFunc,
  type Context,
  type StopFunc
} from "@likego/context"
import type { Registrar, ServiceInstance } from "@likego/registry"
import { snapshotServiceInstance } from "@likego/registry/provider"
import { waitForContext } from "./lifecycle"

export interface Server {
  /** Starts the server; implementations may resolve after admission or after the runtime stops. */
  start(ctx: Context): Promise<void>

  /** Requests graceful server shutdown. */
  stop(ctx: Context): Promise<void>
}

/** Resolves the endpoint advertised by one Server. */
export interface Endpointer {
  /** Returns the actual endpoint after any asynchronous bind completes. */
  endpoint(ctx: Context): string | PromiseLike<string>
}

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

export interface App extends AppInfo {
  /** Runs the one-shot application lifecycle. */
  run(): Promise<void>

  /** Requests idempotent graceful application shutdown. */
  stop(): Promise<void>
}

/** Runs one application lifecycle hook. */
export type AppHook = (ctx: Context) => void | PromiseLike<void>

/** Applies one construction-time option to an application. */
export type AppOption = (config: AppConfig) => void

/** Installs one runtime integration and returns its cleanup callback. */
type RuntimeInstaller = (stop: () => Promise<void>) => () => void

interface AppConfig {
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
  readonly beforeStartHooks: AppHook[]
  readonly afterStartHooks: AppHook[]
  readonly beforeStopHooks: AppHook[]
  readonly afterStopHooks: AppHook[]
  runtimeInstaller: RuntimeInstaller | null
}

const appInfoContextKey = Symbol("likego.core.appInfo")
const maximumTimerDelayMs = 2_147_483_647

/** Validates an application identity string. */
function identityText(value: unknown, field: "id" | "name" | "version"): string {
  if (typeof value !== "string") throw new TypeError(`app ${field} must be a string`)
  return value
}

/** Copies metadata without retaining caller-owned mutable state. */
function snapshotMetadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("app metadata must be an object")
  }
  const entries: Array<[string, string]> = []
  for (const key of Object.keys(value)) {
    const entry = Reflect.get(value, key)
    if (typeof entry !== "string") {
      throw new TypeError(`app metadata value for "${key}" must be a string`)
    }
    entries.push([key, entry])
  }
  return Object.freeze(Object.fromEntries(entries))
}

/** Copies and validates an ordered endpoint list. */
function snapshotEndpoints(values: readonly string[]): readonly string[] {
  const snapshot: string[] = []
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("app endpoint must be a non-empty string")
    }
    snapshot.push(value)
  }
  return Object.freeze(snapshot)
}

/** Creates immutable application identity accessors. */
function newAppInfo(
  appId: string,
  appName: string,
  appVersion: string,
  appMetadata: Readonly<Record<string, string>>,
  appEndpoints: readonly string[]
): AppInfo {
  return Object.freeze({
    id: () => appId,
    name: () => appName,
    version: () => appVersion,
    metadata: () => appMetadata,
    endpoint: () => appEndpoints
  })
}

/** Reports whether an unknown Context value implements AppInfo. */
function isAppInfo(value: unknown): value is AppInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "function" &&
    typeof Reflect.get(value, "name") === "function" &&
    typeof Reflect.get(value, "version") === "function" &&
    typeof Reflect.get(value, "metadata") === "function" &&
    typeof Reflect.get(value, "endpoint") === "function"
  )
}

/** Returns a child Context carrying an immutable application identity snapshot. */
export function newContext(ctx: Context, info: AppInfo): Context {
  if (!isAppInfo(info)) throw new TypeError("app info must implement AppInfo")
  const snapshot = newAppInfo(
    identityText(info.id(), "id"),
    identityText(info.name(), "name"),
    identityText(info.version(), "version"),
    snapshotMetadata(info.metadata()),
    snapshotEndpoints(info.endpoint())
  )
  return withValue(ctx, appInfoContextKey, snapshot)
}

/** Returns the application identity carried by ctx, or null when absent. */
export function fromContext(ctx: Context): AppInfo | null {
  const value = ctx.value(appInfoContextKey)
  return isAppInfo(value) ? value : null
}

/** Configures the parent application Context. */
export function context(ctx: Context): AppOption {
  if (ctx === null || typeof ctx !== "object")
    throw new TypeError("app context must implement Context")
  return (config) => {
    config.parent = ctx
  }
}

/** Configures the application instance identifier. */
export function id(value: string): AppOption {
  const captured = identityText(value, "id")
  return (config) => {
    config.appId = captured
  }
}

/** Configures the application service name. */
export function name(value: string): AppOption {
  const captured = identityText(value, "name")
  return (config) => {
    config.appName = captured
  }
}

/** Configures the application version. */
export function version(value: string): AppOption {
  const captured = identityText(value, "version")
  return (config) => {
    config.appVersion = captured
  }
}

/** Configures immutable application metadata. */
export function metadata(value: Readonly<Record<string, string>>): AppOption {
  const captured = snapshotMetadata(value)
  return (config) => {
    config.appMetadata = captured
  }
}

/** Configures the ordered application endpoints. */
export function endpoint(
  ...values: readonly string[] /* likego-typed-rest: preserves the Go-style functional-option ABI. */
): AppOption {
  const captured = snapshotEndpoints(values)
  return (config) => {
    config.appEndpoints = captured
  }
}

/** Registers application servers. */
export function server(
  ...servers: readonly Server[] /* likego-typed-rest: preserves the Go-style functional-option ABI. */
): AppOption {
  for (const subject of servers) {
    if (
      subject === null ||
      typeof subject !== "object" ||
      typeof subject.start !== "function" ||
      typeof subject.stop !== "function"
    ) {
      throw new TypeError("server must implement Server")
    }
  }
  return (config) => {
    config.servers.length = 0
    for (const subject of servers) config.servers.push(subject)
  }
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
  return (config) => {
    config.registrar = value
  }
}

/** Configures the registration and deregistration timeout. */
export function registrarTimeout(timeoutMs: number): AppOption {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > maximumTimerDelayMs) {
    throw new RangeError(
      `registrar timeout must be an integer from 0 to ${maximumTimerDelayMs} milliseconds`
    )
  }
  return (config) => {
    config.registrarTimeoutMs = timeoutMs
  }
}

/** Configures one shared startup-admission timeout. */
export function startTimeout(milliseconds: number): AppOption {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > maximumTimerDelayMs) {
    throw new RangeError(
      `start timeout must be an integer from 0 to ${maximumTimerDelayMs} milliseconds`
    )
  }
  return (config) => {
    config.startTimeoutMs = milliseconds
  }
}

/** Configures one shared graceful-stop Context timeout. */
export function stopTimeout(timeoutMs: number): AppOption {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > maximumTimerDelayMs) {
    throw new RangeError(
      `stop timeout must be an integer from 0 to ${maximumTimerDelayMs} milliseconds`
    )
  }
  return (config) => {
    config.stopTimeoutMs = timeoutMs
  }
}

/** Builds one hook option. */
function hookOption(
  target: "beforeStart" | "afterStart" | "beforeStop" | "afterStop",
  hook: AppHook
): AppOption {
  if (typeof hook !== "function") throw new TypeError(`app ${target} hook must be a function`)
  return (config) => {
    if (target === "beforeStart") config.beforeStartHooks.push(hook)
    else if (target === "afterStart") config.afterStartHooks.push(hook)
    else if (target === "beforeStop") config.beforeStopHooks.push(hook)
    else config.afterStopHooks.push(hook)
  }
}

/** Registers a callback that runs before servers start. */
export function beforeStart(hook: AppHook): AppOption {
  return hookOption("beforeStart", hook)
}

/** Registers a callback that runs after all server starts have been invoked. */
export function afterStart(hook: AppHook): AppOption {
  return hookOption("afterStart", hook)
}

/** Registers a callback that runs before application cancellation. */
export function beforeStop(hook: AppHook): AppOption {
  return hookOption("beforeStop", hook)
}

/** Registers a callback that runs after all servers have stopped. */
export function afterStop(hook: AppHook): AppOption {
  return hookOption("afterStop", hook)
}

/** @internal Registers one runtime-owned lifecycle integration. */
export function runtimeInstaller(install: RuntimeInstaller): AppOption {
  if (typeof install !== "function") throw new TypeError("runtime installer must be a function")
  return (config) => {
    config.runtimeInstaller = install
  }
}

/** Recognizes built-in Error values across realms with a legacy-runtime fallback. */
function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return (typeof candidate === "function" && candidate(value) === true) || value instanceof Error
}

/** Converts a JavaScript rejection into an Error at a lifecycle boundary. */
function normalizeError(value: unknown, operation: string): Error {
  if (isError(value)) return value
  return new Error(`${operation} rejected with a non-Error value`, { cause: value })
}

/** Returns one error directly or aggregates multiple lifecycle failures. */
function lifecycleFailure(errors: readonly Error[], message: string): Error | null {
  const first = errors[0]
  if (first === undefined) return null
  if (errors.length === 1) return first
  return new AggregateError(errors, message)
}

/** Adds one Error identity at most once. */
function addFailure(errors: Error[], error: Error): void {
  if (!errors.includes(error)) errors.push(error)
}

/** Waits directly or through one lifecycle deadline Context. */
function waitForPhase<T>(ctx: Context, operation: PromiseLike<T>, bounded: boolean): Promise<T> {
  return bounded ? waitForContext(ctx, operation) : Promise.resolve(operation)
}

/** Runs hooks in declaration order. */
async function runHooks(
  ctx: Context,
  hooks: readonly AppHook[],
  phase: string,
  bounded: boolean
): Promise<void> {
  for (let index = 0; index < hooks.length; index += 1) {
    const hook = hooks[index]
    if (hook === undefined) continue
    try {
      await waitForPhase(ctx, Promise.resolve(hook(ctx)), bounded)
    } catch (value) {
      throw normalizeError(value, `app ${phase} hook ${index}`)
    }
  }
}

/** Runs all cleanup hooks while retaining every failure. */
async function runCleanupHooks(
  ctx: Context,
  hooks: readonly AppHook[],
  phase: string,
  errors: Error[],
  bounded: boolean
): Promise<void> {
  for (let index = 0; index < hooks.length; index += 1) {
    const hook = hooks[index]
    if (hook === undefined) continue
    try {
      await waitForPhase(ctx, Promise.resolve(hook(ctx)), bounded)
    } catch (value) {
      addFailure(errors, normalizeError(value, `app ${phase} hook ${index}`))
    }
  }
}

/** Invokes one server start and publishes its normalized failure at the first observation point. */
function invokeStart(
  subject: Server,
  ctx: Context,
  index: number,
  onFailure: (error: Error) => void
): Promise<void> {
  let started: PromiseLike<void>
  try {
    started = subject.start(ctx)
  } catch (value) {
    const error = normalizeError(value, `server[${index}] start`)
    onFailure(error)
    return Promise.reject(error)
  }
  return Promise.resolve(started).catch((value: unknown) => {
    const error = normalizeError(value, `server[${index}] start`)
    onFailure(error)
    throw error
  })
}

/** Invokes one server stop and normalizes its rejection. */
function invokeStop(subject: Server, ctx: Context, index: number): Promise<void> {
  let stopped: Promise<void>
  try {
    stopped = subject.stop(ctx)
  } catch (value) {
    return Promise.reject(normalizeError(value, `server[${index}] stop`))
  }
  return Promise.resolve(stopped).catch((value: unknown) => {
    throw normalizeError(value, `server[${index}] stop`)
  })
}

/** Creates a one-shot Kratos-style application lifecycle manager. */
export function newApp(
  ...options: readonly AppOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI. */
): App {
  const config: AppConfig = {
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
    beforeStartHooks: [],
    afterStartHooks: [],
    beforeStopHooks: [],
    afterStopHooks: [],
    runtimeInstaller: null
  }
  for (const option of options) option(config)

  let currentEndpoints = config.appEndpoints
  const identity: AppInfo = Object.freeze({
    id: () => config.appId,
    name: () => config.appName,
    version: () => config.appVersion,
    metadata: () => config.appMetadata,
    endpoint: () => currentEndpoints
  })
  const [appContext, cancelApp] = withCancel(withValue(config.parent, appInfoContextKey, identity))
  const [serverContext, cancelServers] = withCancel(withoutCancel(appContext))
  const serverPromises: Promise<void>[] = []
  const serverSettlements: Array<PromiseSettledResult<void> | undefined> = []
  const preparedServers = new Set<Server>()
  let runtimeCleanup: (() => void) | null = null
  let serversLaunched = false
  let registeredInstance: ServiceInstance | null = null
  let startupPromise: Promise<void> | null = null
  let startupAbandoned = false
  let serverResults: readonly (PromiseSettledResult<void> | undefined)[] = []
  let runStarted = false
  let stopPromise: Promise<void> | null = null
  let stopRequested = false
  let resolveStopRequest: (() => void) | null = null
  const stopRequest = new Promise<void>((resolve) => {
    resolveStopRequest = resolve
  })

  /** Announces the first application stop request. */
  function requestStop(): void {
    if (stopRequested) return
    stopRequested = true
    resolveStopRequest?.()
  }

  /** Invokes one Registrar operation and normalizes its eventual rejection. */
  function invokeRegistrar(
    operation: "register" | "deregister",
    ctx: Context,
    instance: ServiceInstance
  ): Promise<void> {
    const selected = config.registrar
    if (selected === null) return Promise.resolve()
    return Promise.resolve()
      .then(() =>
        operation === "register"
          ? selected.register(ctx, instance)
          : selected.deregister(ctx, instance)
      )
      .catch((value: unknown) => {
        throw normalizeError(value, `application ${operation}`)
      })
  }

  /** Runs one Registrar operation under its caller wait timeout. */
  async function runRegistrar(
    operation: "register" | "deregister",
    instance: ServiceInstance,
    parent: Context
  ): Promise<void> {
    const timeout = withTimeout(parent, config.registrarTimeoutMs)
    try {
      await waitForContext(timeout[0], invokeRegistrar(operation, timeout[0], instance))
    } finally {
      timeout[1]()
    }
  }

  /** Starts one best-effort deregistration for a registration that completed too late. */
  function compensateRegister(instance: ServiceInstance): void {
    void Promise.allSettled([runRegistrar("deregister", instance, withoutCancel(appContext))])
  }

  /** Registers one instance while observing success after any caller wait boundary. */
  async function registerInstance(
    startContext: Context,
    boundedStart: boolean,
    instance: ServiceInstance
  ): Promise<void> {
    const operationTimeout = withTimeout(startContext, config.registrarTimeoutMs)
    const callerTimeout = withTimeout(withoutCancel(appContext), config.registrarTimeoutMs)
    const pending = invokeRegistrar("register", operationTimeout[0], instance)
    const registrarWait = waitForContext(callerTimeout[0], pending)
    try {
      await waitForPhase(startContext, registrarWait, boundedStart)
    } catch (value) {
      void pending.then(
        () => {
          compensateRegister(instance)
        },
        () => {}
      )
      throw value
    } finally {
      callerTimeout[1]()
      operationTimeout[1]()
    }
    if (startupAbandoned) compensateRegister(instance)
    else registeredInstance = instance
  }

  /** Builds the exact Kratos-style instance registered for this run. */
  async function buildInstance(
    startContext: Context,
    boundedStart: boolean
  ): Promise<ServiceInstance> {
    if (currentEndpoints.length === 0) {
      const endpoints: string[] = []
      for (const subject of config.servers) {
        if (stopRequested) break
        const candidate: unknown = Reflect.get(subject, "endpoint")
        if (typeof candidate !== "function") continue
        preparedServers.add(subject)
        endpoints.push(
          await waitForPhase(
            startContext,
            Promise.resolve(candidate.call(subject, startContext)),
            boundedStart
          )
        )
      }
      currentEndpoints = snapshotEndpoints(endpoints)
    }
    const instance = snapshotServiceInstance({
      id: config.appId,
      name: config.appName,
      version: config.appVersion,
      metadata: config.appMetadata,
      endpoints: currentEndpoints
    })
    currentEndpoints = instance.endpoints
    return instance
  }

  /** Executes the single graceful-stop operation. */
  async function executeStop(): Promise<void> {
    const errors: Error[] = []
    const cleanupContext = withoutCancel(appContext)
    let stopContext = cleanupContext
    let cancelStop: CancelFunc | null = null
    const boundedStop = config.stopTimeoutMs > 0
    if (boundedStop) {
      const timeout = withTimeout(stopContext, config.stopTimeoutMs)
      stopContext = timeout[0]
      cancelStop = timeout[1]
    }
    cancelApp()

    try {
      const starting = startupPromise
      if (starting !== null) {
        try {
          await waitForPhase(stopContext, Promise.allSettled([starting]), boundedStop)
        } catch (value) {
          startupAbandoned = true
          addFailure(errors, normalizeError(value, "application startup join"))
        }
      }

      await runCleanupHooks(stopContext, config.beforeStopHooks, "beforeStop", errors, boundedStop)
      if (registeredInstance !== null) {
        const instance = registeredInstance
        registeredInstance = null
        try {
          await runRegistrar("deregister", instance, stopContext)
        } catch (value) {
          addFailure(errors, normalizeError(value, "application deregister"))
        }
      }
      cancelServers()

      if (serversLaunched || preparedServers.size !== 0) {
        const operations: Promise<void>[] = []
        const stopFailures: Array<Error | null | undefined> = []
        for (let index = 0; index < config.servers.length; index += 1) {
          const subject = config.servers[index]
          if (subject !== undefined && (serversLaunched || preparedServers.has(subject))) {
            const position = operations.length
            operations.push(
              invokeStop(subject, stopContext, index).then(
                () => {
                  stopFailures[position] = null
                },
                (value: unknown) => {
                  stopFailures[position] = normalizeError(value, "server stop")
                }
              )
            )
          }
        }
        let boundaryFailure: Error | null = null
        try {
          await waitForPhase(stopContext, Promise.all(operations), boundedStop)
        } catch (value) {
          boundaryFailure = normalizeError(value, "server stop wait")
        }
        for (const failure of stopFailures) {
          if (failure !== null && failure !== undefined) addFailure(errors, failure)
        }
        if (boundaryFailure !== null) addFailure(errors, boundaryFailure)
      }

      const settlingServers = Promise.allSettled(serverPromises)
      try {
        await waitForPhase(stopContext, settlingServers, boundedStop)
      } catch (value) {
        addFailure(errors, normalizeError(value, "server start terminal join"))
      }
      serverResults = serverSettlements.slice()

      await runCleanupHooks(stopContext, config.afterStopHooks, "afterStop", errors, boundedStop)
    } finally {
      cancelStop?.()
    }

    const failure = lifecycleFailure(errors, "application stop failed")
    if (failure !== null) throw failure
  }

  /** Requests application shutdown and returns the stable stop Promise. */
  function stopApp(): Promise<void> {
    requestStop()
    if (stopPromise === null) stopPromise = executeStop()
    return stopPromise
  }

  /** Installs the runtime option before asynchronous startup begins. */
  function installRuntimeOption(): void {
    const install = config.runtimeInstaller
    if (install === null) return
    const cleanup = install(stopApp)
    if (typeof cleanup !== "function") {
      throw new TypeError("runtime installer must return a cleanup function")
    }
    runtimeCleanup = cleanup
  }

  /** Removes the runtime integration. */
  function removeRuntimeOption(errors: Error[]): void {
    const cleanup = runtimeCleanup
    runtimeCleanup = null
    if (cleanup === null) return
    try {
      cleanup()
    } catch (value) {
      addFailure(errors, normalizeError(value, "runtime cleanup"))
    }
  }

  /** Completes every startup phase while exposing the first launched Server failure. */
  async function executeStart(
    onServerFailure: (error: Error) => void,
    serverFailure: () => Error | null
  ): Promise<void> {
    let startContext = appContext
    let cancelStart: CancelFunc | null = null
    const boundedStart = config.startTimeoutMs > 0
    if (boundedStart) {
      const timeout = withTimeout(startContext, config.startTimeoutMs)
      startContext = timeout[0]
      cancelStart = timeout[1]
    }
    try {
      if (!stopRequested) {
        await runHooks(startContext, config.beforeStartHooks, "beforeStart", boundedStart)
      }
      if (!stopRequested) {
        serversLaunched = true
        for (let index = 0; index < config.servers.length; index += 1) {
          const subject = config.servers[index]
          if (subject !== undefined) {
            const running = invokeStart(subject, serverContext, index, onServerFailure)
            const position = serverPromises.length
            serverPromises.push(running)
            void running.then(
              () => {
                serverSettlements[position] = { status: "fulfilled", value: undefined }
              },
              (reason: unknown) => {
                serverSettlements[position] = { status: "rejected", reason }
              }
            )
          }
        }
      }
      await Promise.resolve()
      const immediateServerFailure = serverFailure()
      if (immediateServerFailure !== null) throw immediateServerFailure
      let instance: ServiceInstance | null = null
      if (!stopRequested && config.registrar !== null) {
        instance = await buildInstance(startContext, boundedStart)
      }
      if (!stopRequested && instance !== null) {
        await registerInstance(startContext, boundedStart, instance)
      }
      if (!stopRequested) {
        await runHooks(startContext, config.afterStartHooks, "afterStart", boundedStart)
      }
    } finally {
      cancelStart?.()
    }
  }

  /** Runs the complete application lifecycle once. */
  async function executeRun(): Promise<void> {
    const errors: Error[] = []
    const firstServerFailure = Promise.withResolvers<void>()
    let serverFailure: Error | null = null
    /** Publishes only the first normalized Server failure to startup and runtime supervision. */
    function failServer(error: Error): void {
      if (serverFailure !== null) return
      serverFailure = error
      firstServerFailure.reject(error)
    }
    void firstServerFailure.promise.catch(() => {})
    try {
      installRuntimeOption()
      startupPromise = executeStart(failServer, () => serverFailure)
      await Promise.race([startupPromise, firstServerFailure.promise, stopRequest])
      await Promise.race([stopRequest, firstServerFailure.promise])
    } catch (value) {
      const error = normalizeError(value, "application run")
      if (!(stopRequested && error === canceled)) addFailure(errors, error)
      void Promise.allSettled([stopApp()])
    }

    try {
      await stopApp()
    } catch (value) {
      addFailure(errors, normalizeError(value, "application stop"))
    }

    for (const result of serverResults) {
      if (result === undefined || result.status !== "rejected") continue
      const error = normalizeError(result.reason, "server start")
      if (error !== canceled) addFailure(errors, error)
    }

    removeRuntimeOption(errors)
    const failure = lifecycleFailure(errors, "application lifecycle failed")
    if (failure !== null) throw failure
  }

  /** Starts the one-shot application lifecycle. */
  function runApp(): Promise<void> {
    if (runStarted) return Promise.reject(new Error("application run may only be called once"))
    runStarted = true
    return executeRun().finally(() => {
      observeParent()
    })
  }

  const observeParent: StopFunc = afterFunc(appContext, () => {
    void Promise.allSettled([stopApp()])
  })

  /** Returns the immutable application identifier. */
  function readId(): string {
    return identity.id()
  }

  /** Returns the immutable application name. */
  function readName(): string {
    return identity.name()
  }

  /** Returns the immutable application version. */
  function readVersion(): string {
    return identity.version()
  }

  /** Returns the immutable application metadata. */
  function readMetadata(): Readonly<Record<string, string>> {
    return identity.metadata()
  }

  /** Returns the immutable application endpoints. */
  function readEndpoint(): readonly string[] {
    return identity.endpoint()
  }

  return Object.freeze({
    id: readId,
    name: readName,
    version: readVersion,
    metadata: readMetadata,
    endpoint: readEndpoint,
    run: runApp,
    stop: stopApp
  })
}
