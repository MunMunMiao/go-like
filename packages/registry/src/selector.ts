import { cause, type Context } from "@go-like/context"

import { newNoAvailableEndpointError } from "./errors"
import { compareCodePoints, snapshotServiceInstances } from "./snapshot"
import type {
  EWMASelectorOptions,
  Filter,
  P2CSelectorOptions,
  SelectionDone,
  SelectionOutcome,
  Selector,
  ServiceEndpoint,
  ServiceInstance
} from "./types"

/** Keeps only service instances whose version equals the requested version. */
export function filterVersion(version: string): Filter {
  /** Applies the captured version predicate without mutating the discovery snapshot. */
  function filter(instances: readonly ServiceInstance[]): readonly ServiceInstance[] {
    return Object.freeze(instances.filter((instance) => instance.version === version))
  }
  return filter
}

/** Keeps only service instances whose metadata contains the requested label pair. */
export function filterLabel(key: string, value: string): Filter {
  /** Applies the captured label predicate without mutating the discovery snapshot. */
  function filter(instances: readonly ServiceInstance[]): readonly ServiceInstance[] {
    return Object.freeze(instances.filter((instance) => instance.metadata[key] === value))
  }
  return filter
}

/** Intentionally ignores v1 feedback while preserving the future policy callback ABI. */
function completeSelection(_ctx: Context, _outcome: SelectionOutcome): void {}

const selectionDone: SelectionDone = Object.freeze(completeSelection)
const MaximumSelectionDomains = 1_024
const DefaultFailureThreshold = 3
const DefaultCooldownMs = 10_000
const MaximumFailureThreshold = 1_000
const MaximumCooldownMs = 2_147_483_647
const EWMATauMs = 600
const EWMANoDataPenaltyNs = 100_000
const EWMALatencyOffsetNs = 5_000_000
const EWMAForcePickMs = 3_000
const EWMAObservationSlots = 200
const EWMAHealthScale = 1_000
const EWMAWeightScale = 10_000
const MaximumSelectorSettlementObservations = 64
const BunWebNetworkFailureCodes: readonly string[] = Object.freeze([
  "ConnectionClosed",
  "ConnectionRefused",
  "ECONNRESET"
])

/** Supplies one numeric sample to a selector without transferring source ownership. */
type NumberSource = () => number

/** Computes one explicit positive endpoint weight. */
type EndpointWeight = (endpoint: ServiceEndpoint) => number

interface WeightedEndpoint {
  readonly endpoint: ServiceEndpoint
  readonly weight: number
}

interface WeightedCursor {
  readonly identity: string
  readonly slot: number
}

interface WeightedChoice {
  readonly endpoint: ServiceEndpoint
  readonly cursor: WeightedCursor
}

interface P2CEndpointState {
  inFlight: number
  consecutiveFailures: number
  cooldownUntil: number
  completionActive: boolean
  completionQueue: SerializedCompletion[]
}

interface P2CDomainState {
  endpoints: Map<string, P2CEndpointState>
}

interface EndpointPair {
  readonly first: ServiceEndpoint
  readonly second: ServiceEndpoint
}

interface EWMAObservation {
  readonly slot: number
  readonly startedAt: number
  readonly tracked: boolean
}

interface EWMAEndpointState {
  latencyMs: number
  success: number
  inFlight: number
  stamp: number
  lastPick: number | null
  nextSlot: number
  observations: (EWMAObservation | null)[]
  completionActive: boolean
  completionQueue: SerializedCompletion[]
}

interface EWMADomainState {
  endpoints: Map<string, EWMAEndpointState>
}

interface ThenCandidate {
  readonly then?: unknown
}

/** Bounds one recursive observation cascade while rejecting thenable cycles by identity. */
interface SelectorSettlementObservation {
  remaining: number
  readonly seen: Set<object>
}

/** Applies one already-admitted endpoint feedback transaction. */
type SerializedCompletion = () => void

/** Owns the synchronous completion queue for one exact endpoint state. */
interface SerializedCompletionState {
  completionActive: boolean
  completionQueue: SerializedCompletion[]
}

/** Reports whether a callback result can expose one structural then method. */
function isThenCandidate(value: unknown): value is ThenCandidate {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Recognizes built-in Error values across realms with a legacy-runtime fallback. */
function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return (typeof candidate === "function" && candidate(value) === true) || value instanceof Error
}

