import * as ContextPackage from "../src/context/index"
import {
  afterFunc,
  background,
  cause,
  withCancel,
  withCancelCause,
  withDeadline,
  withDeadlineCause,
  withoutCancel,
  withTimeout,
  withTimeoutCause,
  withValue,
  type CancelCauseFunc,
  type CancelFunc,
  type Context,
  type ContextError,
  type StopFunc,
  type TimeoutContextError
} from "../src/context/index"
import {
  append,
  appendToClientContext,
  fromClientContext,
  fromServerContext,
  clone,
  get,
  keys,
  merge,
  mergeToClientContext,
  newClientContext,
  newMetadata,
  newServerContext,
  propagateToClientContext,
  remove,
  set,
  values,
  type Metadata,
  type MetadataInput,
  type MetadataValue,
  type PropagationOptions
} from "../src/metadata/index"
import * as Health from "../src/health/index"
import {
  newProbeRegistry,
  type Probe,
  type ProbeKind,
  type ProbeOptions,
  type ProbeRegistry,
  type ProbeReport,
  type ProbeResult
} from "../src/health/index"
import * as Resilience from "../src/resilience/index"
import {
  circuitOpen,
  exponentialBackoff,
  newCircuitBreaker,
  newTokenBucketLimiter,
  retry,
  type Backoff,
  type BackoffOptions,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitFailurePredicate,
  type CircuitOperation,
  type CircuitSnapshot,
  type CircuitState,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimiterSnapshot,
  type TokenBucketLimiter,
  type RetryAuthorization,
  type RetryOperation,
  type RetryOptions,
  type RetryPredicate,
  type TokenBucketOptions
} from "../src/resilience/index"
import * as RegistryPackage from "../src/registry/index"
import {
  filterLabel,
  filterVersion,
  newEWMASelector,
  newP2CSelector,
  newRandomSelector,
  newRoundRobinSelector,
  newWeightedRoundRobinSelector,
  type Discovery,
  type EWMASelectorOptions,
  type Filter,
  type P2CSelectorOptions,
  type Registrar,
  type Registry,
  type SelectionDone,
  type SelectionOutcome,
  type Selector,
  type ServiceEndpoint,
  type ServiceInstance,
  type Watcher,
  snapshotServiceInstance,
  type RegistrationErrorHandler
} from "../src/registry/index"
import {
  type ProviderOptionInput,
  type ProviderOptions,
  notifyRegistrationError,
  providerOptions
} from "../src/registry/provider"
import * as Core from "../src/index"
import {
  afterStart,
  afterStop,
  fromContext,
  beforeStart,
  beforeStop,
  context,
  endpoint,
  id,
  metadata,
  name,
  newApp,
  readyProbe,
  registrar,
  resources,
  registrarTimeout,
  server,
  startTimeout,
  stopTimeout,
  telemetry,
  version,
  newContext,
  type App,
  type AppHook,
  type AppInfo,
  type AppOption
} from "../src/index"
import type { Endpointer, Server } from "../src/lifecycle/index"
import { waitForContext } from "../src/context/wait"
import { signal, type ProcessSignal } from "../src/node/index"
import { newTelemetry } from "../src/telemetry/index"
import * as TransportPackage from "../src/transport/index"
import { defineService } from "../src/transport/index"
import { newMemoryTransport } from "../src/transport/memory/index"
import { newHTTPTransport } from "../src/transport/http/index"
import { newNodeHTTPTransport } from "../src/transport/http/node"
import { newServer as newRPCServer } from "../src/server/index"
import { newClient } from "../src/client/index"
import * as WebPackage from "../src/web/index"
import { newNodeServer } from "../src/web/node"
import { newBunServer } from "../src/web/bun"
import { newConfig, type StandardSchemaV1 } from "../src/config/index"
import { newNodeFileCapability } from "../src/config/node"
import { expiresIn as cacheExpiresIn } from "../src/cache/index"
import { newMemoryCache } from "../src/cache/memory/index"
import { cursor } from "../src/store/index"
import { newStoreConflictError } from "../src/store/provider"
import { newMemoryStore } from "../src/store/memory/index"
import { eventBroker, newBrokerServer, type BrokerHandler } from "../src/broker/index"
import {
  brokerTopic,
  deliver,
  newBrokerEvent,
  publish,
  snapshotBrokerMessage,
  subscriberTerminal
} from "../src/broker/provider"
import { newMemoryBroker } from "../src/broker/memory/index"
import {
  newIntervalSchedule,
  newPermanentJobError,
  newScheduleServer,
  type JobPermanentError,
  type ScheduleServer
} from "../src/job/index"
import {
  dispatchJob,
  enqueue,
  enqueueOptions,
  jobHandlers,
  jobWorkerOptions,
  newJobDrainTimeoutError,
  newJobStateError,
  runJob,
  type JobEnqueueInfo,
  type JobRunInfo,
  type ResolvedEnqueueOptions,
  type ResolvedJobWorkerOptions
} from "../src/job/provider"
import {
  brokerConformance,
  brokerTelemetryConformance,
  cacheConformance,
  jobQueueConformance,
  jobTelemetryConformance,
  registryConformance,
  scheduleConformance,
  storeConformance,
  type BrokerConformanceSubject,
  type JobConformancePayload,
  type JobQueueConformanceSubject,
  type JobTelemetrySubject
} from "../src/testing/index"

