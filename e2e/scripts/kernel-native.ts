import {
  afterFunc,
  background,
  canceled,
  cause,
  deadlineExceeded,
  withCancel,
  withCancelCause,
  withTimeout,
  withValue,
  withoutCancel,
  type Context
} from "@likego/context"
import { name, newApp, server, type Server } from "@likego/core"
import { newProbeRegistry } from "@likego/health"
import { createHealthHandler } from "@likego/web/health"

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

/** Creates one externally settled operation without exposing mutable Promise internals. */
function deferred(): Deferred {
  let resolvePromise: () => void = unavailable
  const promise = new Promise<void>(function capture(resolve) {
    resolvePromise = resolve
  })
  return Object.freeze({ promise, resolve: resolvePromise })
}

/** Guards impossible use before the Promise constructor captures its resolver. */
function unavailable(): void {
  throw new Error("deferred resolver is unavailable")
}

/** Fails one native scenario when its observed invariant is false. */
function ensure(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Waits until one Context cancellation signal is observably aborted. */
function waitForAbort(ctx: Context): Promise<void> {
  const signal = ctx.done()
  if (signal === null) throw new Error("context does not expose a cancellation signal")
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>(function wait(resolve) {
    signal.addEventListener(
      "abort",
      function aborted() {
        resolve()
      },
      { once: true }
    )
  })
}

/** Lets queued cancellation callbacks reach their observable microtask boundary. */
function microtaskCheckpoint(): Promise<void> {
  return Promise.resolve().then(function secondCheckpoint() {})
}

/** Counts native timeout resources without retaining the resource objects. */
function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter(function timeout(value) {
    return value === "Timeout"
  }).length
}

/** Builds a plain structural Server and records its start and stop ordering. */
function structuralServer(label: string, events: string[], terminals: string[]): Server {
  let started = false
  let stopped = false
  const terminal = deferred()
  return Object.freeze({
    async start(_ctx: Context): Promise<void> {
      if (started) throw new Error(`${label} was started twice`)
      started = true
      events.push(`start:${label}`)
      await terminal.promise
    },
    async stop(_ctx: Context): Promise<void> {
      if (stopped) return
      stopped = true
      events.push(`stop:${label}`)
      terminals.push(label)
      terminal.resolve()
    }
  })
}

const baselineTimeouts = activeTimeouts()
const scenarios: string[] = []
const scenarioEvidence: Record<string, Readonly<Record<string, unknown>>> = {}

const [cancelParent, cancelParentCause] = withCancelCause(background())
const [cancelChild, releaseCancelChild] = withCancel(cancelParent)
const cancelChildSignal = cancelChild.done()
const parentCause = new Error("parent operation canceled")
cancelParentCause(parentCause)
await waitForAbort(cancelChild)
ensure(cancelChild.err() === canceled, "child context did not expose the canceled sentinel")
ensure(
  cause(cancelChild) === parentCause,
  "child context did not retain the parent cancellation cause"
)
releaseCancelChild()
scenarios.push("context-parent-cancel-cause-propagation")
scenarioEvidence["context-parent-cancel-cause-propagation"] = Object.freeze({
  signalAborted: cancelChildSignal?.aborted === true,
  canceledSentinelObserved: cancelChild.err() === canceled,
  causeIdentityStable: cause(cancelChild) === parentCause
})

const [timeoutContext, releaseTimeout] = withTimeout(background(), 5)
const deadline = timeoutContext.deadline()
ensure(deadline[1] && deadline[0] instanceof Date, "timeout context did not expose a deadline")
await waitForAbort(timeoutContext)
ensure(timeoutContext.err() === deadlineExceeded, "timeout did not expose deadlineExceeded")
ensure(cause(timeoutContext) === deadlineExceeded, "timeout cause did not match deadlineExceeded")
releaseTimeout()
scenarios.push("context-deadline-timeout-sentinel")
scenarioEvidence["context-deadline-timeout-sentinel"] = Object.freeze({
  deadlineObserved: deadline[1] && deadline[0] instanceof Date,
  signalAborted: timeoutContext.done()?.aborted === true,
  errorIsDeadlineExceeded: timeoutContext.err() === deadlineExceeded,
  causeIsDeadlineExceeded: cause(timeoutContext) === deadlineExceeded
})

const valueKey = Object.freeze({ name: "request-id" })
const [valuedParent, releaseValuedParent] = withCancel(withValue(background(), valueKey, "req-42"))
const detached = withoutCancel(valuedParent)
releaseValuedParent()
await waitForAbort(valuedParent)
ensure(detached.value(valueKey) === "req-42", "withoutCancel lost the parent value")
ensure(detached.done() === null && detached.err() === null, "withoutCancel inherited cancellation")
ensure(detached.deadline()[1] === false, "withoutCancel inherited a deadline")
scenarios.push("context-without-cancel-retains-values")
scenarioEvidence["context-without-cancel-retains-values"] = Object.freeze({
  value: detached.value(valueKey),
  parentSignalAborted: valuedParent.done()?.aborted === true,
  doneDetached: detached.done() === null,
  errorDetached: detached.err() === null,
  deadlineDetached: detached.deadline()[1] === false
})

const [stoppedContext, cancelStoppedContext] = withCancel(background())
let stoppedCallbackCalls = 0
const stopCallback = afterFunc(stoppedContext, function stoppedCallback() {
  stoppedCallbackCalls += 1
})
const stoppedBeforeCancellation = stopCallback()
ensure(stoppedBeforeCancellation, "afterFunc stop did not win before cancellation")
cancelStoppedContext()
await microtaskCheckpoint()
ensure(stoppedCallbackCalls === 0, "stopped afterFunc callback still ran")