/** Best-effort observes one bounded thenable graph exposed by a synchronous boundary. */
function observeSelectorSettlement(
  value: unknown,
  observation: SelectorSettlementObservation = {
    remaining: MaximumSelectorSettlementObservations,
    seen: new Set<object>()
  },
  consumeBudget = true
): void {
  if (!isThenCandidate(value)) return
  if (observation.seen.has(value)) return
  if (consumeBudget && observation.remaining === 0) return
  if (consumeBudget) observation.remaining -= 1
  observation.seen.add(value)

  /** Recursively consumes a settlement, thrown value, or returned continuation in this graph. */
  function observeNestedSelectorSettlement(nested?: unknown): void {
    observeSelectorSettlement(nested, observation)
  }

  let nativePromise: boolean
  try {
    nativePromise = value instanceof Promise
  } catch (failure) {
    observeNestedSelectorSettlement(failure)
    return
  }
  if (nativePromise) {
    try {
      void Promise.prototype.then.call(
        value,
        observeNestedSelectorSettlement,
        observeNestedSelectorSettlement
      )
    } catch (failure) {
      observeNestedSelectorSettlement(failure)
    }
    return
  }

  let then: unknown
  try {
    then = value.then
  } catch (failure) {
    observeNestedSelectorSettlement(failure)
    return
  }
  if (typeof then !== "function") {
    if (then !== value) observeNestedSelectorSettlement(then)
    return
  }
  try {
    const continuation: unknown = then.call(
      value,
      observeNestedSelectorSettlement,
      observeNestedSelectorSettlement
    )
    if (continuation !== value) observeNestedSelectorSettlement(continuation)
  } catch (failure) {
    observeNestedSelectorSettlement(failure)
    return
  }
}

/** Reads one structural then member while normalizing a hostile accessor. */
function selectorThen(value: ThenCandidate, message: string): unknown {
  try {
    return value.then
  } catch (failure) {
    observeSelectorSettlement(failure)
    throw new TypeError(message, { cause: failure })
  }
}

/** Observes one captured then method before rejecting a synchronous contract. */
function rejectCapturedThenable(value: unknown, then: unknown, message: string): never {
  const observation: SelectorSettlementObservation = {
    remaining: MaximumSelectorSettlementObservations,
    seen: new Set<object>()
  }
  if (isThenCandidate(value)) {
    observation.remaining -= 1
    observation.seen.add(value)
  }

  /** Observes every nested settlement exposed while invoking the captured then method. */
  function observeCapturedSelectorSettlement(settlement?: unknown): void {
    observeSelectorSettlement(settlement, observation)
  }

  try {
    if (typeof then === "function") {
      const continuation: unknown = then.call(
        value,
        observeCapturedSelectorSettlement,
        observeCapturedSelectorSettlement
      )
      if (continuation !== value) {
        observeSelectorSettlement(continuation, observation, then !== Promise.prototype.then)
      }
    }
  } catch (failure) {
    observeCapturedSelectorSettlement(failure)
    throw new TypeError(message, { cause: failure })
  }
  throw new TypeError(message)
}

/** Observes and rejects a value that exposes a callable or asynchronously shaped then member. */
function rejectThenableValue(value: unknown, message: string): void {
  if (!isThenCandidate(value)) return
  const then = selectorThen(value, message)
  if (typeof then === "function") rejectCapturedThenable(value, then, message)
  if (!isThenCandidate(then)) return
  observeSelectorSettlement(then)
  throw new TypeError(message)
}

/** Observes an invalid thenable result before rejecting one synchronous callback contract. */
function rejectInvalidCallbackResult(value: unknown, message: string): never {
  rejectThenableValue(value, message)
  throw new TypeError(message)
}

/** Preserves ordinary throws while observing and rejecting a thrown thenable. */
function rethrowSynchronousBoundaryFailure(value: unknown, message: string): never {
  rejectThenableValue(value, message)
  throw value
}

/** Rejects Promise-like synchronous carriers before their settlement can become unhandled. */
function rejectCarrierThenable(value: object, message: string): void {
  rejectThenableValue(value, message)
}

/** Returns the caller's exact valid cancellation cause before selector state can advance. */
function contextFailure(ctx: Context): Error | null {
  let failure: unknown
  try {
    failure = ctx.err()
  } catch (value) {
    rethrowSynchronousBoundaryFailure(value, "Context.err() must return an Error or null")
  }
  if (failure === null) return null
  rejectThenableValue(failure, "Context.err() must return an Error or null")
  if (!isError(failure)) {
    rejectInvalidCallbackResult(failure, "Context.err() must return an Error or null")
  }

  let specific: Error | null
  try {
    specific = cause(ctx)
  } catch (value) {
    rethrowSynchronousBoundaryFailure(value, "Context cause must return an Error or null")
  }
  rejectThenableValue(specific, "Context cause must return an Error or null")
  return specific ?? failure
}

/** Throws the caller's exact cancellation cause before selector state can advance. */
function throwIfCanceled(ctx: Context): void {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
}

/** Flattens an immutable stable service snapshot into immutable endpoint records. */
function serviceEndpoints(instances: readonly ServiceInstance[]): readonly ServiceEndpoint[] {
  const endpoints: ServiceEndpoint[] = []
  for (const instance of instances) {
    for (const url of instance.endpoints) endpoints.push(Object.freeze({ instance, url }))
  }
  return Object.freeze(endpoints)
}

/** Encodes one logical service tuple without delimiter collisions. */
function serviceTupleIdentity(instance: ServiceInstance): string {
  return `${instance.name.length}:${instance.name}${instance.version.length}:${instance.version}`
}

/** Compares logical service tuples by name and version code points. */
function compareServiceTuples(left: ServiceInstance, right: ServiceInstance): number {
  const byName = compareCodePoints(left.name, right.name)
  return byName === 0 ? compareCodePoints(left.version, right.version) : byName
}

