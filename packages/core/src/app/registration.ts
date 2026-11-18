import { waitForContext, withTimeout, withoutCancel, type Context } from "../context/index"
import type { Server } from "../lifecycle/index"
import { snapshotServiceInstance, type ServiceInstance } from "../registry/index"

import { snapshotEndpoints } from "./identity"
import type { AppConfig } from "./options"
import { boundaryError } from "./tiers"

/** Registration state owned by one App run. */
export interface RegistrationState {
  readonly config: AppConfig
  readonly appContext: Context
  preparedServers: Set<Server>
  startupAbandoned: boolean
  registeredInstance: ServiceInstance | null
  getEndpoints(): readonly string[]
  setEndpoints(endpoints: readonly string[]): void
}

/** Waits directly, or through the caller Context when the phase is bounded. */
function waitForPhase<T>(ctx: Context, operation: Promise<T>, bounded: boolean): Promise<T> {
  return bounded ? waitForContext(ctx, operation) : Promise.resolve(operation)
}

/** Invokes one Registrar operation and normalizes its eventual rejection. */
function invokeRegistrar(
  config: AppConfig,
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
      throw boundaryError(value, `application ${operation}`)
    })
}

/** Runs one Registrar operation under its caller wait timeout. */
async function runRegistrar(
  state: RegistrationState,
  operation: "register" | "deregister",
  instance: ServiceInstance,
  parent: Context
): Promise<void> {
  const timeout = withTimeout(parent, state.config.registrarTimeoutMs)
  try {
    await waitForContext(timeout[0], invokeRegistrar(state.config, operation, timeout[0], instance))
  } finally {
    timeout[1]()
  }
}

/** Starts one best-effort deregistration for a registration that completed too late. */
function compensateRegister(state: RegistrationState, instance: ServiceInstance): void {
  void Promise.allSettled([
    runRegistrar(state, "deregister", instance, withoutCancel(state.appContext))
  ])
}

/** Registers one instance while observing success after any caller wait boundary. */
export async function registerInstance(
  state: RegistrationState,
  startContext: Context,
  boundedStart: boolean,
  instance: ServiceInstance
): Promise<void> {
  const operationTimeout = withTimeout(startContext, state.config.registrarTimeoutMs)
  const callerTimeout = withTimeout(
    withoutCancel(state.appContext),
    state.config.registrarTimeoutMs
  )
  const pending = invokeRegistrar(state.config, "register", operationTimeout[0], instance)
  const registrarWait = waitForContext(callerTimeout[0], pending)
  try {
    await waitForPhase(startContext, registrarWait, boundedStart)
  } catch (value) {
    void pending.then(
      () => {
        compensateRegister(state, instance)
      },
      () => {}
    )
    throw value
  } finally {
    callerTimeout[1]()
    operationTimeout[1]()
  }
  if (state.startupAbandoned) compensateRegister(state, instance)
  else state.registeredInstance = instance
}

/** Builds the instance registered for this run, preparing server endpoints when needed. */
export async function buildInstance(
  state: RegistrationState,
  startContext: Context,
  boundedStart: boolean,
  stopRequested: () => boolean
): Promise<ServiceInstance> {
  let selectedProtocol: string | null = null
  for (const subject of state.config.servers) {
    const resolveEndpoint: unknown = Reflect.get(subject, "endpoint")
    if (typeof resolveEndpoint !== "function") continue
    const resolveProtocol: unknown = Reflect.get(subject, "protocol")
    if (typeof resolveProtocol !== "function") {
      throw new TypeError("app Endpointer must implement protocol")
    }
    const value: unknown = resolveProtocol.call(subject)
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("app Endpointer protocol must be a non-empty string")
    }
    if (selectedProtocol !== null && value !== selectedProtocol) {
      throw new TypeError(`app Endpointer protocols must match: ${selectedProtocol}, ${value}`)
    }
    selectedProtocol = value
  }
  if (state.getEndpoints().length === 0) {
    const endpoints: string[] = []
    for (const subject of state.config.servers) {
      if (stopRequested()) break
      const candidate: unknown = Reflect.get(subject, "endpoint")
      if (typeof candidate !== "function") continue
      state.preparedServers.add(subject)
      endpoints.push(
        await waitForPhase(
          startContext,
          Promise.resolve(candidate.call(subject, startContext)),
          boundedStart
        )
      )
    }
    state.setEndpoints(snapshotEndpoints(endpoints))
  }
  const instance = snapshotServiceInstance({
    id: state.config.appId,
    name: state.config.appName,
    version: state.config.appVersion,
    metadata: state.config.appMetadata,
    endpoints: state.getEndpoints()
  })
  state.setEndpoints(instance.endpoints)
  return instance
}

/** Deregisters the instance retained for this run. */
export async function deregisterInstance(
  state: RegistrationState,
  stopContext: Context
): Promise<void> {
  if (state.registeredInstance === null) return
  const instance = state.registeredInstance
  state.registeredInstance = null
  await runRegistrar(state, "deregister", instance, stopContext)
}
