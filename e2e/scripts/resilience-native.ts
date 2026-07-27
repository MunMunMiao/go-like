import { background, type Context } from "@likego/context"
import {
  circuitOpen,
  exponentialBackoff,
  newCircuitBreaker,
  newTokenBucketLimiter,
  retry
} from "@likego/resilience"

/** Fails one native resilience scenario when its observable invariant is false. */
function ensure(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Waits for one real standard-timer interval. */
function delay(delayMs: number): Promise<void> {
  return new Promise<void>(function wait(resolve) {
    setTimeout(resolve, delayMs)
  })
}

/** Counts native timeout resources without retaining the resource objects. */
function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter(function timeout(value) {
    return value === "Timeout"
  }).length
}

/** Captures one rejected operation without changing its identity. */
async function rejected(operation: Promise<unknown>, label: string): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error(`${label} unexpectedly succeeded`)
}

const baselineTimeouts = activeTimeouts()
const scenarios: string[] = []

const retryFailure = new Error("temporary upstream failure")
const requestIdentities = new Set<Request>()
const requestBodies: string[] = []
const retryDelays: number[] = []
let retryAttempts = 0
const retryBackoff = exponentialBackoff({
  initialDelayMs: 2,
  multiplier: 2,
  maxDelayMs: 3
})