/** Builds one unambiguous cursor domain from the stable unique logical service tuple set. */
function selectionDomain(instances: readonly ServiceInstance[]): string {
  const unique = new Map<string, ServiceInstance>()
  for (const instance of instances) unique.set(serviceTupleIdentity(instance), instance)
  const tuples = Array.from(unique.values()).sort(compareServiceTuples)
  const domains: string[] = []
  for (const instance of tuples) {
    const identity = serviceTupleIdentity(instance)
    domains.push(`${identity.length}:${identity}`)
  }
  return domains.join("")
}

/** Builds one collision-free identity for a stable endpoint membership record. */
function endpointIdentity(endpoint: ServiceEndpoint): string {
  const name = endpoint.instance.name
  const version = endpoint.instance.version
  const id = endpoint.instance.id
  const url = endpoint.url
  return `${name.length}:${name}${version.length}:${version}${id.length}:${id}${url.length}:${url}`
}

/** Returns one already-bounded array item without weakening indexed access checks. */
function itemAt<T>(items: readonly T[], index: number): T {
  return items.reduce(
    /** Retains the item at the requested bounded index. */
    function itemAtIndex(selected, candidate, position) {
      return position === index ? candidate : selected
    }
  )
}

/** Serializes same-endpoint feedback while preserving every admitted reentrant completion. */
function runSerializedCompletion(
  state: SerializedCompletionState,
  completion: SerializedCompletion
): void {
  state.completionQueue.push(completion)
  if (state.completionActive) return

  state.completionActive = true
  const failures: unknown[] = []
  let index = 0
  try {
    while (index < state.completionQueue.length) {
      const queued = itemAt(state.completionQueue, index)
      index += 1
      try {
        queued()
      } catch (failure) {
        failures.push(failure)
      }
    }
  } finally {
    state.completionQueue = []
    state.completionActive = false
  }

  if (failures.length === 1) throw itemAt(failures, 0)
  if (failures.length > 1) {
    throw new AggregateError(failures, "selector endpoint completion transactions failed")
  }
}

/** Selects the stable successor of the previous endpoint, or the first endpoint after membership loss. */
function nextEndpointIndex(
  endpoints: readonly ServiceEndpoint[],
  previous: string | undefined
): number {
  if (previous === undefined) return 0
  for (const [index, endpoint] of endpoints.entries()) {
    if (endpointIdentity(endpoint) === previous) {
      return (index + 1) % endpoints.length
    }
  }
  return 0
}

/** Remembers one domain as most recently used while deterministically evicting the oldest domain. */
function rememberSelection<T>(selections: Map<string, T>, domain: string, selection: T): void {
  selections.delete(domain)
  if (selections.size >= MaximumSelectionDomains) {
    for (const oldest of selections.keys()) {
      selections.delete(oldest)
      break
    }
  }
  selections.set(domain, selection)
}

/** Reads and validates one random result before selector state can change. */
function randomSample(random: NumberSource): number {
  let value: unknown
  try {
    value = random()
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "selector random callback must be synchronous")
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    rejectInvalidCallbackResult(
      value,
      "selector random must return a finite number from 0 inclusive to 1 exclusive"
    )
  }
  return value
}

/** Maps one already-validated random sample into a bounded collection index. */
function sampledIndex(sample: number, count: number): number {
  return Math.floor(sample * count)
}

/** Reads one random sample and maps it into a bounded collection index. */
function randomIndex(random: NumberSource, count: number): number {
  return sampledIndex(randomSample(random), count)
}

/** Reads and validates one named monotonic clock result before selector state can change. */
function monotonicNow(now: NumberSource, selector: string): number {
  let value: unknown
  try {
    value = now()
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, `${selector} clock callback must be synchronous`)
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    rejectInvalidCallbackResult(value, `${selector} clock must return a finite non-negative number`)
  }
  return value
}

/** Reads the standard monotonic clock without capturing a platform-specific owner. */
function performanceNow(): number {
  return performance.now()
}

/** Validates one optional bounded integer selector setting. */
function selectorInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const effective: unknown = value === undefined ? fallback : value
  if (
    typeof effective !== "number" ||
    !Number.isInteger(effective) ||
    effective < minimum ||
    effective > maximum
  ) {
    rejectInvalidCallbackResult(
      effective,
      `${name} must be an integer from ${minimum} to ${maximum}`
    )
  }
  return effective
}

/** Snapshots and validates all weighted candidates before their cursor can advance. */
function weightedEndpoints(
  endpoints: readonly ServiceEndpoint[],
  weight: EndpointWeight
): readonly WeightedEndpoint[] {
  const weighted: WeightedEndpoint[] = []
  for (const endpoint of endpoints) {
    let value: unknown
    try {
      value = weight(endpoint)
    } catch (failure) {
      rethrowSynchronousBoundaryFailure(failure, "selector weight callback must be synchronous")
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      rejectInvalidCallbackResult(value, "selector weight must return a positive safe integer")
    }
    weighted.push({ endpoint, weight: value })
  }
  return weighted
}

