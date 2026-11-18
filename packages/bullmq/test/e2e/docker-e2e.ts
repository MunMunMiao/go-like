import { background } from "@go-like/core/context"
import { jobQueueConformance, jobTelemetryConformance } from "@go-like/core/testing"
import { Queue, type Job } from "bullmq"

import { newBullMqJobQueue } from "../../src/job/index"

const RedisImage =
  "redis:8.10.0-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241"
const ExpectedRedisVersion = "8.10.0"
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid GO_LIKE_E2E_OWNER")
}
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Throws when one real-service invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs one command without a shell and returns all output. */
async function command(args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`)
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
  const pending = Symbol("pending")
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const result = await Promise.race([
        Promise.resolve(predicate()),
        Bun.sleep(1_000).then(() => pending)
      ])
      if (result === true) return
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastError })
}

/** Waits for one BullMQ Job to reach a terminal state. The second read rejects a stale snapshot. */
async function waitForJob(
  queue: Queue,
  jobId: string,
  expected: "active" | "completed" | "failed",
  timeoutMs = 15_000
): Promise<Job> {
  let observed: Job | undefined
  await waitUntil(
    `job ${jobId} ${expected}`,
    async () => {
      const job = await queue.getJob(jobId)
      if (job === undefined || (await job.getState()) !== expected) return false
      const fresh = await queue.getJob(jobId)
      if (fresh === undefined || (await fresh.getState()) !== expected) return false
      observed = fresh
      return true
    },
    timeoutMs
  )
  if (observed === undefined) throw new Error(`job ${jobId} disappeared`)
  return observed
}

/** Observes one operation without letting its rejection escape, and fails when it stays pending. */
async function outcome(operation: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  return await Promise.race([
    operation.then(
      () => "resolved",
      (error: unknown) => error
    ),
    Bun.sleep(timeoutMs).then(() => "hung")
  ])
}

/** Counts Redis clients other than the redis-cli command that listed them. */
async function redisClients(container: string): Promise<number> {
  const listed = (
    await command(["docker", "exec", container, "redis-cli", "--raw", "CLIENT", "LIST"])
  ).stdout
  const lines = listed.split("\n").filter((line) => line.includes("id="))
  return Math.max(0, lines.length - 1)
}

/** Reports whether the adopted Queue client can run a command again. */
async function queueResponds(queue: Queue): Promise<boolean> {
  const backend = queue.getBackend() as unknown as {
    readonly client?: Promise<{ ping(): Promise<string> }>
  }
  const client = await Promise.race([
    backend.client ?? Promise.resolve(undefined),
    Bun.sleep(1_000).then(() => undefined)
  ])
  if (client === undefined) return false
  const pong = await Promise.race([client.ping(), Bun.sleep(1_000).then(() => "timeout")])
  return pong === "PONG"
}

/** Reports whether Redis answers again after a controlled stop. */
async function redisAcceptsCommands(container: string): Promise<boolean> {
  const child = Bun.spawn(["docker", "exec", container, "redis-cli", "PING"], {
    stdout: "pipe",
    stderr: "pipe"
  })
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return code === 0 && stdout.trim() === "PONG"
}

/** A single close failure keeps its Error. Several stay in one aggregate, primary first. */
function assertCloseOutcome(stopOutcome: unknown, runOutcome: unknown): void {
  assert(stopOutcome !== "hung", "worker stop did not settle")
  assert(runOutcome !== "hung", "worker runtime did not settle")
  if (stopOutcome === "resolved") {
    assert(runOutcome === "resolved", "worker runtime rejected after stop resolved")
    return
  }
  assert(stopOutcome instanceof Error, "worker stop rejected with a non-Error")
  if (stopOutcome instanceof AggregateError) {
    assert(stopOutcome.errors.length >= 2, "close aggregate did not keep every failure")
    assert(runOutcome instanceof AggregateError, "worker runtime lost the close aggregate")
    assert(runOutcome.errors[0] === stopOutcome.errors[0], "close aggregate primary changed")
    return
  }
  if (runOutcome instanceof AggregateError) {
    assert(runOutcome.errors[0] === stopOutcome, "primary close failure was not first")
    return
  }
  assert(runOutcome === stopOutcome, "single close failure changed Error identity")
}

/** Runs one raw Worker that exits after it locks a job. */
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
  assert(
    exitCode === 17,
    `raw Worker did not crash after lock acquisition: ${exitCode} ${stderr.trim()}`
  )
  assert(
    stdout.includes(`BULLMQ_STALLED_LOCKED=${expectedJobId}`),
    "raw Worker never acquired the stalled job lock"
  )
}

/** Leaves a timestamped phase in the suite log. */
function phase(label: string): void {
  console.log(`bullmq e2e ${label} +${Math.round(performance.now())}ms`)
}

/** Proves retry, connection cleanup, stalled recovery, outage, drain, and startup rollback. */
async function exerciseService(
  container: string,
  port: number,
  queue: Queue,
  jobs: ReturnType<typeof newBullMqJobQueue>,
  queueName: string,
  prefix: string
): Promise<void> {
  phase("retry")
  await waitUntil("worker close", async () => (await queue.getWorkersCount()) === 0)
  const baseline = await redisClients(container)
  const attempts: number[] = []
  const attemptTimes: number[] = []
  const retrying = jobs.worker(
    {
      work(_ctx, job) {
        attempts.push(job.attempt)
        attemptTimes.push(Date.now())
        if (job.attempt < 3) throw new Error(`retry-${job.attempt}`)
        return "retried"
      }
    },
    { concurrency: 1 }
  )
  const retryRunning = retrying.start(background())
  await waitUntil("retry worker", async () => (await queue.getWorkersCount()) >= 1)
  await jobs.enqueue(background(), "work", "retry", {
    id: "retry-backoff",
    attempts: 3,
    backoff: { type: "fixed", delayMs: 100 }
  })
  const retried = await waitForJob(queue, "retry-backoff", "completed")
  assert(attempts.length === 3, `expected three attempts, observed ${attempts.length}`)
  assert(retried.attemptsMade === 3, `unexpected attemptsMade: ${retried.attemptsMade}`)
  const firstGap = (attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0)
  const secondGap = (attemptTimes[2] ?? 0) - (attemptTimes[1] ?? 0)
  assert(firstGap >= 90, `first fixed backoff was too short: ${firstGap}`)
  assert(secondGap >= 90, `second fixed backoff was too short: ${secondGap}`)
  await retrying.stop(background())
  await retryRunning
  await waitUntil(
    "retry worker connections",
    async () => (await redisClients(container)) === baseline
  )
  const reusable = await queue.getJob("retry-backoff")
  assert(reusable !== undefined, "queue was unusable after worker stop")
  assert((await reusable.getState()) === "completed", "completed retry job changed state")

  phase("stalled")
  const stalledName = `${queueName}-stalled`
  const stalledNative = new Queue(stalledName, {
    prefix,
    connection: { host: "127.0.0.1", port, maxRetriesPerRequest: null }
  })
  stalledNative.on("error", () => {})
  try {
    const stalledJobs = newBullMqJobQueue(stalledNative, {
      worker: { lockDuration: 500, stalledInterval: 250, maxStalledCount: 2 }
    })
    await stalledJobs.start(background())
    await stalledJobs.enqueue(background(), "work", { recover: true }, { id: "real-stalled-lock" })
    await crashRawWorker("127.0.0.1", port, stalledName, prefix, "real-stalled-lock")
    await waitForJob(stalledNative, "real-stalled-lock", "active")
    const recovered: string[] = []
    const stalledWorker = stalledJobs.worker({
      work(_ctx, job) {
        recovered.push(job.id)
      }
    })
    const stalledRunning = stalledWorker.start(background())
    const completed = await waitForJob(stalledNative, "real-stalled-lock", "completed", 20_000)
    assert(recovered.includes("real-stalled-lock"), "stalled job was not recovered")
    assert(
      completed.attemptsStarted >= 2,
      `stalled job was not started twice: ${completed.attemptsStarted}`
    )
    assert(
      completed.stalledCounter >= 1,
      `stalled counter did not advance: ${completed.stalledCounter}`
    )
    await stalledWorker.stop(background())
    await stalledRunning
    await waitUntil(
      "stalled worker close",
      async () => (await stalledNative.getWorkersCount()) === 0
    )
    await stalledJobs.stop(background())
  } finally {
    await stalledNative.close().catch(() => {})
  }

  phase("processor")
  let releaseProcessor!: () => void
  const processorGate = new Promise<void>((resolve) => {
    releaseProcessor = resolve
  })
  let processorEntered = false
  const owned = jobs.worker(
    {
      async work() {
        processorEntered = true
        await processorGate
      }
    },
    { drainTimeoutMs: 10_000 }
  )
  const ownedRunning = owned.start(background())
  void ownedRunning.catch(() => {})
  try {
    await waitUntil("owned worker", async () => (await queue.getWorkersCount()) >= 1)
    await jobs.enqueue(background(), "work", "hold", { id: "held-processor" })
    await waitUntil("held processor", () => processorEntered)
    const stopping = owned.stop(background())
    const early = await outcome(stopping, 80)
    assert(early === "hung", "stop settled while the processor was still running")
    releaseProcessor()
    const stopped = await outcome(stopping, 10_000)
    const finished = await outcome(ownedRunning, 10_000)
    assertCloseOutcome(stopped, finished)
    await waitUntil("owned worker close", async () => (await queue.getWorkersCount()) === 0)
  } finally {
    releaseProcessor()
    await outcome(owned.stop(background()), 5_000)
    await outcome(ownedRunning, 5_000)
  }

  phase("outage")
  const outageSeen: string[] = []
  const outage = jobs.worker({
    work(_ctx, job) {
      outageSeen.push(job.id)
    }
  })
  const outageRunning = outage.start(background())
  void outageRunning.catch(() => {})
  try {
    await waitUntil("outage worker", async () => (await queue.getWorkersCount()) >= 1)
    await command(["docker", "stop", "--time", "1", container])
    await Bun.sleep(200)
    const duringOutage = await outcome(outageRunning, 100)
    assert(duringOutage === "hung", "Redis outage terminated the worker runtime")
    await command(["docker", "start", container])
    await waitUntil("redis reconnect", () => redisAcceptsCommands(container), 20_000)
    await waitUntil("queue reconnect", () => queueResponds(queue), 20_000)
    await jobs.enqueue(background(), "work", "recovered", { id: "after-outage" })
    await waitForJob(queue, "after-outage", "completed", 30_000)
    assert(outageSeen.includes("after-outage"), "worker did not process after Redis returned")
    const stillRunning = await outcome(outageRunning, 50)
    assert(stillRunning === "hung", "recovered worker runtime settled on its own")
    const outageStopped = await outcome(outage.stop(background()), 8_000)
    const outageFinished = await outcome(outageRunning, 8_000)
    assert(outageStopped === "resolved", "recovered worker stop did not resolve")
    assert(outageFinished === "resolved", "recovered worker runtime did not resolve")
    await waitUntil("outage worker close", async () => (await queue.getWorkersCount()) === 0)
    await waitUntil("outage connections", async () => (await redisClients(container)) === baseline)
  } finally {
    await command(["docker", "start", container]).catch(() => {})
    await outcome(outage.stop(background()), 5_000)
    await outcome(outageRunning, 5_000)
  }

  phase("drain")
  let releaseDrain!: () => void
  const drainGate = new Promise<void>((resolve) => {
    releaseDrain = resolve
  })
  let drainEntered = false
  const draining = jobs.worker(
    {
      async work() {
        drainEntered = true
        await drainGate
      }
    },
    { drainTimeoutMs: 200 }
  )
  const drainingRunning = draining.start(background())
  void drainingRunning.catch(() => {})
  try {
    await waitUntil("drain worker", async () => (await queue.getWorkersCount()) >= 1)
    await jobs.enqueue(background(), "work", "drain", { id: "drain-hold" })
    await waitUntil("drain handler", () => drainEntered)
    const stopOutcome = await outcome(draining.stop(background()), 2_000)
    assert(
      stopOutcome instanceof Error &&
        "code" in stopOutcome &&
        stopOutcome.code === "GO_LIKE_JOB_DRAIN_TIMEOUT",
      "drain stop did not keep the owner timeout"
    )
    const stillHeld = await outcome(drainingRunning, 50)
    assert(stillHeld === "hung", "drain timeout settled the handler before it finished")
    releaseDrain()
    const runOutcome = await outcome(drainingRunning, 5_000)
    assertCloseOutcome(stopOutcome, runOutcome)
    await waitUntil("drain worker close", async () => (await queue.getWorkersCount()) === 0)
  } finally {
    releaseDrain()
    await outcome(draining.stop(background()), 5_000)
    await outcome(drainingRunning, 5_000)
  }

  phase("startup")
  const refusedPort = allocateHostPort()
  const refused = new Queue(`refused-${crypto.randomUUID()}`, {
    prefix,
    connection: {
      host: "127.0.0.1",
      port: refusedPort,
      maxRetriesPerRequest: null,
      connectTimeout: 500,
      retryStrategy: () => null
    }
  })
  refused.on("error", () => {})
  try {
    const refusedJobs = newBullMqJobQueue(refused)
    const startup = refusedJobs.worker({ work() {} }, { drainTimeoutMs: 2_000 })
    const starting = startup.start(background())
    const startupError = await outcome(starting, 8_000)
    assert(startupError instanceof Error, "worker startup did not reject")
    if (startupError instanceof AggregateError) {
      assert(startupError.errors[0] instanceof Error, "startup aggregate lost its primary error")
      assert(
        startupError.message === startupError.errors[0].message,
        "startup aggregate did not keep the primary message"
      )
    }
    const stopped = await outcome(startup.stop(background()), 5_000)
    assert(
      stopped === "resolved" || stopped instanceof Error,
      "startup rollback stop did not settle"
    )
    const again = await outcome(startup.start(background()), 2_000)
    assert(
      again instanceof Error && "code" in again && again.code === "GO_LIKE_JOB_STATE",
      "failed worker start was left open"
    )
    const queueStart = await outcome(refusedJobs.start(background()), 8_000)
    assert(queueStart instanceof Error, "queue startup did not reject")
    assert(!(queueStart instanceof AggregateError), "queue startup replaced the connection error")
    const queueStopped = await outcome(refusedJobs.stop(background()), 2_000)
    assert(queueStopped === "resolved", "failed queue stop did not settle")
  } finally {
    await refused.close().catch(() => {})
  }
}

/** Runs one successful job and one permanent failure against Redis. */
async function main(): Promise<void> {
  const project = `go-like-bullmq-${crypto.randomUUID()}`
  const container = `${project}-redis`
  const port = allocateHostPort()
  const queueName = `jobs-${crypto.randomUUID()}`
  const prefix = `go-like-${crypto.randomUUID()}`
  let queue: Queue | null = null
  try {
    await command([
      "docker",
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      `go-like.project=${project}`,
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
    const redisVersion = (await command(["docker", "exec", container, "redis-server", "--version"]))
      .stdout
    assert(
      redisVersion.includes(`v=${ExpectedRedisVersion}`),
      `unexpected Redis version: ${redisVersion}`
    )
    queue = new Queue(queueName, {
      prefix,
      connection: { host: "127.0.0.1", port, maxRetriesPerRequest: null }
    })
    queue.on("error", () => {})
    const jobs = newBullMqJobQueue(queue)
    await jobs.start(background())
    const observedRedis = queue.getBackend().redisVersion
    assert(
      observedRedis === ExpectedRedisVersion,
      `unexpected backend Redis version: ${observedRedis}`
    )
    console.log(
      `redis version exercised: ${observedRedis} (LPOS script); no local Redis 5 image, LRANGE path covered by the unit suite`
    )
    let permanentRuns = 0
    const worker = jobs.worker(
      {
        work(_ctx, job) {
          if (job.payload === "undefined") throw undefined
          if (job.payload === "null") throw null
          if (job.payload === "text") throw "text"
          if (job.payload === "permanent") {
            permanentRuns += 1
            const error = new Error("permanent")
            Object.assign(error, { name: "JobPermanentError", code: "GO_LIKE_JOB_PERMANENT" })
            throw error
          }
          return job.payload
        }
      },
      { concurrency: 1 }
    )
    const running = worker.start(background())
    await waitUntil("worker", async () => (await queue!.getWorkersCount()) >= 1)
    const done = await jobs.enqueue(background(), "work", { n: 1 }, { id: "ok", attempts: 1 })
    const completed = await waitForJob(queue, done.id, "completed")
    assert((await completed.returnvalue) !== undefined, "completed job has no return value")
    const failed = await jobs.enqueue(background(), "work", "permanent", {
      id: "stop",
      attempts: 3
    })
    const terminal = await waitForJob(queue, failed.id, "failed")
    assert(
      terminal.attemptsMade === 1,
      `permanent job used a later attempt: attemptsMade=${terminal.attemptsMade} attemptsStarted=${terminal.attemptsStarted} handlerRuns=${permanentRuns} reason=${terminal.failedReason}`
    )
    assert(permanentRuns === 1, "permanent handler must execute exactly once")
    for (const payload of ["undefined", "null", "text"] as const) {
      const id = `primitive-${payload}`
      await jobs.enqueue(background(), "work", payload, { id, attempts: 2 })
      const primitive = await waitForJob(queue, id, "failed")
      assert(
        primitive.attemptsMade === 2,
        `${payload} was not retried to its attempt budget: attemptsMade=${primitive.attemptsMade}`
      )
    }
    await worker.stop(background())
    await running
    await exerciseService(container, port, queue, jobs, queueName, prefix)
    const other = new Queue(queueName, {
      prefix,
      connection: { host: "127.0.0.1", port, maxRetriesPerRequest: null }
    })
    const otherJobs = newBullMqJobQueue(other)
    await otherJobs.start(background())
    await Promise.all([
      jobs.enqueue(background(), "work", "A", { id: "ok" }),
      otherJobs.enqueue(background(), "work", "B", { id: "ok" })
    ])
    const survivor = await queue.getJob("ok")
    assert(survivor !== undefined, "replacement was deleted")
    const survivorPayload = survivor.data
    assert(
      survivorPayload === "A" || survivorPayload === "B",
      `replacement payload was lost: ${String(survivorPayload)}`
    )
    await jobs.enqueue(background(), "work", "C", { id: "ok" })
    const still = await queue.getJob("ok")
    assert(still?.data === survivorPayload, "unfinished replacement was overwritten")
    await otherJobs.stop(background())
    await other.close()
    const opened: Queue[] = []
    const suite = {
      async newQueue() {
        const native = new Queue(`${queueName}-${opened.length}`, {
          prefix,
          connection: { host: "127.0.0.1", port, maxRetriesPerRequest: null }
        })
        opened.push(native)
        const wrapped = newBullMqJobQueue<{ readonly n: number }>(native)
        await wrapped.start(background())
        return wrapped
      },
      async close() {
        const native = opened.pop()
        if (native === undefined) return
        await native.close()
      }
    }
    for (const entry of [
      ...jobQueueConformance(suite),
      ...jobTelemetryConformance({ queue: suite })
    ]) {
      await entry.run()
    }
    await jobs.stop(background())
    queue = null
  } finally {
    if (queue !== null) await queue.close().catch(() => {})
    await command(["docker", "rm", "--force", container]).catch(() => {})
  }
}

await main()
