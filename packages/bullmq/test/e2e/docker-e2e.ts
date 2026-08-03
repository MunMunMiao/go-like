import { readFile } from "node:fs/promises"

import { background, type Context } from "@likego/context"
import {
  newApp,
  server as registerServer,
  stopTimeout as appStopTimeout,
  type Server
} from "@likego/core"
import { Queue, Worker, type Job, type Processor, type WorkerOptions } from "bullmq"

import { bullMqWorkerShutdownTimeout, newBullMqWorkerServer } from "../../src/index"
import { outageErrorDelta } from "../outage-observation"

const RedisImage =
  "redis:8.10.0-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241"
const ExpectedRedisVersion = "8.10.0"
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid LIKEGO_E2E_OWNER")
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface ManagedWorker {
  readonly server: ReturnType<typeof newBullMqWorkerServer>
  readonly running: Promise<void>
}

interface RedisCommandClient {
  call(command: string, ...args: string[]): Promise<unknown>
  ping(): Promise<string>
}

/** Reads one exact installed package version from validated JSON metadata. */
async function installedBullMqVersion(): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.resolve("bullmq")), "utf8")
  )
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("BullMQ package metadata has no string version")
  }
  return value.version
}

/** Creates one externally controlled E2E synchronization point. */
function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return Object.freeze({ promise, resolve: resolvePromise })
}

/** Throws when one real-service invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Returns one required Error without relying on callback-side control-flow narrowing. */
function requiredError(value: unknown, message: string): Error {
  if (!(value instanceof Error)) throw new Error(message)
  return value
}

/** Finds one nested Error carrying a stable lifecycle code. */
function errorWithCode(value: unknown, code: string): Error | null {
  if (!(value instanceof Error)) return null
  if (Reflect.get(value, "code") === code) return value
  if (value instanceof AggregateError) {
    for (const nested of value.errors) {
      const found = errorWithCode(nested, code)
      if (found !== null) return found
    }
  }
  return errorWithCode(value.cause, code)
}

/** Narrows BullMQ's Redis client union to the commands used by this E2E. */
function redisCommandClient(value: unknown): value is RedisCommandClient {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, "call") === "function" &&
    typeof Reflect.get(value, "ping") === "function"
  )
}

/** Returns the Queue client after validating the real command surface. */
async function queueClient(queue: Queue): Promise<RedisCommandClient> {
  const client: unknown = await queue.getBackend().client
  if (!redisCommandClient(client))
    throw new Error("BullMQ Queue client has no Redis command surface")
  return client
}