/** Creates and consumes one new Request inside each explicitly numbered attempt. */
async function fetchAttempt(_ctx: Context, attempt: number): Promise<Response> {
  retryAttempts += 1
  const request = new Request(`https://service.test/retry/${attempt}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: `attempt-${attempt}`
  })
  requestIdentities.add(request)
  requestBodies.push(await request.text())
  if (attempt < 3) throw retryFailure
  return new Response("accepted", { status: 201 })
}

/** Retries only the reviewed transient failure before the configured attempt bound. */
function retryTransient(_ctx: Context, failure: unknown, attempt: number): boolean {
  return failure === retryFailure && attempt < 3
}

/** Records the exact capped delay selected for each failed attempt. */
function observedRetryBackoff(attempt: number): number {
  const delayMs = retryBackoff(attempt)
  retryDelays.push(delayMs)
  return delayMs
}

const retryResponse = await retry(background(), fetchAttempt, {
  authorization: "idempotent",
  maxAttempts: 3,
  shouldRetry: retryTransient,
  backoff: observedRetryBackoff
})
ensure(
  retryResponse.status === 201 && (await retryResponse.text()) === "accepted",
  "retry result changed"
)
ensure(retryAttempts === 3, `retry attempts changed: ${retryAttempts}`)
ensure(requestIdentities.size === 3, "retry reused a Request instance")
ensure(requestBodies.join(",") === "attempt-1,attempt-2,attempt-3", "retry Request bodies changed")
ensure(retryDelays.join(",") === "2,3", `retry backoff sequence changed: ${retryDelays.join(",")}`)
scenarios.push("retry-fresh-request-bounded-backoff")

const breakerFailure = new Error("upstream unavailable")
const breaker = newCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 25 })
let circuitInvocations = 0

/** Records one breaker-owned failed invocation. */
async function failCircuit(_ctx: Context): Promise<never> {
  circuitInvocations += 1
  throw breakerFailure
}

ensure(
  (await rejected(breaker.execute(background(), failCircuit), "first breaker failure")) ===
    breakerFailure,
  "first breaker failure identity changed"
)
ensure(
  (await rejected(breaker.execute(background(), failCircuit), "second breaker failure")) ===
    breakerFailure,
  "second breaker failure identity changed"
)
const opened = breaker.snapshot()
ensure(
  opened.state === "open" &&
    opened.consecutiveFailures === 2 &&
    !opened.probeActive &&
    opened.retryAfterMs > 0,
  "circuit did not open at its failure threshold"
)

/** Would expose an incorrect open-circuit admission by incrementing the invocation count. */
function blockedCircuitOperation(_ctx: Context): string {
  circuitInvocations += 1
  return "unexpected"
}

const openFailure = await rejected(
  breaker.execute(background(), blockedCircuitOperation),
  "open circuit"
)
ensure(
  openFailure === circuitOpen && Object.isFrozen(circuitOpen),
  "open circuit sentinel identity changed"
)
ensure(circuitInvocations === 2, "open circuit invoked rejected work")
const blockedInvocationCount = circuitInvocations

await delay(35)
const halfOpen = breaker.snapshot()
ensure(halfOpen.state === "half-open" && !halfOpen.probeActive, "circuit did not become half-open")

/** Succeeds as the sole half-open recovery probe. */
function recoverCircuit(_ctx: Context): string {
  circuitInvocations += 1
  return "recovered"
}

const recoveryResult = await breaker.execute(background(), recoverCircuit)
ensure(recoveryResult === "recovered", "half-open probe did not recover")
const closed = breaker.snapshot()
ensure(
  closed.state === "closed" &&
    closed.consecutiveFailures === 0 &&
    !closed.probeActive &&
    closed.retryAfterMs === 0,
  "successful probe did not close the circuit"
)
ensure(circuitInvocations === 3, "circuit invocation count changed")
scenarios.push("circuit-open-half-open-recovery")

const limiter = newTokenBucketLimiter({
  capacity: 2,
  refillTokens: 1,
  refillIntervalMs: 20,
  initialTokens: 2
})
const firstAdmission = limiter.allow(background())
const secondAdmission = limiter.allow(background())
const deniedAdmission = limiter.allow(background())
ensure(
  firstAdmission.allowed && secondAdmission.allowed,
  "token bucket rejected its configured burst"
)
ensure(
  !deniedAdmission.allowed && deniedAdmission.retryAfterMs > 0,
  "token bucket did not reject excess work with a retry delay"
)
const emptySnapshot = limiter.snapshot()
ensure(emptySnapshot.availableTokens === 0, "empty token bucket snapshot changed")
const refillLimiter = newTokenBucketLimiter({
  capacity: 1,
  refillTokens: 1,
  refillIntervalMs: 20,
  initialTokens: 0
})
ensure(!refillLimiter.allow(background()).allowed, "explicitly empty refill bucket admitted work")
await delay(25)
const refilledSnapshot = refillLimiter.snapshot()
ensure(
  refilledSnapshot.availableTokens === 1,
  "token bucket did not expose exactly one configured refill token"
)
const refilledAdmission = refillLimiter.allow(background())
const consumedSnapshot = refillLimiter.snapshot()
ensure(refilledAdmission.allowed, "refilled token was not admitted")
ensure(
  consumedSnapshot.availableTokens === refilledSnapshot.availableTokens - 1,
  "refilled admission did not consume exactly one token"
)
ensure(
  Object.isFrozen(firstAdmission) &&
    Object.isFrozen(deniedAdmission) &&
    Object.isFrozen(refilledSnapshot) &&
    Object.isFrozen(consumedSnapshot),
  "rate-limit evidence was mutable"
)
scenarios.push("token-bucket-capacity-refill")

await Promise.resolve()
const finalTimeouts = activeTimeouts()
ensure(
  finalTimeouts === baselineTimeouts,
  `resilience timers leaked: ${baselineTimeouts}->${finalTimeouts}`
)

process.stdout.write(
  `LIKEGO_RESILIENCE_E2E_RESULT=${JSON.stringify({
    valid: true,
    package: "@likego/resilience",
    runtime: `bun-${Bun.version}`,
    scenarios,
    scenarioEvidence: {
      "retry-fresh-request-bounded-backoff": {
        attempts: retryAttempts,
        requestInstances: requestIdentities.size,
        requestBodySequence: requestBodies.join(","),
        delaySequence: retryDelays.join(","),
        status: retryResponse.status
      },
      "circuit-open-half-open-recovery": {
        openedState: opened.state,
        openedFailures: opened.consecutiveFailures,
        openedRetryAfterPositive: opened.retryAfterMs > 0,
        openSentinelIdentityStable: openFailure === circuitOpen,
        blockedInvocationCount,
        halfOpenState: halfOpen.state,
        recoveryResult,
        finalState: closed.state,
        finalInvocations: circuitInvocations,
        finalProbeActive: closed.probeActive
      },
      "token-bucket-capacity-refill": {
        initialAllowed: Number(firstAdmission.allowed) + Number(secondAdmission.allowed),
        excessAllowed: deniedAdmission.allowed,
        retryAfterMs: deniedAdmission.retryAfterMs,
        emptyAvailableTokens: emptySnapshot.availableTokens,
        configuredRefillTokens: 1,
        refilledAvailableTokens: refilledSnapshot.availableTokens,
        refillAdmissionAllowed: refilledAdmission.allowed,
        consumedExactlyOne:
          consumedSnapshot.availableTokens === refilledSnapshot.availableTokens - 1
      }
    },
    retry: {
      attempts: retryAttempts,
      requestInstances: requestIdentities.size,
      requestBodies,
      delays: retryDelays,
      status: retryResponse.status
    },
    circuit: {
      invocations: circuitInvocations,
      finalState: closed.state,
      probeActive: closed.probeActive,
      recovered: closed.state === "closed" && closed.consecutiveFailures === 0
    },
    limiter: {
      initialAdmissions: 2,
      rejectedExcess: !deniedAdmission.allowed,
      finalAvailableTokens: consumedSnapshot.availableTokens,
      refillObserved: refilledSnapshot.availableTokens === 1 && refilledAdmission.allowed
    },
    cleanup: {
      baselineTimeouts,
      finalTimeouts,
      pendingTimers: finalTimeouts - baselineTimeouts
    }
  })}\n`
)
