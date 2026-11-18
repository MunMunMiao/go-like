import {
  afterFunc,
  canceled,
  withCancel,
  withTimeout,
  withValue,
  withoutCancel,
  type CancelFunc,
  type Context,
  type StopFunc
} from "../context/index"
import { aggregateFailure, addFailure } from "../internal/errors"
import type { ServiceInstance } from "../registry/index"
import {
  beginCoreUnit,
  installTelemetry,
  recordEvent,
  resourceFromAppInfo,
  unitSpanContext,
  whenTelemetryAdmitted,
  type AppStopReason
} from "../telemetry/internal/instrument"
import type { Telemetry } from "../telemetry/types"

import { appInfoKey } from "./identity"
import {
  applyOption,
  assertDistinctParticipants,
  newAppConfig,
  type App,
  type AppHook,
  type AppOption
} from "./options"
import { readyProbeBody, type PhaseCell } from "./readiness"
import {
  buildInstance,
  deregisterInstance,
  registerInstance,
  type RegistrationState
} from "./registration"
import {
  admitResources,
  boundaryError,
  invokeStart,
  invokeStop,
  launchTelemetry,
  stopResources,
  stopTelemetry,
  telemetryStopContext,
  watchResourceTerminal,
  waitForPhase,
  type ResourceRun
} from "./tiers"

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
      throw boundaryError(value, `app ${phase} hook ${index}`)
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
      addFailure(errors, boundaryError(value, `app ${phase} hook ${index}`))
    }
  }
}