/** Chooses the next consecutive weighted slot while retaining a surviving cursor. */
function nextWeightedChoice(
  weighted: readonly WeightedEndpoint[],
  previous: WeightedCursor | undefined
): WeightedChoice {
  if (previous !== undefined) {
    for (const [index, candidate] of weighted.entries()) {
      if (endpointIdentity(candidate.endpoint) !== previous.identity) continue
      const nextSlot = previous.slot + 1
      if (nextSlot < candidate.weight) {
        return {
          endpoint: candidate.endpoint,
          cursor: { identity: previous.identity, slot: nextSlot }
        }
      }
      const next = itemAt(weighted, (index + 1) % weighted.length)
      return {
        endpoint: next.endpoint,
        cursor: { identity: endpointIdentity(next.endpoint), slot: 0 }
      }
    }
  }
  const first = itemAt(weighted, 0)
  return {
    endpoint: first.endpoint,
    cursor: { identity: endpointIdentity(first.endpoint), slot: 0 }
  }
}

/** Returns the in-flight count for one current endpoint without creating state. */
function endpointInFlight(state: P2CDomainState, endpoint: ServiceEndpoint): number {
  return state.endpoints.get(endpointIdentity(endpoint))?.inFlight ?? 0
}

/** Returns the cooldown deadline for one current endpoint without creating state. */
function endpointCooldown(state: P2CDomainState, endpoint: ServiceEndpoint): number {
  return state.endpoints.get(endpointIdentity(endpoint))?.cooldownUntil ?? 0
}

/** Selects the earliest stable cooldown deadline when no endpoint is currently eligible. */
function earliestCooldownEndpoint(
  endpoints: readonly ServiceEndpoint[],
  state: P2CDomainState
): ServiceEndpoint {
  return endpoints.reduce(
    /** Retains the stable first endpoint when cooldown deadlines tie. */
    function earliestEndpoint(selected, candidate) {
      return endpointCooldown(state, candidate) < endpointCooldown(state, selected)
        ? candidate
        : selected
    }
  )
}

/** Maps two already-validated samples to distinct endpoint candidates without replacement. */
function endpointsFromSamples(
  endpoints: readonly ServiceEndpoint[],
  firstSample: number,
  secondSample: number
): EndpointPair {
  const firstIndex = sampledIndex(firstSample, endpoints.length)
  const secondBase = sampledIndex(secondSample, endpoints.length - 1)
  const secondIndex = secondBase >= firstIndex ? secondBase + 1 : secondBase
  return Object.freeze({
    first: itemAt(endpoints, firstIndex),
    second: itemAt(endpoints, secondIndex)
  })
}

/** Samples two distinct endpoint candidates without replacement. */
function sampledEndpoints(
  endpoints: readonly ServiceEndpoint[],
  random: NumberSource
): EndpointPair {
  return endpointsFromSamples(endpoints, randomSample(random), randomSample(random))
}

/** Keeps the lower in-flight candidate from one sampled pair, preferring the first tie. */
function sampledP2CEndpoint(
  eligible: readonly ServiceEndpoint[],
  state: P2CDomainState,
  firstSample: number,
  secondSample: number
): ServiceEndpoint {
  const sampled = endpointsFromSamples(eligible, firstSample, secondSample)
  const first = sampled.first
  const second = sampled.second
  return endpointInFlight(state, second) < endpointInFlight(state, first) ? second : first
}

/** Snapshots the endpoints whose cooldown has expired at one selection timestamp. */
function eligibleP2CEndpoints(
  endpoints: readonly ServiceEndpoint[],
  state: P2CDomainState,
  now: number
): readonly ServiceEndpoint[] {
  const eligible: ServiceEndpoint[] = []
  for (const endpoint of endpoints) {
    if (endpointCooldown(state, endpoint) <= now) eligible.push(endpoint)
  }
  return eligible
}

/** Resolves a zero-or-one candidate snapshot without invoking an external random source. */
function resolvedP2CCandidate(
  endpoints: readonly ServiceEndpoint[],
  eligible: readonly ServiceEndpoint[],
  state: P2CDomainState
): ServiceEndpoint | null {
  if (eligible.length === 0) return earliestCooldownEndpoint(endpoints, state)
  if (eligible.length === 1) return itemAt(eligible, 0)
  return null
}

/** Chooses one P2C candidate without mutating cooldown, load, or domain state. */
function p2cEndpoint(
  endpoints: readonly ServiceEndpoint[],
  state: P2CDomainState,
  random: NumberSource,
  now: number
): ServiceEndpoint {
  let eligible = eligibleP2CEndpoints(endpoints, state, now)
  let selected = resolvedP2CCandidate(endpoints, eligible, state)
  if (selected !== null) return selected

  const firstSample = randomSample(random)
  eligible = eligibleP2CEndpoints(endpoints, state, now)
  selected = resolvedP2CCandidate(endpoints, eligible, state)
  if (selected !== null) return selected

  const secondSample = randomSample(random)
  eligible = eligibleP2CEndpoints(endpoints, state, now)
  selected = resolvedP2CCandidate(endpoints, eligible, state)
  if (selected !== null) return selected
  return sampledP2CEndpoint(eligible, state, firstSample, secondSample)
}