{
  // context
  const parent: Context = background()
  const cancel: CancelFunc = withCancel(parent)[1]
  const cancelCause: CancelCauseFunc = withCancelCause(parent)[1]
  const deadlineCancel: CancelFunc = withDeadline(parent, new Date())[1]
  const deadlineCauseCancel: CancelFunc = withDeadlineCause(parent, new Date(), null)[1]
  const timeoutCancel: CancelFunc = withTimeout(parent, 1)[1]
  const timeoutCauseCancel: CancelFunc = withTimeoutCause(parent, 1, null)[1]
  const valued: Context = withValue(parent, "key", "value")
  const detached: Context = withoutCancel(valued)
  const observedCause: Error | null = cause(detached)
  const stop: StopFunc = afterFunc(parent, () => {})
  const contextError: ContextError | null = parent.err()
  const timeoutError: TimeoutContextError | null = null

  void [cancel, cancelCause, deadlineCancel, deadlineCauseCancel, timeoutCancel]
  void [timeoutCauseCancel, observedCause, stop, contextError, timeoutError]

  // @ts-expect-error Context is type-only and has no runtime constructor.
  void ContextPackage.Context
  // @ts-expect-error ContextError is type-only and has no runtime constructor.
  void ContextPackage.ContextError
  // @ts-expect-error TimeoutContextError is type-only and has no runtime constructor.
  void ContextPackage.TimeoutContextError
  // @ts-expect-error CancelFunc is type-only.
  void ContextPackage.CancelFunc
  // @ts-expect-error CancelCauseFunc is type-only.
  void ContextPackage.CancelCauseFunc
  // @ts-expect-error StopFunc is type-only.
  void ContextPackage.StopFunc
}

{
  // metadata
  const ctx = undefined as unknown as Context
  const input: MetadataInput = { trace: ["one", "two"] }
  const value: MetadataValue = "three"
  const metadata: Metadata = newMetadata(input)
  const copied: Metadata = clone(metadata)
  const appended: Metadata = append(metadata, "trace", value)
  const replaced: Metadata = set(metadata, "trace", "replacement")
  const removed: Metadata = remove(metadata, "trace")
  const merged: Metadata = merge(metadata, copied)
  const first: string | null = get(metadata, "trace")
  const all: readonly string[] = values(metadata, "trace")
  const names: readonly string[] = keys(metadata)
  const clientContext: Context = newClientContext(ctx, metadata)
  const appendedClientContext: Context = appendToClientContext(ctx, "trace", "one", "tenant", "a")
  const mergedClientContext: Context = mergeToClientContext(ctx, metadata)
  const client: Metadata | null = fromClientContext(ctx)
  const serverContext: Context = newServerContext(ctx, metadata)
  const server: Metadata | null = fromServerContext(ctx)
  const propagationOptions: PropagationOptions = {
    exact: ["trace-id"],
    prefix: ["x-baggage-"]
  }
  const propagatedContext: Context = propagateToClientContext(ctx, propagationOptions)

  void [
    appended,
    appendedClientContext,
    all,
    client,
    clientContext,
    copied,
    first,
    merged,
    mergedClientContext,
    metadata,
    names,
    removed,
    replaced,
    server,
    serverContext,
    propagatedContext
  ]

  // @ts-expect-error Metadata values must be strings or string arrays.
  newMetadata({ invalid: 1 })
  // @ts-expect-error Context must be the first argument.
  newClientContext(metadata, ctx)
  // @ts-expect-error Context key/value pairs must be strings.
  appendToClientContext(ctx, "trace", 1)
  // @ts-expect-error Exact propagation rules must be strings.
  propagateToClientContext(ctx, { exact: [1] })
  // @ts-expect-error Prefix propagation rules must be strings.
  propagateToClientContext(ctx, { prefix: [false] })
}