/** Creates a one-shot application lifecycle. */
export function newApp(
  ...options: readonly AppOption[] /* go-like-typed-rest: preserves the Go-style functional-option ABI. */
): App {
  const config = newAppConfig()
  for (const option of options) applyOption(option, config)
  assertDistinctParticipants(config)

  let currentEndpoints = config.appEndpoints
  const identity = Object.freeze({
    id: () => config.appId,
    name: () => config.appName,
    version: () => config.appVersion,
    metadata: () => config.appMetadata,
    endpoint: () => currentEndpoints
  })
  const identified = withValue(config.parent, appInfoKey(), identity)
  const installed =
    config.telemetry === null
      ? identified
      : installTelemetry(identified, config.telemetry, resourceFromAppInfo(identity))
  const [appContext, cancelApp] = withCancel(installed)
  const [telemetryContext, cancelTelemetry] = withCancel(withoutCancel(appContext))
  const [resourceContext, cancelResources] = withCancel(withoutCancel(appContext))
  const [serverContext, cancelServers] = withCancel(withoutCancel(appContext))
  const cell: PhaseCell = { phase: "created" }
  const registration: RegistrationState = {
    config,
    appContext,
    preparedServers: new Set(),
    startupAbandoned: false,
    registeredInstance: null,
    getEndpoints: () => currentEndpoints,
    setEndpoints: (endpoints) => {
      currentEndpoints = endpoints
    }
  }
  const serverPromises: Promise<void>[] = []
  const serverSettlements: Array<PromiseSettledResult<void> | undefined> = []
  const resourceRuns: ResourceRun[] = []
  let runtimeCleanup: (() => void) | null = null
  let serversLaunched = false
  let startupPromise: Promise<void> | null = null
  let serverResults: readonly (PromiseSettledResult<void> | undefined)[] = []
  let runStarted = false
  let stopPromise: Promise<void> | null = null
  let stopRequested = false
  let stopReason: AppStopReason | null = null
  let stoppingAnnounced = false
  let participantFailure: Error | null = null
  let telemetryTerminal: Promise<void> | null = null
  let startLink: ReturnType<typeof unitSpanContext> = null
  let eventCtx: Context = appContext
  let unregisterProbe: (() => boolean) | null = null
  let resolveStopRequest: (() => void) | null = null
  const stopRequest = new Promise<void>((resolve) => {
    resolveStopRequest = resolve
  })

  /** Records the first stop reason and opens the stop gate once. */
  function noteStop(reason: AppStopReason): void {
    if (stopReason === null) stopReason = reason
    if (stopRequested) return
    stopRequested = true
    resolveStopRequest?.()
  }

  /** Flips a running app to stopping and records that event once. */
  function beginStopping(): void {
    if (stoppingAnnounced) return
    if (cell.phase !== "starting" && cell.phase !== "ready") return
    stoppingAnnounced = true
    cell.phase = "stopping"
    const reason = stopReason ?? "requested"
    recordEvent(eventCtx, { kind: "app.stopping", reason })
  }

  /** Publishes the first participant failure and wakes runtime supervision. */
  function publishFailure(
    error: Error,
    tier: "telemetry" | "resource" | "server",
    index: number,
    failFast: (error: Error) => void
  ): void {
    if (participantFailure !== null) return
    participantFailure = error
    if (stopReason === null) stopReason = cell.phase === "ready" ? "server_failed" : "start_failed"
    recordEvent(eventCtx, { kind: "server.failed", tier, index, error })
    failFast(error)
  }

  /** Requests application shutdown and returns the stable stop Promise. */
  function stopApp(reason: AppStopReason = "requested"): Promise<void> {
    noteStop(reason)
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
      addFailure(errors, boundaryError(value, "runtime cleanup"))
    }
  }

  /** Launches telemetry and waits until admission settles or stop wins the race. */
  async function admitAppTelemetry(
    telemetry: Telemetry,
    failFast: (error: Error) => void
  ): Promise<void> {
    const running = launchTelemetry(telemetry, telemetryContext)
    const admitted = whenTelemetryAdmitted(telemetry)
    void admitted.catch(() => {})
    void running.catch((error: unknown) => {
      if (stopRequested) return
      publishFailure(boundaryError(error, "telemetry terminal"), "telemetry", 0, failFast)
    })
    let winner: "admitted" | "stopped"
    try {
      winner = await Promise.race([
        admitted.then(() => "admitted" as const),
        stopRequest.then(() => "stopped" as const)
      ])
    } catch (error) {
      if (stopRequested) throw canceled
      const failure = boundaryError(error, "telemetry start")
      publishFailure(failure, "telemetry", 0, failFast)
      throw failure
    }
    if (winner === "stopped") throw canceled
    telemetryTerminal = running
  }

  /** Completes every startup phase while exposing the first launched participant failure. */
  async function executeStart(
    failFast: (error: Error) => void,
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
      if (!stopRequested && config.telemetry !== null) {
        await admitAppTelemetry(config.telemetry, failFast)
      }
      const scope = beginCoreUnit(startContext, { kind: "app.start" })
      eventCtx = scope.ctx
      try {
        if (!stopRequested) {
          await scope.run((ctx) =>
            runHooks(ctx, config.beforeStartHooks, "beforeStart", boundedStart)
          )
        }
        if (!stopRequested && config.resources.length > 0) {
          try {
            await admitResources(
              config.resources,
              resourceContext,
              startContext,
              () => stopRequested,
              resourceRuns
            )
          } catch (error) {
            const failure = boundaryError(error, "resource start")
            const failed = resourceRuns[resourceRuns.length - 1]
            if (!(stopRequested && failure === canceled) && failed !== undefined) {
              publishFailure(failure, "resource", failed.index, failFast)
            }
            throw failure
          }
          if (!stopRequested) {
            for (const run of resourceRuns) {
              if (!run.owned) continue
              watchResourceTerminal(
                run.server,
                run.index,
                () => stopRequested,
                (index, error) => {
                  publishFailure(error, "resource", index, failFast)
                }
              )
            }
          }
        }
        if (!stopRequested) {
          serversLaunched = true
          for (let index = 0; index < config.servers.length; index += 1) {
            const subject = config.servers[index]
            if (subject !== undefined) {
              const running = invokeStart(subject, serverContext, index, (error) => {
                publishFailure(error, "server", index, failFast)
              })
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
          instance = await buildInstance(
            registration,
            startContext,
            boundedStart,
            () => stopRequested
          )
        }
        if (!stopRequested && instance !== null) {
          const registered = instance
          const registerScope = beginCoreUnit(startContext, {
            kind: "registry.register",
            service: config.appName
          })
          try {
            await registerScope.run(() =>
              registerInstance(registration, startContext, boundedStart, registered)
            )
            registerScope.end()
          } catch (error) {
            const failure = boundaryError(error, "application register")
            registerScope.end({ error: failure })
            throw failure
          }
        }
        if (!stopRequested) {
          await scope.run((ctx) =>
            runHooks(ctx, config.afterStartHooks, "afterStart", boundedStart)
          )
        }
        if (stopRequested) scope.end({ error: canceled })
        else {
          cell.phase = "ready"
          startLink = unitSpanContext(scope)
          scope.end()
          recordEvent(scope.ctx, { kind: "app.ready", ready: true })
        }
      } catch (error) {
        const failure = boundaryError(error, "application start")
        if (!(stopRequested && failure === canceled) && stopReason === null) {
          stopReason = cell.phase === "ready" ? "server_failed" : "start_failed"
        }
        scope.end({ error: failure })
        throw failure
      }
    } finally {
      cancelStart?.()
    }
  }

  /** Executes the single graceful-stop operation. */
  async function executeStop(): Promise<void> {
    const errors: Error[] = []
    beginStopping()
    const cleanupContext = telemetryStopContext(appContext)
    let stopContext = cleanupContext
    let cancelStop: CancelFunc | null = null
    const boundedStop = config.stopTimeoutMs > 0
    if (boundedStop) {
      const timeout = withTimeout(stopContext, config.stopTimeoutMs)
      stopContext = timeout[0]
      cancelStop = timeout[1]
    }
    const stopScope = beginCoreUnit(stopContext, {
      kind: "app.stop",
      reason: stopReason ?? "requested",
      startLink
    })
    cancelApp()

    try {
      const starting = startupPromise
      if (starting !== null) {
        try {
          await waitForPhase(stopContext, Promise.allSettled([starting]), boundedStop)
        } catch (value) {
          registration.startupAbandoned = true
          addFailure(errors, boundaryError(value, "application startup join"))
        }
      }

      await stopScope.run((ctx) =>
        runCleanupHooks(ctx, config.beforeStopHooks, "beforeStop", errors, boundedStop)
      )
      if (registration.registeredInstance !== null) {
        const deregisterScope = beginCoreUnit(stopContext, {
          kind: "registry.deregister",
          service: config.appName
        })
        try {
          await deregisterScope.run(() => deregisterInstance(registration, stopContext))
          deregisterScope.end()
        } catch (value) {
          const error = boundaryError(value, "application deregister")
          deregisterScope.end({ error })
          addFailure(errors, error)
        }
      }
      cancelServers()

      if (serversLaunched || registration.preparedServers.size !== 0) {
        const operations: Promise<void>[] = []
        const stopFailures: Array<Error | null | undefined> = []
        for (let index = 0; index < config.servers.length; index += 1) {
          const subject = config.servers[index]
          if (
            subject !== undefined &&
            (serversLaunched || registration.preparedServers.has(subject))
          ) {
            const position = operations.length
            operations.push(
              invokeStop(subject, stopContext, index).then(
                () => {
                  stopFailures[position] = null
                },
                (value: unknown) => {
                  stopFailures[position] = boundaryError(value, "server stop")
                }
              )
            )
          }
        }
        let boundaryFailure: Error | null = null
        try {
          await waitForPhase(stopContext, Promise.all(operations), boundedStop)
        } catch (value) {
          boundaryFailure = boundaryError(value, "server stop wait")
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
        addFailure(errors, boundaryError(value, "server start terminal join"))
      }
      serverResults = serverSettlements.slice()

      cancelResources()
      if (resourceRuns.length > 0) {
        await stopResources(resourceRuns, stopContext, boundedStop, errors)
        if (boundedStop) {
          try {
            await waitForPhase(
              stopContext,
              Promise.allSettled(resourceRuns.map((run) => run.start)),
              true
            )
          } catch (value) {
            addFailure(errors, boundaryError(value, "resource start terminal join"))
          }
        }
      }

      await stopScope.run((ctx) =>
        runCleanupHooks(ctx, config.afterStopHooks, "afterStop", errors, boundedStop)
      )
    } finally {
      if (errors[0] !== undefined) stopScope.end({ error: errors[0] })
      else stopScope.end()
      if (config.telemetry !== null) {
        cancelTelemetry()
        let telemetryBudget = cleanupContext
        let cancelTelemetryBudget: CancelFunc | null = null
        if (boundedStop) {
          const opened = withTimeout(cleanupContext, config.stopTimeoutMs)
          telemetryBudget = opened[0]
          cancelTelemetryBudget = opened[1]
        }
        try {
          await stopTelemetry(
            config.telemetry,
            telemetryTerminal,
            telemetryBudget,
            boundedStop,
            errors
          )
        } finally {
          cancelTelemetryBudget?.()
        }
      }
      cancelStop?.()
    }

    const failure = aggregateFailure(errors, "application stop failed")
    if (failure !== null) throw failure
  }

  /** Runs the complete application lifecycle once. */
  async function executeRun(): Promise<void> {
    const errors: Error[] = []
    const firstParticipantFailure = Promise.withResolvers<void>()
    let serverFailure: Error | null = null
    /** Publishes only the first participant failure to startup and runtime supervision. */
    function failFast(error: Error): void {
      if (serverFailure !== null) return
      serverFailure = error
      firstParticipantFailure.reject(error)
    }
    void firstParticipantFailure.promise.catch(() => {})
    try {
      installRuntimeOption()
      startupPromise = executeStart(failFast, () => serverFailure)
      await Promise.race([startupPromise, firstParticipantFailure.promise, stopRequest])
      await Promise.race([stopRequest, firstParticipantFailure.promise])
    } catch (value) {
      const error = boundaryError(value, "application run")
      if (!(stopRequested && error === canceled)) addFailure(errors, error)
      void Promise.allSettled([stopApp()])
    }

    try {
      await stopApp()
    } catch (value) {
      addFailure(errors, boundaryError(value, "application stop"))
    }

    for (const result of serverResults) {
      if (result === undefined || result.status !== "rejected") continue
      const error = boundaryError(result.reason, "server start")
      if (error !== canceled) addFailure(errors, error)
    }

    removeRuntimeOption(errors)
    const failure = aggregateFailure(errors, "application lifecycle failed")
    if (failure !== null) throw failure
  }

  /** Starts the one-shot application lifecycle. */
  function runApp(): Promise<void> {
    if (runStarted) return Promise.reject(new Error("application run may only be called once"))
    runStarted = true
    if (cell.phase === "created") cell.phase = stopRequested ? "stopping" : "starting"
    return executeRun().finally(() => {
      cell.phase = "stopped"
      unregisterProbe?.()
      observeParent()
    })
  }

  const observeParent: StopFunc = afterFunc(appContext, () => {
    void Promise.allSettled([stopApp("context_canceled")])
  })

  if (config.readyProbe !== null) {
    const probe = config.readyProbe
    try {
      unregisterProbe = probe.registry.register("ready", probe.name, () => {
        readyProbeBody(cell)
      })
    } catch (error) {
      observeParent()
      throw error
    }
  }

  return Object.freeze({
    id: () => identity.id(),
    name: () => identity.name(),
    version: () => identity.version(),
    metadata: () => identity.metadata(),
    endpoint: () => identity.endpoint(),
    run: runApp,
    stop: stopApp
  })
}