/** Retains only current endpoint state and returns the selected mutable counter. */
function selectedP2CState(
  domain: P2CDomainState,
  endpoints: readonly ServiceEndpoint[],
  selected: ServiceEndpoint
): P2CEndpointState {
  const active = new Map<string, P2CEndpointState>()
  for (const endpoint of endpoints) {
    const identity = endpointIdentity(endpoint)
    const current = domain.endpoints.get(identity)
    if (current !== undefined) active.set(identity, current)
  }
  const identity = endpointIdentity(selected)
  let state = active.get(identity)
  if (state === undefined) {
    state = {
      inFlight: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      completionActive: false,
      completionQueue: []
    }
    active.set(identity, state)
  }
  domain.endpoints = active
  return state
}

/** Saturates one valid cooldown deadline rather than retaining an infinite timestamp. */
function cooldownDeadline(now: number, cooldownMs: number): number {
  const deadline = now + cooldownMs
  return Number.isFinite(deadline) ? deadline : Number.MAX_VALUE
}

/** Creates one frozen idempotent P2C feedback callback over the selected endpoint state. */
function p2cSelectionDone(
  state: P2CEndpointState,
  now: NumberSource,
  failureThreshold: number,
  cooldownMs: number
): SelectionDone {
  let completion: "open" | "admitting" | "queued" | "completed" = "open"
  /** Applies one admitted completion atomically with every other completion for this endpoint. */
  function settle(failure: Error | null): void {
    try {
      const nextFailures = failure === null ? 0 : state.consecutiveFailures + 1
      let deadline = state.cooldownUntil
      if (failure !== null && nextFailures >= failureThreshold) {
        deadline = cooldownDeadline(monotonicNow(now, "P2C selector"), cooldownMs)
      }

      state.inFlight -= 1
      if (failure === null) {
        state.consecutiveFailures = 0
        state.cooldownUntil = 0
      } else {
        state.consecutiveFailures = nextFailures
        state.cooldownUntil = deadline
      }
      completion = "completed"
    } catch (cause) {
      completion = "open"
      throw cause
    }
  }

  /** Admits one immutable outcome and queues its exact endpoint transaction once. */
  function complete(ctx: Context, outcome: SelectionOutcome): void {
    if (completion !== "open") return
    completion = "admitting"
    let failure: Error | null
    try {
      throwIfCanceled(ctx)
      failure = selectionOutcomeError(outcome)
    } catch (cause) {
      completion = "open"
      throw cause
    }
    completion = "queued"
    /** Applies this admitted P2C transaction when its endpoint queue reaches it. */
    function settleP2CSelection(): void {
      settle(failure)
    }
    runSerializedCompletion(state, settleP2CSelection)
  }
  return Object.freeze(complete)
}

/** Creates one fresh EWMA endpoint state with the same neutral priors as Kratos. */
function newEWMAEndpointState(): EWMAEndpointState {
  return {
    latencyMs: 0,
    success: EWMAHealthScale,
    inFlight: 1,
    stamp: 0,
    lastPick: null,
    nextSlot: 1,
    observations: new Array<EWMAObservation | null>(EWMAObservationSlots).fill(null),
    completionActive: false,
    completionQueue: []
  }
}

/** Drops departed endpoint state while retaining current endpoint observations by identity. */
function retainEWMAEndpointStates(
  domain: EWMADomainState,
  endpoints: readonly ServiceEndpoint[]
): void {
  const active = new Map<string, EWMAEndpointState>()
  for (const endpoint of endpoints) {
    const identity = endpointIdentity(endpoint)
    const state = domain.endpoints.get(identity)
    if (state !== undefined) active.set(identity, state)
  }
  domain.endpoints = active
}

/** Returns one current endpoint state, creating its neutral prior exactly once. */
function ewmaEndpointState(domain: EWMADomainState, endpoint: ServiceEndpoint): EWMAEndpointState {
  const identity = endpointIdentity(endpoint)
  let state = domain.endpoints.get(identity)
  if (state === undefined) {
    state = newEWMAEndpointState()
    domain.endpoints.set(identity, state)
  }
  return state
}

/** Predicts current latency when a majority of tracked in-flight requests exceed the EWMA. */
function predictedEWMALatency(state: EWMAEndpointState, now: number): number {
  let total = 0
  let slow = 0
  let tracked = 0
  for (const observation of state.observations) {
    if (observation === null) continue
    tracked += 1
    const latency = Math.max(now - observation.startedAt, 0)
    if (latency <= state.latencyMs) continue
    slow += 1
    total += latency
  }
  return slow >= Math.floor(tracked / 2) + 1 ? total / slow : 0
}

/** Computes the current latency-and-in-flight load with Kratos-compatible unit constants. */
function ewmaLoad(state: EWMAEndpointState, now: number): number {
  const predicted = predictedEWMALatency(state, now)
  if (state.latencyMs === 0) return EWMANoDataPenaltyNs * state.inFlight
  const latency = Math.max(state.latencyMs, predicted)
  return Math.trunc(Math.sqrt(latency * 1_000_000 + EWMALatencyOffsetNs)) * state.inFlight
}

/** Computes one endpoint's current health-over-load scheduling weight. */
function ewmaWeight(state: EWMAEndpointState, now: number): number {
  return (state.success * EWMAWeightScale) / ewmaLoad(state, now)
}