{
  // health
  const kind: ProbeKind = "ready"
  const probe: Probe = (_ctx: Context) => {}
  const options: ProbeOptions = { timeoutMs: 1 }
  const result: ProbeResult = Object.freeze({ name: "x", ok: true, error: null })
  const report: ProbeReport = Object.freeze({ kind, ok: true, checks: [result] })
  const registry: ProbeRegistry = newProbeRegistry()
  const unregister: () => boolean = registry.register("ready", "x", probe, options)
  const checked: Promise<ProbeReport> = registry.check(background(), "ready")

  void [report, unregister, checked]

  // @ts-expect-error Public interfaces are type-only.
  void Health.ProbeRegistry
  // @ts-expect-error Capitalized callable aliases are not exported.
  Health.NewProbeRegistry()
  // @ts-expect-error HTTP handlers belong to @go-like/core/web.
  Health.createHealthFetch(registry)
  // @ts-expect-error Probe kinds are exact.
  registry.register("startup", "x", probe)
}

{
  // resilience
  const ctx: Context = background()
  const authorization: RetryAuthorization = "idempotent"
  const operation: RetryOperation<number> = (_attemptContext, attempt) => attempt
  const predicate: RetryPredicate = async (_attemptContext, failure, attempt) => {
    return failure instanceof Error && attempt < 3
  }
  const backoffOptions: BackoffOptions = { initialDelayMs: 1, multiplier: 2, maxDelayMs: 10 }
  const backoff: Backoff = exponentialBackoff(backoffOptions)
  const retryOptions: RetryOptions = {
    authorization,
    maxAttempts: 3,
    shouldRetry: predicate,
    backoff
  }
  const retried: Promise<number> = retry(ctx, operation, retryOptions)
  const inferredSync: Promise<{ readonly value: number }> = retry(
    ctx,
    () => Object.freeze({ value: 1 }),
    { authorization: "caller-approved", maxAttempts: 1, shouldRetry: () => false }
  )
  const inferredAsync: Promise<string> = retry(ctx, async () => "value", {
    authorization: "idempotent",
    maxAttempts: 1,
    shouldRetry: async () => false
  })

  const circuitOperation: CircuitOperation<string> = () => Promise.resolve("ok")
  const circuitPredicate: CircuitFailurePredicate = async (_operationContext, failure) => {
    return failure instanceof Error
  }
  const circuitOptions: CircuitBreakerOptions = {
    failureThreshold: 2,
    resetTimeoutMs: 50,
    isFailure: circuitPredicate
  }
  const breaker: CircuitBreaker = newCircuitBreaker(circuitOptions)
  const protectedValue: Promise<string> = breaker.execute(ctx, circuitOperation)
  const circuitState: CircuitState = "closed"
  const circuitSnapshot: CircuitSnapshot = breaker.snapshot()

  const limiterOptions: TokenBucketOptions = {
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 100,
    initialTokens: 1
  }
  const limiter: TokenBucketLimiter = newTokenBucketLimiter(limiterOptions)
  const asLimiter: RateLimiter = limiter
  void asLimiter
  const decision: RateLimitDecision | Promise<RateLimitDecision> = limiter.allow(ctx)
  const limiterSnapshot: RateLimiterSnapshot = limiter.snapshot()
  const openError: Error = circuitOpen

  void [
    retried,
    inferredSync,
    inferredAsync,
    protectedValue,
    circuitState,
    circuitSnapshot,
    decision,
    limiterSnapshot,
    openError
  ]

  // @ts-expect-error RetryOperation is type-only.
  void Resilience.RetryOperation
  // @ts-expect-error CircuitBreaker is type-only.
  void Resilience.CircuitBreaker
  // @ts-expect-error RateLimiter is type-only.
  void Resilience.RateLimiter
  // @ts-expect-error TokenBucketLimiter is type-only.
  void Resilience.TokenBucketLimiter
  // @ts-expect-error PascalCase callable aliases are not exported.
  Resilience.Retry(ctx, operation, retryOptions)
  // @ts-expect-error PascalCase callable aliases are not exported.
  Resilience.NewCircuitBreaker(circuitOptions)
  // @ts-expect-error Retry authorization is mandatory.
  retry(ctx, operation, { maxAttempts: 2, shouldRetry: predicate })
  // @ts-expect-error Retry operations receive the Context before the attempt number.
  const reversedOperation: RetryOperation<number> = (attempt: number, _operationContext: Context) =>
    attempt
  void reversedOperation
  // @ts-expect-error Token capacity is numeric.
  newTokenBucketLimiter({ capacity: "2", refillTokens: 1, refillIntervalMs: 100 })
}