const [firedContext, cancelFiredContext] = withCancel(background())
let firedCallbackCalls = 0
const fired = deferred()
const stopFiredCallback = afterFunc(firedContext, function firedCallback() {
  firedCallbackCalls += 1
  fired.resolve()
})
cancelFiredContext()
await fired.promise
const stoppedAfterAdmission = stopFiredCallback()
ensure(!stoppedAfterAdmission, "afterFunc stop won after callback admission")
ensure(firedCallbackCalls === 1, "afterFunc callback did not run exactly once")
scenarios.push("context-after-func-stop-race")
scenarioEvidence["context-after-func-stop-race"] = Object.freeze({
  stoppedCallbackCalls,
  firedCallbackCalls,
  stoppedBeforeCancellation,
  stoppedAfterAdmission,
  firedSignalAborted: firedContext.done()?.aborted === true
})

const lifecycleEvents: string[] = []
const serverTerminals: string[] = []
const app = newApp(
  name("sourced-e2e"),
  server(
    structuralServer("first", lifecycleEvents, serverTerminals),
    structuralServer("second", lifecycleEvents, serverTerminals)
  )
)
const appDone = app.run()
await microtaskCheckpoint()
const startOrder = lifecycleEvents.join(",")
ensure(
  startOrder === "start:first,start:second",
  `structural servers did not start in registration order: ${startOrder}`
)
scenarios.push("core-plain-structural-server-composition")
scenarioEvidence["core-plain-structural-server-composition"] = Object.freeze({
  startOrder
})
await app.stop()
await appDone
ensure(
  lifecycleEvents.join(",") === "start:first,start:second,stop:first,stop:second",
  `structural servers did not stop through App: ${lifecycleEvents.join(",")}`
)
scenarios.push("core-graceful-stop")
scenarioEvidence["core-graceful-stop"] = Object.freeze({
  startOrder,
  stopOrder: lifecycleEvents.slice(-2).join(","),
  serverDoneTerminals: serverTerminals.join(","),
  appDoneSettled: true
})

const probes = newProbeRegistry()
probes.register("live", "process", function liveProbe() {})
probes.register("ready", "database", function readinessProbe() {
  throw new Error("postgres://user:secret@database.internal/private")
})
const health = createHealthHandler(probes)
const liveResponse = await health(new Request("http://service.test/livez"))
ensure(liveResponse.status === 200, "liveness endpoint did not report success")
const liveBody = await liveResponse.text()
ensure(liveBody.includes('"status":"ok"'), "liveness payload was incorrect")
const readyResponse = await health(new Request("http://service.test/readyz"))
const readyBody = await readyResponse.text()
ensure(readyResponse.status === 503, "failed readiness endpoint did not report 503")
ensure(readyBody.includes('"name":"database"'), "readiness payload omitted the public probe name")
ensure(
  !readyBody.includes("secret") && !readyBody.includes("internal"),
  "readiness payload leaked failure data"
)
scenarios.push("health-readiness-failure-is-sanitized")
scenarioEvidence["health-readiness-failure-is-sanitized"] = Object.freeze({
  liveStatus: liveResponse.status,
  livePayloadStatusOk: liveBody.includes('"status":"ok"'),
  readyStatus: readyResponse.status,
  publicProbeNamePresent: readyBody.includes('"name":"database"'),
  secretLeaked: readyBody.includes("secret") || readyBody.includes("internal")
})

const headResponse = await health(new Request("http://service.test/readyz", { method: "HEAD" }))
const headBody = await headResponse.text()
ensure(headResponse.status === 503 && headBody === "", "HEAD metadata parity failed")
const methodResponse = await health(new Request("http://service.test/livez", { method: "POST" }))
ensure(
  methodResponse.status === 405 && methodResponse.headers.get("Allow") === "GET, HEAD",
  "health method gate failed"
)
const missingResponse = await health(new Request("http://service.test/missing"))
ensure(missingResponse.status === 404, "unknown health route did not report 404")
ensure(
  liveResponse.headers.get("Cache-Control") === "no-store" &&
    readyResponse.headers.get("Cache-Control") === "no-store",
  "health responses were cacheable"
)
scenarios.push("health-fetch-routing-head-and-cache-policy")
scenarioEvidence["health-fetch-routing-head-and-cache-policy"] = Object.freeze({
  headStatus: headResponse.status,
  readyStatus: readyResponse.status,
  headBodyEmpty: headBody === "",
  methodStatus: methodResponse.status,
  allowHeader: methodResponse.headers.get("Allow"),
  missingStatus: missingResponse.status,
  liveCacheControl: liveResponse.headers.get("Cache-Control"),
  readyCacheControl: readyResponse.headers.get("Cache-Control")
})

await microtaskCheckpoint()
const finalTimeouts = activeTimeouts()
ensure(
  finalTimeouts === baselineTimeouts,
  `native timeout resources leaked: ${baselineTimeouts}->${finalTimeouts}`
)

process.stdout.write(
  `LIKEGO_KERNEL_E2E_RESULT=${JSON.stringify({
    valid: true,
    package: "@likego/context,@likego/core,@likego/health,@likego/web",
    runtime: `bun-${Bun.version}`,
    scenarios,
    scenarioEvidence,
    cleanup: {
      baselineTimeouts,
      finalTimeouts,
      pendingTimers: finalTimeouts - baselineTimeouts,
      appCompleted: true
    }
  })}\n`
)