/** Chooses the higher-weight sampled endpoint, with Kratos's stale-node force-pick rule. */
function ewmaEndpoint(
  sampled: EndpointPair,
  domain: EWMADomainState,
  now: number
): ServiceEndpoint {
  const firstState = ewmaEndpointState(domain, sampled.first)
  const secondState = ewmaEndpointState(domain, sampled.second)
  const firstPreferred = ewmaWeight(secondState, now) <= ewmaWeight(firstState, now)
  const preferred = firstPreferred ? sampled.first : sampled.second
  const alternate = firstPreferred ? sampled.second : sampled.first
  const alternateState = firstPreferred ? secondState : firstState
  if (alternateState.lastPick === null || now - alternateState.lastPick > EWMAForcePickMs) {
    return alternate
  }
  return preferred
}

/** Starts one bounded EWMA observation and advances its fixed ring slot. */
function startEWMAObservation(state: EWMAEndpointState, now: number): EWMAObservation {
  const slot = state.nextSlot
  state.nextSlot = (slot + 1) % EWMAObservationSlots
  const tracked = state.observations[slot] === null
  const observation = Object.freeze({ slot, startedAt: now, tracked })
  if (tracked) state.observations[slot] = observation
  state.lastPick = state.lastPick === null ? now : Math.max(state.lastPick, now)
  state.inFlight += 1
  return observation
}

/** Validates one public selection outcome before EWMA state can change. */
function selectionOutcomeError(outcome: SelectionOutcome): Error | null {
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    observeSelectorSettlement(outcome)
    throw new TypeError("selection outcome must be an object")
  }
  rejectCarrierThenable(outcome, "selection outcome must be a plain synchronous object")
  let failure: unknown
  try {
    failure = outcome.error
  } catch (value) {
    rethrowSynchronousBoundaryFailure(value, "selection outcome error getter must be synchronous")
  }
  if (failure !== null) {
    rejectThenableValue(failure, "selection outcome error must be an Error or null")
    if (!isError(failure)) {
      rejectInvalidCallbackResult(failure, "selection outcome error must be an Error or null")
    }
  }
  return failure
}

/** Classifies portable Context, Fetch-network, and HTTP availability failures. */
function standardEWMAFailure(error: Error): boolean {
  try {
    const name: unknown = error.name
    if (typeof name !== "string") {
      rejectInvalidCallbackResult(name, "selection outcome Error.name must be a string")
    }
    if (
      name === "Canceled" ||
      name === "DeadlineExceeded" ||
      name === "AbortError" ||
      name === "TimeoutError"
    ) {
      return true
    }
    if (error instanceof TypeError) return true
    if ("status" in error) {
      const status: unknown = error.status
      rejectThenableValue(status, "selection outcome Error.status must be synchronous")
      return status === 503 || status === 504
    }
    if ("code" in error) {
      const code: unknown = error.code
      rejectThenableValue(code, "selection outcome Error.code must be synchronous")
      if (typeof code === "string") return BunWebNetworkFailureCodes.includes(code)
    }
    return false
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(
      failure,
      "selection outcome Error classification must be synchronous"
    )
  }
}

/** Applies one optional failure extension without replacing built-in portable classification. */
function isEWMAFailure(
  error: Error | null,
  isFailure: ((error: Error) => boolean) | undefined
): boolean {
  if (error === null) return false
  if (standardEWMAFailure(error)) return true
  if (isFailure === undefined) return false
  let result: unknown
  try {
    result = isFailure(error)
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(
      failure,
      "EWMA selector isFailure callback must be synchronous"
    )
  }
  if (typeof result !== "boolean") {
    rejectInvalidCallbackResult(result, "EWMA selector isFailure must return a boolean")
  }
  return result
}

/** Creates one frozen idempotent EWMA feedback callback over an exact observation. */
function ewmaSelectionDone(
  state: EWMAEndpointState,
  observation: EWMAObservation,
  now: NumberSource,
  isFailure: ((error: Error) => boolean) | undefined
): SelectionDone {
  let completion: "open" | "admitting" | "queued" | "completed" = "open"
  /** Applies one admitted observation atomically with every other completion for this endpoint. */
  function settle(error: Error | null): void {
    try {
      const completedAt = monotonicNow(now, "EWMA selector")
      const failed = isEWMAFailure(error, isFailure)
      const elapsed = Math.max(completedAt - observation.startedAt, 0)
      const stamp = Math.max(state.stamp, completedAt)
      const elapsedSinceUpdate = stamp - state.stamp
      let decay = Math.exp(-elapsedSinceUpdate / EWMATauMs)
      if (state.latencyMs === 0) decay = 0
      const latency = state.latencyMs * decay + elapsed * (1 - decay)
      const health = failed ? 0 : EWMAHealthScale
      const success = Math.trunc(state.success * decay + health * (1 - decay))

      if (observation.tracked && state.observations[observation.slot] === observation) {
        state.observations[observation.slot] = null
      }
      state.inFlight -= 1
      state.latencyMs = latency
      state.success = success
      state.stamp = stamp
      completion = "completed"
    } catch (cause) {
      completion = "open"
      throw cause
    }
  }

  /** Admits one immutable outcome and queues its exact endpoint transaction once. */
  function complete(ctx: Context, outcome: SelectionOutcome): void {
    if (completion !== "open") return
    completion = "admitting"
    let error: Error | null
    try {
      throwIfCanceled(ctx)
      error = selectionOutcomeError(outcome)
    } catch (cause) {
      completion = "open"
      throw cause
    }
    completion = "queued"
    /** Applies this admitted EWMA transaction when its endpoint queue reaches it. */
    function settleEWMASelection(): void {
      settle(error)
    }
    runSerializedCompletion(state, settleEWMASelection)
  }
  return Object.freeze(complete)
}