{
  // registry
  const instance: ServiceInstance = snapshotServiceInstance({
    id: "catalog-1",
    name: "catalog",
    version: "v1",
    metadata: { zone: "a" },
    endpoints: ["http://127.0.0.1:8000"]
  })
  const registrationErrorHandler: RegistrationErrorHandler = (_error, _service) => Promise.resolve()
  const syncRegistrationErrorHandler: RegistrationErrorHandler = () => {}
  const thenOnlyVoid = undefined as unknown as Pick<Promise<void>, "then">
  // @ts-expect-error A then-only value is not a native Promise.
  const thenOnlyRegistrationErrorHandler: RegistrationErrorHandler = () => thenOnlyVoid
  const providerOptionInput: ProviderOptionInput = { onRegistrationError: registrationErrorHandler }
  const providerOptions = undefined as unknown as ProviderOptions
  const normalizedRegistrationErrorHandler: RegistrationErrorHandler | null =
    providerOptions.onRegistrationError

  const watcher: Watcher = {
    next(_ctx: Context): Promise<readonly ServiceInstance[]> {
      return Promise.resolve([instance])
    },
    stop(_ctx: Context): Promise<void> {
      return Promise.resolve()
    }
  }

  const registrar: Registrar = {
    register(_ctx, _service): Promise<void> {
      return Promise.resolve()
    },
    deregister(_ctx, _service): Promise<void> {
      return Promise.resolve()
    }
  }

  const discovery: Discovery = {
    getService(_ctx, _name): Promise<readonly ServiceInstance[]> {
      return Promise.resolve([instance])
    },
    watch(_ctx, _name): Promise<Watcher> {
      return Promise.resolve(watcher)
    }
  }

  const registry = undefined as unknown as Registry
  const registered: Promise<void> = registry.register(background(), instance)
  const deregistered: Promise<void> = registry.deregister(background(), instance)
  const discovered: Promise<readonly ServiceInstance[]> = discovery.getService(
    background(),
    "catalog"
  )
  const watched: Promise<Watcher> = discovery.watch(background(), "catalog")

  const random: Selector = newRandomSelector(() => 0)
  const roundRobin: Selector = newRoundRobinSelector()
  const weighted: Selector = newWeightedRoundRobinSelector(() => 1)
  const p2cOptions: P2CSelectorOptions = { random: () => 0, now: () => 0 }
  const p2c: Selector = newP2CSelector(p2cOptions)
  const ewmaOptions: EWMASelectorOptions = { random: () => 0, now: () => 0 }
  const ewma: Selector = newEWMASelector(ewmaOptions)
  const selection: readonly [ServiceEndpoint, SelectionDone] = random.select(background(), [
    instance
  ])
  const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
  const replyMetadata = undefined as unknown as Metadata
  const compatibleOutcome: SelectionOutcome = { error: null }
  const detailedOutcome: SelectionOutcome = {
    error: null,
    replyMetadata,
    bytesSent: true,
    bytesReceived: true
  }

  void [
    registrar,
    registered,
    deregistered,
    discovered,
    watched,
    roundRobin,
    weighted,
    p2c,
    ewma,
    selection,
    filters,
    compatibleOutcome,
    detailedOutcome,
    providerOptionInput,
    normalizedRegistrationErrorHandler,
    syncRegistrationErrorHandler,
    thenOnlyRegistrationErrorHandler
  ]

  // @ts-expect-error Context is always the independent first argument.
  registry.register(instance)
  // @ts-expect-error Watch requires the service name directly.
  registry.watch(background())
  // @ts-expect-error TypeScript runtime exports use lower camel case.
  RegistryPackage.NewRandomSelector()
}