/** Runs one command without a shell and captures its complete result. */
async function command(args: string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`)
  }
  return Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode })
}

/** Reserves a loopback port for the fixed-digest Docker container. */
function allocateHostPort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 })
  })
  const port = reservation.port
  reservation.stop(true)
  if (port === undefined) throw new Error("Bun did not allocate a loopback port")
  return port
}

/** Waits until one observable real-service condition becomes true. */
async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastError })
}

/** Returns one expected Error rejection and rejects false-positive success. */
async function rejected(operation: Promise<void>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error("operation rejected with a non-Error value", { cause: error })
  }
  throw new Error("operation unexpectedly resolved")
}

/** Reports whether one terminal operation settles inside a test-only interval. */
async function settlesWithin(operation: Promise<unknown>, timeoutMs = 25): Promise<boolean> {
  return await Promise.race([
    operation.then(
      () => true,
      () => true
    ),
    Bun.sleep(timeoutMs).then(() => false)
  ])
}

/** Counts persistent Redis clients through the application's raw Queue client. */
async function queueConnectionCount(queue: Queue): Promise<number> {
  const client = await queueClient(queue)
  const value = await client.call("CLIENT", "LIST")
  if (typeof value !== "string") throw new Error("Redis CLIENT LIST returned a non-string value")
  return value.split("\n").filter((line) => line.length > 0).length
}

/** Waits for one BullMQ Job to reach a terminal or requested state. */
async function waitForJobState(
  queue: Queue,
  jobId: string,
  expected: "active" | "completed" | "failed" | "waiting",
  timeoutMs = 15_000
): Promise<Job> {
  let observed: Job | null = null
  await waitUntil(
    `job ${jobId} state ${expected}`,
    async () => {
      const first = await queue.getJob(jobId)
      if (first === undefined || (await first.getState()) !== expected) return false
      const fresh = await queue.getJob(jobId)
      if (fresh === undefined || (await fresh.getState()) !== expected) return false
      observed = fresh
      return true
    },
    timeoutMs
  )
  if (observed === null) throw new Error(`job ${jobId} disappeared`)
  return observed
}

/** Starts one managed Worker and tracks its Server runtime for cleanup. */
async function startManaged(
  worker: Worker,
  managedWorkers: Set<ManagedWorker>,
  ...options: ReturnType<typeof bullMqWorkerShutdownTimeout>[]
): Promise<ManagedWorker> {
  const server = newBullMqWorkerServer(worker, ...options)
  const running = server.start(background())
  void running.catch(() => {})
  await waitUntil(`Worker ${worker.name} run`, () => worker.isRunning())
  const managed = Object.freeze({ server, running })
  managedWorkers.add(managed)
  return managed
}

/** Stops one managed Worker and removes it from cleanup tracking. */
async function stopManaged(
  managed: ManagedWorker,
  managedWorkers: Set<ManagedWorker>
): Promise<void> {
  await managed.server.stop(background())
  await managed.running
  managedWorkers.delete(managed)
}

/** Runs one independent raw Worker process that exits after obtaining the job lock. */
async function crashRawWorker(
  host: string,
  port: number,
  queueName: string,
  prefix: string,
  expectedJobId: string
): Promise<void> {
  const child = Bun.spawn(
    ["bun", `${import.meta.dir}/stalled-child.ts`, host, String(port), queueName, prefix],
    { stdout: "pipe", stderr: "pipe" }
  )
  const timeout = setTimeout(() => {
    child.kill()
  }, 10_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  clearTimeout(timeout)
  assert(exitCode === 17, `raw Worker did not crash after lock acquisition: ${exitCode} ${stderr}`)
  assert(
    stdout.includes(`BULLMQ_STALLED_LOCKED=${expectedJobId}`),
    "raw Worker never acquired the stalled job lock"
  )
}

/** Counts container connections after subtracting the transient redis-cli connection. */
async function persistentContainerConnections(container: string): Promise<number> {
  const result = await command([
    "docker",
    "exec",
    container,
    "redis-cli",
    "--raw",
    "CLIENT",
    "LIST"
  ])
  const lines = result.stdout.split("\n").filter((line) => line.length > 0)
  return Math.max(0, lines.length - 1)
}

/** Executes the fixed-digest Redis 8.10.0 release gate. */
async function main(): Promise<void> {
  const project = `likego-bullmq-${crypto.randomUUID()}`
  const container = `${project}-redis`
  const label = `likego.project=${project}`
  const port = allocateHostPort()
  const queueName = `jobs-${crypto.randomUUID()}`
  const prefix = `likego-${crypto.randomUUID()}`
  const managedWorkers = new Set<ManagedWorker>()
  const workers = new Set<Worker>()
  const lateRejections: unknown[] = []
  let queue: Queue | null = null
  let imageId = ""
  let redisVersion = ""
  const bullmqVersion = await installedBullMqVersion()
  assert(bullmqVersion === "6.0.6", `unexpected BullMQ version: ${bullmqVersion}`)

  /** Records process-level late rejections as release-gate failures. */
  const recordLateRejection = (reason: unknown): void => {
    lateRejections.push(reason)
  }
  process.on("unhandledRejection", recordLateRejection)

  try {
    await command([
      "docker",
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      label,
      "--label",
      DockerOwnerLabel,
      "--publish",
      `127.0.0.1:${port}:6379`,
      RedisImage,
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no"
    ])
    redisVersion = (await command(["docker", "exec", container, "redis-server", "--version"]))
      .stdout
    assert(
      redisVersion.includes(`v=${ExpectedRedisVersion}`),
      `unexpected Redis version: ${redisVersion}`
    )
    imageId = (await command(["docker", "inspect", "--format", "{{.Image}}", container])).stdout

    const connection = {
      host: "127.0.0.1",
      port,
      protocol: 2 as const,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt: number) => Math.min(attempt * 50, 500)
    }
    /** Creates one application-configured official Worker with its native data plane intact. */
    function createWorker(
      processor: Processor,
      options: Omit<WorkerOptions, "connection" | "prefix" | "autorun"> = {}
    ): Worker {
      const native = new Worker(
        queueName,
        processor,
        Object.assign({}, options, {
          connection,
          prefix,
          autorun: false
        })
      )
      native.on("error", () => {})
      workers.add(native)
      return native
    }
    queue = new Queue(queueName, { connection, prefix })
    queue.on("error", () => {})
    await queue.waitUntilReady()
    await queue.drain(true)
    const baselineConnections = await queueConnectionCount(queue)
    assert(
      baselineConnections === 1,
      `unexpected application Queue baseline: ${baselineConnections}`
    )

    const attempts: number[] = []
    const attemptTimes: number[] = []
    const nativeTokens: string[] = []
    let nativeSignalObserved = false
    const retryWorker = createWorker(
      async (job, token, signal) => {
        attempts.push(job.attemptsMade)
        attemptTimes.push(Date.now())
        assert(
          typeof token === "string" && token.length > 0,
          "retry processor received an empty native token"
        )
        nativeTokens.push(token)
        nativeSignalObserved = signal instanceof AbortSignal
        if (attempts.length < 3) throw new Error(`retry-${attempts.length}`)
        return { delivered: true }
      },
      { concurrency: 2, name: "retry-application" }
    )
    const retryManaged = await startManaged(retryWorker, managedWorkers)
    const retryJob = await queue.add(
      "retry",
      { id: 1 },
      {
        jobId: "retry-backoff",
        attempts: 3,
        backoff: { type: "fixed", delay: 100 }
      }
    )
    const completedRetry = await waitForJobState(queue, retryJob.id ?? "", "completed")
    assert(attempts.length === 3, `expected three processor attempts, observed ${attempts.length}`)
    assert(
      completedRetry.attemptsMade === 3,
      `unexpected attemptsMade: ${completedRetry.attemptsMade}`
    )
    assert(
      nativeTokens.every((token) => token.length > 0),
      "retry processor did not retain native tokens"
    )
    assert(nativeSignalObserved, "retry processor did not receive BullMQ native AbortSignal")
    const firstFixedBackoffElapsedMs = attemptTimes[1]! - attemptTimes[0]!
    const secondFixedBackoffElapsedMs = attemptTimes[2]! - attemptTimes[1]!
    assert(
      firstFixedBackoffElapsedMs >= 90,
      `first fixed backoff was too short: ${firstFixedBackoffElapsedMs}`
    )
    assert(
      secondFixedBackoffElapsedMs >= 90,
      `second fixed backoff was too short: ${secondFixedBackoffElapsedMs}`
    )
    await stopManaged(retryManaged, managedWorkers)
    await waitUntil("retry Worker connections to return to baseline", async () => {
      return queue !== null && (await queueConnectionCount(queue)) === baselineConnections
    })
    const retryConnectionsAfterStop = await queueConnectionCount(queue)
    assert(
      retryConnectionsAfterStop === baselineConnections,
      "retry Worker connections did not return to baseline"
    )
    const postStopJob = await queue.add(
      "post-stop",
      { usable: true },
      { jobId: "queue-remains-owned" }
    )
    const queriedPostStop = await queue.getJob(postStopJob.id ?? "")
    assert(
      queriedPostStop?.data.usable === true,
      "application Queue was unusable after Worker stop"
    )
    await postStopJob.remove()

    const outageErrors: Error[] = []
    const recoveredJobs: string[] = []
    let outageFactoryCalls = 0
    const outageWorkerCreated = deferred<Worker>()
    const outageServer = newBullMqWorkerServer(() => {
      outageFactoryCalls += 1
      const native = createWorker(
        async (job, _token, _signal) => {
          recoveredJobs.push(job.id ?? "")
        },
        { name: "outage-application" }
      )
      native.on("error", (error) => {
        outageErrors.push(error)
      })
      outageWorkerCreated.resolve(native)
      return native
    })
    const outageRunning = outageServer.start(background())
    void outageRunning.catch(() => {})
    const outageManaged = Object.freeze({ server: outageServer, running: outageRunning })
    managedWorkers.add(outageManaged)
    const outageWorker = await outageWorkerCreated.promise
    assert(
      outageFactoryCalls === 1,
      `expected one application Worker factory call, observed ${outageFactoryCalls}`
    )
    await waitUntil("outage Worker run", () => outageWorker.isRunning())
    await waitUntil("outage Worker initial connections", async () => {
      return queue !== null && (await queueConnectionCount(queue)) === baselineConnections + 2
    })
    assert(outageErrors.length === 0, "Worker emitted an error before the controlled Redis outage")
    const outageErrorBaseline = outageErrors.length
    await command(["docker", "stop", "--time", "1", container])
    await waitUntil(
      "Worker outage error observation",
      () => outageErrorDelta(outageErrors, outageErrorBaseline) > 0,
      30_000
    )
    const outageErrorsObservedWhileStopped = outageErrorDelta(outageErrors, outageErrorBaseline)
    assert(
      outageErrorsObservedWhileStopped > 0,
      "Worker emitted no new error while Redis was stopped"
    )
    await command(["docker", "start", container])
    await waitUntil(
      "Queue Redis reconnect",
      async () => {
        if (queue === null) return false
        const client = await queueClient(queue)
        return (await client.ping()) === "PONG"
      },
      30_000
    )
    await waitUntil(
      "outage Worker recovered connections",
      async () => {
        return queue !== null && (await queueConnectionCount(queue)) === baselineConnections + 2
      },
      60_000
    )
    const recoveredJob = await queue.add("outage", { recovered: true }, { jobId: "after-outage" })
    await waitForJobState(queue, recoveredJob.id ?? "", "completed", 60_000)
    assert(recoveredJobs.includes("after-outage"), "Worker did not process after Redis restart")
    let outageTerminal = false
    void outageRunning.then(
      () => {
        outageTerminal = true
      },
      () => {
        outageTerminal = true
      }
    )
    await Bun.sleep(25)
    assert(!outageTerminal, "Redis outage incorrectly terminated the Worker server")
    await stopManaged(outageManaged, managedWorkers)
    await waitUntil("recovered Worker connections to return to baseline", async () => {
      return queue !== null && (await queueConnectionCount(queue)) === baselineConnections
    })
    const stalledJob = await queue.add("stalled", { recover: true }, { jobId: "real-stalled-lock" })
    await crashRawWorker("127.0.0.1", port, queueName, prefix, stalledJob.id ?? "")
    await waitForJobState(queue, stalledJob.id ?? "", "active")
    const recoveredStalled: string[] = []
    const stalledWorker = createWorker(
      async (job, _token, _signal) => {
        recoveredStalled.push(job.id ?? "")
      },
      {
        name: "stalled-application",
        lockDuration: 500,
        stalledInterval: 250,
        maxStalledCount: 2
      }
    )
    const stalledManaged = await startManaged(stalledWorker, managedWorkers)
    const completedStalled = await waitForJobState(queue, stalledJob.id ?? "", "completed", 15_000)
    assert(
      recoveredStalled.includes("real-stalled-lock"),
      "application-configured Worker did not recover the raw crashed lock"
    )
    assert(
      completedStalled.attemptsStarted >= 2,
      `stalled job was not started twice: ${completedStalled.attemptsStarted}`
    )
    assert(
      completedStalled.stalledCounter >= 1,
      `stalled counter did not advance: ${completedStalled.stalledCounter}`
    )
    await stopManaged(stalledManaged, managedWorkers)
    await waitUntil("stalled Worker connections to return to baseline", async () => {
      return queue !== null && (await queueConnectionCount(queue)) === baselineConnections
    })

    const admitted = deferred<void>()
    const releaseProcessor = deferred<void>()
    let forcedSignalCanceled = false
    let forcedSignalCause: Error | null = null
    const forceWorker = createWorker(
      async (_job, token, signal) => {
        assert(
          typeof token === "string" && token.length > 0,
          "noncooperative processor received an empty native token"
        )
        assert(
          signal !== undefined,
          "noncooperative processor did not receive BullMQ native signal"
        )
        signal.addEventListener(
          "abort",
          () => {
            forcedSignalCanceled = true
            forcedSignalCause =
              signal.reason instanceof Error
                ? signal.reason
                : new Error("native BullMQ signal used a non-Error reason", {
                    cause: signal.reason
                  })
          },
          { once: true }
        )
        admitted.resolve()
        await releaseProcessor.promise
      },
      { name: "force-application" }
    )
    const noncooperative = newBullMqWorkerServer(forceWorker, bullMqWorkerShutdownTimeout(100))
    let forcedRunning: Promise<void> | null = null
    const capturedServer: Server = {
      start(ctx: Context): Promise<void> {
        const running = noncooperative.start(ctx)
        forcedRunning = running
        void running.catch(() => {})
        return running
      },
      stop(ctx: Context): Promise<void> {
        return noncooperative.stop(ctx)
      }
    }
    const app = newApp(registerServer(capturedServer), appStopTimeout(300))
    const appRunning = app.run()
    void appRunning.catch(() => {})
    await queue.add("force", { hold: true }, { jobId: "noncooperative-force" })
    await admitted.promise
    const forceFailure = await rejected(app.stop())
    assert(forcedSignalCanceled, "cancelAllJobs did not cancel the official processor signal")
    requiredError(
      forcedSignalCause,
      "forced native processor signal did not retain an Error reason"
    )
    assert(forcedRunning !== null, "App did not start the BullMQ Server runtime")
    const acceptedForcedRunning: Promise<void> = forcedRunning
    assert(
      !(await settlesWithin(acceptedForcedRunning)),
      "Server runtime settled before the admitted processor released"
    )
    const adapterTimeout = errorWithCode(forceFailure, "LIKEGO_BULLMQ_WORKER_SHUTDOWN_TIMEOUT")
    assert(adapterTimeout instanceof Error, "App failure lost the BullMQ owner timeout")
    releaseProcessor.resolve()
    const terminalFailure = await rejected(acceptedForcedRunning)
    assert(
      terminalFailure === adapterTimeout,
      "native terminal changed the BullMQ timeout Error identity"
    )
    await waitUntil("forced Worker connections to return to baseline", async () => {
      return queue !== null && (await queueConnectionCount(queue)) === baselineConnections
    })
    await rejected(appRunning)

    const finalJob = await queue.add(
      "after-all-workers",
      { queryable: true },
      { jobId: "queue-final-use" }
    )
    const finalQuery = await queue.getJob(finalJob.id ?? "")
    assert(finalQuery?.data.queryable === true, "lifecycle adapter closed the application Queue")
    await queue.obliterate({ force: true })
    let connectionsBeforeQueueClose = await queueConnectionCount(queue)
    try {
      await waitUntil("private Worker connections before Queue close", async () => {
        if (queue === null) return false
        connectionsBeforeQueueClose = await queueConnectionCount(queue)
        return connectionsBeforeQueueClose === baselineConnections
      })
    } catch (error) {
      const clientList = String(await (await queueClient(queue)).call("CLIENT", "LIST"))
      throw new Error(
        `private Worker connection count was ${connectionsBeforeQueueClose}; expected ${baselineConnections}; clients=${clientList}`,
        { cause: error }
      )
    }
    await queue.close()
    queue = null
    await waitUntil("zero persistent Redis clients", async () => {
      return (await persistentContainerConnections(container)) === 0
    })
    await Bun.sleep(50)
    assert(lateRejections.length === 0, `observed ${lateRejections.length} late rejection(s)`)
  } finally {
    for (const managed of managedWorkers) {
      try {
        await managed.server.stop(background())
        await managed.running
      } catch {
        continue
      }
    }
    for (const worker of workers) {
      try {
        await worker.close(true)
      } catch {
        continue
      }
    }
    if (queue !== null) {
      try {
        await queue.close()
      } catch {
        // Final cleanup must continue to container removal.
      }
    }
    await command(["docker", "rm", "--force", container], true)
    process.off("unhandledRejection", recordLateRejection)
  }

  const remaining = await command([
    "docker",
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=${label}`
  ])
  assert(remaining.stdout.length === 0, `project containers remain: ${remaining.stdout}`)
  assert(
    lateRejections.length === 0,
    `observed ${lateRejections.length} late rejection(s) after cleanup`
  )
}

await main()