/** Creates a portable in-memory round-robin endpoint selector with no resident resources. */
export function newRoundRobinSelector(): Selector {
  const selections = new Map<string, string>()
  return Object.freeze({
    /** Selects the stable successor and retains at most 1,024 recently used service domains. */
    select(
      ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      throwIfCanceled(ctx)
      const snapshot = snapshotServiceInstances(instances)
      const endpoints = serviceEndpoints(snapshot)
      if (endpoints.length === 0) throw newNoAvailableEndpointError()
      const domain = selectionDomain(snapshot)
      const index = nextEndpointIndex(endpoints, selections.get(domain))
      const endpoint = itemAt(endpoints, index)
      rememberSelection(selections, domain, endpointIdentity(endpoint))
      return Object.freeze([endpoint, selectionDone])
    }
  })
}

/** Creates a portable stateless random endpoint selector with one sample per selection. */
export function newRandomSelector(random?: () => number): Selector {
  if (random !== undefined) {
    rejectThenableValue(random, "selector random must be a plain synchronous function")
  }
  if (random !== undefined && typeof random !== "function") {
    rejectInvalidCallbackResult(random, "selector random must be a function")
  }
  const source = random === undefined ? Math.random : random
  return Object.freeze({
    /** Selects one stable endpoint using exactly one validated random sample. */
    select(
      ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      throwIfCanceled(ctx)
      const snapshot = snapshotServiceInstances(instances)
      const endpoints = serviceEndpoints(snapshot)
      if (endpoints.length === 0) throw newNoAvailableEndpointError()
      return Object.freeze([
        itemAt(endpoints, randomIndex(source, endpoints.length)),
        selectionDone
      ])
    }
  })
}

/** Creates a weighted round-robin selector with explicit consecutive endpoint slots. */
export function newWeightedRoundRobinSelector(
  weight: (endpoint: ServiceEndpoint) => number
): Selector {
  rejectThenableValue(weight, "selector weight must be a plain synchronous function")
  if (typeof weight !== "function") {
    rejectInvalidCallbackResult(weight, "selector weight must be a function")
  }
  const selections = new Map<string, WeightedCursor>()
  return Object.freeze({
    /** Validates every current weight before advancing one stable weighted cursor. */
    select(
      ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      throwIfCanceled(ctx)
      const snapshot = snapshotServiceInstances(instances)
      const endpoints = serviceEndpoints(snapshot)
      if (endpoints.length === 0) throw newNoAvailableEndpointError()
      const domain = selectionDomain(snapshot)
      const weighted = weightedEndpoints(endpoints, weight)
      const choice = nextWeightedChoice(weighted, selections.get(domain))
      rememberSelection(selections, domain, choice.cursor)
      return Object.freeze([choice.endpoint, selectionDone])
    }
  })
}

/** Creates a bounded P2C selector weighted by exponentially decayed latency and health. */
export function newEWMASelector(options?: EWMASelectorOptions): Selector {
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    observeSelectorSettlement(options)
    throw new TypeError("EWMA selector options must be an object")
  }
  if (options !== undefined) {
    rejectCarrierThenable(options, "EWMA selector options must be a plain synchronous object")
  }
  let configuredRandom: EWMASelectorOptions["random"]
  try {
    configuredRandom = options === undefined ? undefined : options.random
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "EWMA selector option getters must be synchronous")
  }
  if (configuredRandom !== undefined) {
    rejectThenableValue(
      configuredRandom,
      "EWMA selector random must be a plain synchronous function"
    )
  }
  if (configuredRandom !== undefined && typeof configuredRandom !== "function") {
    rejectInvalidCallbackResult(configuredRandom, "EWMA selector random must be a function")
  }

  let configuredNow: EWMASelectorOptions["now"]
  try {
    configuredNow = options === undefined ? undefined : options.now
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "EWMA selector option getters must be synchronous")
  }
  if (configuredNow !== undefined) {
    rejectThenableValue(configuredNow, "EWMA selector clock must be a plain synchronous function")
  }
  if (configuredNow !== undefined && typeof configuredNow !== "function") {
    rejectInvalidCallbackResult(configuredNow, "EWMA selector clock must be a function")
  }

  let configuredIsFailure: EWMASelectorOptions["isFailure"]
  try {
    configuredIsFailure = options === undefined ? undefined : options.isFailure
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "EWMA selector option getters must be synchronous")
  }
  if (configuredIsFailure !== undefined) {
    rejectThenableValue(
      configuredIsFailure,
      "EWMA selector isFailure must be a plain synchronous function"
    )
  }
  if (configuredIsFailure !== undefined && typeof configuredIsFailure !== "function") {
    rejectInvalidCallbackResult(configuredIsFailure, "EWMA selector isFailure must be a function")
  }
  const random = configuredRandom === undefined ? Math.random : configuredRandom
  const now = configuredNow === undefined ? performanceNow : configuredNow
  const domains = new Map<string, EWMADomainState>()

  return Object.freeze({
    /** Selects by sampled EWMA health-over-load and records one bounded in-flight observation. */
    select(
      ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      throwIfCanceled(ctx)
      const snapshot = snapshotServiceInstances(instances)
      const endpoints = serviceEndpoints(snapshot)
      if (endpoints.length === 0) throw newNoAvailableEndpointError()
      const timestamp = monotonicNow(now, "EWMA selector")
      const sampled = endpoints.length === 1 ? null : sampledEndpoints(endpoints, random)
      const domain = selectionDomain(snapshot)
      const state = domains.get(domain) ?? { endpoints: new Map<string, EWMAEndpointState>() }
      retainEWMAEndpointStates(state, endpoints)
      const selected =
        sampled === null ? itemAt(endpoints, 0) : ewmaEndpoint(sampled, state, timestamp)
      const selectedState = ewmaEndpointState(state, selected)
      const observation = startEWMAObservation(selectedState, timestamp)
      rememberSelection(domains, domain, state)
      return Object.freeze([
        selected,
        ewmaSelectionDone(selectedState, observation, now, configuredIsFailure)
      ])
    }
  })
}