{
  // registry-published
  const service: ServiceInstance = snapshotServiceInstance({
    id: "published-1",
    name: "published",
    version: "v1",
    metadata: {},
    endpoints: ["memory://published"]
  })
  const registry = undefined as unknown as Registry
  const registrationErrorHandler: RegistrationErrorHandler = (_error, _service) => {}
  const providerInput: ProviderOptionInput = { onRegistrationError: registrationErrorHandler }
  const capturedProviderOptions = providerOptions(providerInput)
  notifyRegistrationError(
    capturedProviderOptions.onRegistrationError,
    new Error("terminal"),
    service
  )
  const ewmaOptions: EWMASelectorOptions = {
    random: () => 0,
    now: () => 0,
    isFailure: (error) => error.name === "ApplicationFailure"
  }
  const replyMetadata = undefined as unknown as Metadata
  const compatibleOutcome: SelectionOutcome = { error: null }
  const detailedOutcome: SelectionOutcome = {
    error: null,
    replyMetadata,
    bytesSent: true,
    bytesReceived: true
  }

  void newEWMASelector(ewmaOptions)
  void filterVersion("v1")([service])
  void filterLabel("zone", "a")([service])
  void registry.register(background(), service)
  void registry.deregister(background(), service)
  void compatibleOutcome
  void detailedOutcome
  void capturedProviderOptions
}

{
  // core
  type ThenOnly<T> = Pick<Promise<T>, "then">

  const thenOnlyNumber = undefined as unknown as ThenOnly<number>

  const structural: Server = {
    async start() {},
    async stop() {}
  }
  const endpointer: Endpointer = {
    protocol: () => "http",
    endpoint: () => "https://typed.example"
  }
  const endpointerProtocol: string = endpointer.protocol()
  const registry = undefined as unknown as Registrar
  const hook: AppHook = async () => {}
  const options: AppOption[] = [
    context(background()),
    id("typed-id"),
    name("typed"),
    version("v1"),
    metadata({ role: "test" }),
    endpoint("https://typed.example"),
    registrar(registry),
    registrarTimeout(10_000),
    startTimeout(30_000),
    stopTimeout(1_000),
    beforeStart(hook),
    afterStart(hook),
    beforeStop(hook),
    afterStop(hook),
    server(structural),
    telemetry(newTelemetry()),
    resources(structural),
    readyProbe(newProbeRegistry()),
    signal(),
    signal("SIGTERM" satisfies ProcessSignal)
  ]
  // @ts-expect-error a Telemetry bundle is installed with telemetry(), not server()
  server(newTelemetry())
  // @ts-expect-error a Telemetry bundle is installed with telemetry(), not resources()
  resources(newTelemetry())
  const app: App = newApp(...options)
  const running: Promise<void> = app.run()
  const stopping: Promise<void> = app.stop()
  const waited: Promise<number> = waitForContext(background(), Promise.resolve(1))
  // @ts-expect-error waitForContext accepts only a native Promise.
  const rejectedThenOnlyWait: Promise<number> = waitForContext(background(), thenOnlyNumber)
  const info: AppInfo = app
  const infoContext: Context = newContext(background(), info)
  const readInfo: AppInfo | null = fromContext(infoContext)

  void [
    endpointer,
    endpointerProtocol,
    running,
    stopping,
    waited,
    rejectedThenOnlyWait,
    info,
    infoContext,
    readInfo
  ]

  // @ts-expect-error Endpointer requires a synchronous protocol discriminator.
  const missingProtocol: Endpointer = { endpoint: () => "https://typed.example" }
  void missingProtocol

  // @ts-expect-error Public interfaces are type-only.
  void Core.App
  // @ts-expect-error Removed handle type is not exported.
  type RemovedHandle = import("../src/index").AppHandle
  // @ts-expect-error App is run directly rather than started for a handle.
  app.start(background())
  // @ts-expect-error Server start does not return a handle.
  const invalidStart: Promise<{ done(): Promise<void> }> = structural.start(background())
  // @ts-expect-error Runtime values remain lowerCamelCase.
  Core.NewApp()
  // @ts-expect-error waitForContext remains on its established subpath.
  Core.waitForContext(background(), Promise.resolve())

  void (null as RemovedHandle | null)
  void invalidStart
}