/** Creates a bounded power-of-two-choices selector with failure cooldown feedback. */
export function newP2CSelector(options?: P2CSelectorOptions): Selector {
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    observeSelectorSettlement(options)
    throw new TypeError("P2C selector options must be an object")
  }
  if (options !== undefined) {
    rejectCarrierThenable(options, "P2C selector options must be a plain synchronous object")
  }
  let configuredRandom: P2CSelectorOptions["random"]
  try {
    configuredRandom = options === undefined ? undefined : options.random
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "P2C selector option getters must be synchronous")
  }
  if (configuredRandom !== undefined) {
    rejectThenableValue(
      configuredRandom,
      "P2C selector random must be a plain synchronous function"
    )
  }
  if (configuredRandom !== undefined && typeof configuredRandom !== "function") {
    rejectInvalidCallbackResult(configuredRandom, "P2C selector random must be a function")
  }

  let configuredNow: P2CSelectorOptions["now"]
  try {
    configuredNow = options === undefined ? undefined : options.now
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "P2C selector option getters must be synchronous")
  }
  if (configuredNow !== undefined) {
    rejectThenableValue(configuredNow, "P2C selector clock must be a plain synchronous function")
  }
  if (configuredNow !== undefined && typeof configuredNow !== "function") {
    rejectInvalidCallbackResult(configuredNow, "P2C selector clock must be a function")
  }
  const random = configuredRandom === undefined ? Math.random : configuredRandom
  const now = configuredNow === undefined ? performanceNow : configuredNow

  let configuredFailureThreshold: P2CSelectorOptions["failureThreshold"]
  try {
    configuredFailureThreshold = options === undefined ? undefined : options.failureThreshold
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "P2C selector option getters must be synchronous")
  }
  const failureThreshold = selectorInteger(
    configuredFailureThreshold,
    DefaultFailureThreshold,
    1,
    MaximumFailureThreshold,
    "P2C selector failureThreshold"
  )

  let configuredCooldownMs: P2CSelectorOptions["cooldownMs"]
  try {
    configuredCooldownMs = options === undefined ? undefined : options.cooldownMs
  } catch (failure) {
    rethrowSynchronousBoundaryFailure(failure, "P2C selector option getters must be synchronous")
  }
  const cooldownMs = selectorInteger(
    configuredCooldownMs,
    DefaultCooldownMs,
    1,
    MaximumCooldownMs,
    "P2C selector cooldownMs"
  )
  const domains = new Map<string, P2CDomainState>()

  return Object.freeze({
    /** Selects by current eligibility and in-flight load before incrementing exactly one endpoint. */
    select(
      ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      throwIfCanceled(ctx)
      const snapshot = snapshotServiceInstances(instances)
      const endpoints = serviceEndpoints(snapshot)
      if (endpoints.length === 0) throw newNoAvailableEndpointError()
      const domain = selectionDomain(snapshot)
      const current = domains.get(domain)
      const state = current ?? { endpoints: new Map<string, P2CEndpointState>() }
      if (current === undefined) domains.set(domain, state)
      let selected: ServiceEndpoint
      try {
        selected = p2cEndpoint(endpoints, state, random, monotonicNow(now, "P2C selector"))
      } catch (failure) {
        if (current === undefined && state.endpoints.size === 0 && domains.get(domain) === state) {
          domains.delete(domain)
        }
        throw failure
      }
      const selectedState = selectedP2CState(state, endpoints, selected)
      selectedState.inFlight += 1
      rememberSelection(domains, domain, state)
      return Object.freeze([
        selected,
        p2cSelectionDone(selectedState, now, failureThreshold, cooldownMs)
      ])
    }
  })
}