{
  void [
    RegistryPackage.newDiscoveryResolver,
    defineService,
    newMemoryTransport,
    newHTTPTransport,
    newNodeHTTPTransport,
    newRPCServer,
    newClient,
    WebPackage.contextHandler,
    WebPackage.createHealthHandler,
    newNodeServer,
    newBunServer,
    newConfig,
    newNodeFileCapability,
    cacheExpiresIn,
    newMemoryCache,
    cursor,
    newStoreConflictError,
    newMemoryStore,
    eventBroker,
    newBrokerServer,
    subscriberTerminal,
    newMemoryBroker,
    cacheConformance,
    storeConformance,
    brokerTopic,
    deliver,
    newBrokerEvent,
    publish,
    snapshotBrokerMessage,
    newIntervalSchedule,
    newPermanentJobError,
    newScheduleServer,
    dispatchJob,
    enqueue,
    enqueueOptions,
    jobHandlers,
    jobWorkerOptions,
    newJobDrainTimeoutError,
    newJobStateError,
    runJob,
    brokerConformance,
    brokerTelemetryConformance,
    jobQueueConformance,
    jobTelemetryConformance,
    registryConformance,
    scheduleConformance
  ]
  const schema: StandardSchemaV1 = {
    "~standard": { version: 1, vendor: "pin", validate: () => ({ value: null }) }
  }
  void schema
  // @ts-expect-error Generic Handler, Middleware, and chain are not public transport exports.
  void TransportPackage.chain
  // @ts-expect-error Wire codecs are internal and have no public subpath.
  void TransportPackage.encodeJsonBody
}

{
  const handler: BrokerHandler<null> = () => {}
  const permanent: JobPermanentError = newPermanentJobError(new Error("pin"))
  const resolved: ResolvedEnqueueOptions = enqueueOptions({
    attempts: 2,
    backoff: { type: "fixed", delayMs: 0 }
  })
  const workerOptions: ResolvedJobWorkerOptions = jobWorkerOptions()
  const server: ScheduleServer = newScheduleServer(newIntervalSchedule(60_000), "pin", () => {})
  const payload: JobConformancePayload = { n: 1 }
  const runInfo: JobRunInfo = {
    system: "memory",
    name: "pin",
    trigger: "schedule",
    id: null,
    attempt: 1,
    metadata: null
  }
  const enqueueInfo: JobEnqueueInfo = { system: "memory", name: "pin", queue: "pin" }
  const queueSubject: JobQueueConformanceSubject = {
    async newQueue() {
      throw new Error("pin")
    },
    async close() {}
  }
  const telemetrySubject: JobTelemetrySubject = {
    queue: queueSubject,
    schedule: newIntervalSchedule(60_000)
  }
  const brokerSubject: BrokerConformanceSubject<undefined, void, undefined, null> = {
    async newBroker() {
      throw new Error("pin")
    },
    topic: "pin",
    async close() {}
  }
  void [
    handler,
    permanent.code,
    resolved.attempts,
    workerOptions.concurrency,
    server.trigger,
    payload,
    runInfo,
    enqueueInfo,
    telemetrySubject,
    brokerSubject
  ]
}
