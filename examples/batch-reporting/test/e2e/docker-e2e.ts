import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { newBullMqWorkerServer } from "@go-like/bullmq"
import { background, type Context } from "@go-like/context"
import type { Server } from "@go-like/core"
import { newCronerServer } from "@go-like/croner"
import { newFileStore } from "@go-like/store-file"
import { newNodeFileStoreHost } from "@go-like/store-file/node"
import { Queue, Worker, type Job, type Processor, type WorkerOptions } from "bullmq"
import { Cron } from "croner"

import { errorSummary, sanitizeArgv } from "../../../../e2e/harness/diagnostics"
import {
  closeOwnedDockerContext,
  createContainer,
  ownedDockerContextFromEnvironment,
  scenarioDockerEnvironment,
  type OwnedDockerContext
} from "../../../../e2e/harness/owned-docker"
import { readCheckpoint } from "../../src/checkpoint"
import { processReport, type ReportOutcome } from "../../src/processor"
import { reportWindow, type ReportJob } from "../../src/report-window"
import { enqueueNextClosedWindow } from "../../src/scheduler"

const RedisImage =
  "redis:8.10.0-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241"
const ExpectedRedisVersion = "8.10.0"
const FirstStart = Date.UTC(2026, 6, 21)
const SecondStart = Date.UTC(2026, 6, 22)

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface RunningServer {
  readonly server: Server
  readonly running: Promise<void>
}

/** Throws when one real-service invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Normalizes one cleanup rejection without hiding its original Error. */
function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

/** Runs one command without a shell and returns all output. */
async function command(
  ownedDocker: OwnedDockerContext,
  args: string[],
  allowFailure = false
): Promise<CommandResult> {
  const commandArgs = args.slice()
  const operation = sanitizeArgv(commandArgs).join(" ")
  let result: CommandResult
  try {
    const child = Bun.spawn(commandArgs, {
      env: scenarioDockerEnvironment(ownedDocker),
      stdout: "pipe",
      stderr: "pipe"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    result = Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode })
  } catch (value) {
    throw new Error(`${operation} failed: ${errorSummary(value)}`)
  }
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      `${operation} failed (${result.exitCode}): ${errorSummary(result.stderr || result.stdout)}`
    )
  }
  return result
}

/** Reserves and releases one random loopback port. */
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

/** Waits for one observable real-service condition. */
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

/** Reads one exact installed package version from package metadata. */
async function installedVersions(): Promise<{
  readonly bullmq: string
  readonly croner: string
}> {
  const bullmq: unknown = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.resolve("bullmq")), "utf8")
  )
  const croner: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.resolve("croner")), "utf8")
  )
  if (
    bullmq === null ||
    typeof bullmq !== "object" ||
    typeof Reflect.get(bullmq, "version") !== "string" ||
    croner === null ||
    typeof croner !== "object" ||
    typeof Reflect.get(croner, "version") !== "string"
  ) {
    throw new Error("installed package metadata is invalid")
  }
  return Object.freeze({
    bullmq: Reflect.get(bullmq, "version") as string,
    croner: Reflect.get(croner, "version") as string
  })
}

/** Waits for one BullMQ job state and performs a fresh second read. */
async function waitForJobState(
  queue: Queue<ReportJob, ReportOutcome, string>,
  jobId: string,
  expected: "active" | "completed"
): Promise<Job<ReportJob, ReportOutcome, string>> {
  let observed: Job<ReportJob, ReportOutcome, string> | null = null
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
    20_000
  ).catch(async (error: unknown) => {
    const job = await queue.getJob(jobId)
    const state = job === undefined ? "missing" : await job.getState()
    const detail =
      job === undefined
        ? ""
        : ` attemptsMade=${job.attemptsMade} attemptsStarted=${job.attemptsStarted} stalledCounter=${job.stalledCounter} failedReason=${job.failedReason}`
    throw new Error(`job ${jobId} remained ${state}.${detail}`, { cause: error })
  })
  if (observed === null) throw new Error(`job ${jobId} disappeared`)
  return observed
}

/** Crashes one independent raw Worker only after it owns the Redis job lock. */
async function crashRawWorker(
  ownedDocker: OwnedDockerContext,
  port: number,
  queueName: string,
  prefix: string,
  jobId: string
): Promise<number> {
  const child = Bun.spawn(
    ["bun", `${import.meta.dir}/stalled-child.ts`, "127.0.0.1", String(port), queueName, prefix],
    {
      env: scenarioDockerEnvironment(ownedDocker),
      stdout: "pipe",
      stderr: "pipe"
    }
  )
  const timeout = setTimeout(() => child.kill(), 10_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  clearTimeout(timeout)
  assert(exitCode === 17, `raw Worker exit was ${exitCode}: ${errorSummary(stderr)}`)
  assert(stdout.includes(`BATCH_STALLED_LOCKED=${jobId}`), "raw Worker never acquired the lock")
  return exitCode
}

/** Counts persistent connections after subtracting the transient redis-cli connection. */
async function persistentRedisConnections(
  ownedDocker: OwnedDockerContext,
  container: string
): Promise<number> {
  const result = await command(ownedDocker, [
    "docker",
    "exec",
    container,
    "redis-cli",
    "--raw",
    "CLIENT",
    "LIST"
  ])
  return Math.max(0, result.stdout.split("\n").filter((line) => line.length > 0).length - 1)
}

/** Starts one Server without joining its resident lifetime. */
function startServer(server: Server): RunningServer {
  const running = server.start(background())
  void running.catch(() => {})
  return Object.freeze({ server, running })
}

/** Waits for provider readiness while retaining startup failure. */
async function waitForServer(
  managed: RunningServer,
  label: string,
  ready: () => boolean | Promise<boolean>
): Promise<void> {
  await Promise.race([
    waitUntil(label, ready),
    managed.running.then(() => {
      throw new Error(`${label} stopped before becoming ready`)
    })
  ])
}

/** Stops one Server and joins the Promise returned by start. */
async function stopServer(managed: RunningServer): Promise<void> {
  await managed.server.stop(background())
  await managed.running
}

/** Runs the fixed-digest Redis reporting workflow. */
async function run(): Promise<void> {
  const container = `go-like-batch-redis-${crypto.randomUUID()}`
  const port = allocateHostPort()
  const queueName = `reports-${crypto.randomUUID()}`
  const prefix = `go-like-${crypto.randomUUID()}`
  const checkpointDirectory = await mkdtemp(join(tmpdir(), "go-like-batch-reporting-"))
  const cleanupErrors: Error[] = []
  const shutdownOrder: string[] = []

  let primary: Error | null = null
  let queue: Queue<ReportJob, ReportOutcome, string> | null = null
  let store: ReturnType<typeof newFileStore> | null = null
  let storeServer: RunningServer | null = null
  let cronServer: RunningServer | null = null
  let workerServer: RunningServer | null = null
  const cron: { value: Cron<Context> | null } = { value: null }
  let redisVersion = ""
  let redisImageId = ""
  let deterministicJobId = ""
  let duplicateTickWaitingJobs = 0
  const retryAttempts: number[] = []
  const retryTimes: number[] = []
  let firstCheckpoint = -1
  let rawWorkerExitCode = -1
  let stalledAttemptsStarted = -1
  let stalledCounter = -1
  let finalCheckpoint = -1
  let persistentAfterStop = -1

  const ownedDocker = await ownedDockerContextFromEnvironment(process.env)
  try {
    const versions = await installedVersions()
    assert(versions.bullmq === "6.0.6", `unexpected BullMQ ${versions.bullmq}`)
    assert(versions.croner === "10.0.1", `unexpected Croner ${versions.croner}`)
    await createContainer(ownedDocker, [
      "--name",
      container,
      "--publish",
      `127.0.0.1:${port}:6379`,
      RedisImage,
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no"
    ])
    redisVersion = (
      await command(ownedDocker, ["docker", "exec", container, "redis-server", "--version"])
    ).stdout
    assert(redisVersion.includes(`v=${ExpectedRedisVersion}`), `unexpected Redis: ${redisVersion}`)
    redisImageId = (
      await command(ownedDocker, ["docker", "inspect", "--format", "{{.Image}}", container])
    ).stdout
    const expectedImageId = (
      await command(ownedDocker, ["docker", "image", "inspect", "--format", "{{.Id}}", RedisImage])
    ).stdout
    assert(redisImageId === expectedImageId, "container did not use the pinned Redis image")

    const connection = {
      host: "127.0.0.1",
      port,
      protocol: 2 as const,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt: number) => Math.min(attempt * 50, 500)
    }
    queue = new Queue<ReportJob, ReportOutcome, string>(queueName, { connection, prefix })
    queue.on("error", () => {})
    await queue.waitUntilReady()

    store = newFileStore(newNodeFileStoreHost(), checkpointDirectory)
    storeServer = startServer(store)
    await waitForServer(storeServer, "File Store readiness", async () => {
      await store!.read(background(), "__go-like_e2e_readiness__")
      return true
    })
    let nowMs = Date.UTC(2026, 6, 22, 1)
    const enqueue = async (job: ReportJob, jobId: string): Promise<void> => {
      await queue!.add("daily-report", job, {
        jobId,
        attempts: 3,
        backoff: { type: "fixed", delay: 100 },
        removeOnComplete: false,
        removeOnFail: false
      })
    }
    const scheduler = newCronerServer<Context>((ctx) => {
      cron.value = new Cron<Context>(
        "0 0 0 1 1 * 2099",
        { paused: true, context: ctx, catch: true },
        async (_job, callbackCtx) => {
          await enqueueNextClosedWindow(callbackCtx, store!, enqueue, FirstStart, nowMs)
        }
      )
      return cron.value
    })
    cronServer = startServer(scheduler)
    await waitForServer(cronServer, "Croner readiness", () => cron.value !== null)
    const scheduledCron = cron.value
    assert(scheduledCron !== null, "Croner factory did not publish its native job")
    await scheduledCron.trigger()
    await scheduledCron.trigger()
    deterministicJobId = `report-${reportWindow(FirstStart).id}`
    duplicateTickWaitingJobs = (await queue.getJobs(["waiting"])).filter(
      (job) => job.id === deterministicJobId
    ).length
    assert(duplicateTickWaitingJobs === 1, "duplicate Cron ticks created parallel jobs")

    function createWorker(
      processor: Processor<ReportJob, ReportOutcome, string>,
      options: Omit<WorkerOptions, "connection" | "prefix" | "autorun"> = {}
    ): Worker<ReportJob, ReportOutcome, string> {
      const worker = new Worker<ReportJob, ReportOutcome, string>(queueName, processor, {
        ...options,
        connection,
        prefix,
        autorun: false
      })
      worker.on("error", () => {})
      return worker
    }

    const retryWorker = createWorker(
      async (job, _token, signal) => {
        retryAttempts.push(job.attemptsMade)
        retryTimes.push(Date.now())
        return await processReport(
          background(),
          store!,
          job.data,
          job.attemptsMade,
          async (_report, attempt, nativeSignal) => {
            assert(nativeSignal === signal, "processor did not retain BullMQ's native signal")
            if (attempt < 2) throw new Error(`transient report failure ${attempt}`)
          },
          signal
        )
      },
      { concurrency: 1, name: "batch-retry", stalledInterval: 250 }
    )
    workerServer = startServer(newBullMqWorkerServer(retryWorker))
    await waitForServer(workerServer, "retry Worker readiness", () => retryWorker.isRunning())
    const completedRetry = await waitForJobState(queue, deterministicJobId, "completed")
    assert(completedRetry.attemptsMade === 3, "BullMQ did not preserve all retry attempts")
    assert(retryAttempts.join(",") === "0,1,2", `unexpected attempts: ${retryAttempts}`)
    assert(retryTimes[1]! - retryTimes[0]! >= 90, "first native backoff was too short")
    assert(retryTimes[2]! - retryTimes[1]! >= 90, "second native backoff was too short")
    firstCheckpoint = (await readCheckpoint(background(), store)) ?? -1
    assert(firstCheckpoint === FirstStart, "checkpoint advanced before final retry success")
    await stopServer(workerServer)
    workerServer = null

    nowMs = Date.UTC(2026, 6, 23, 1)
    await scheduledCron.trigger()
    const stalledJobId = `report-${reportWindow(SecondStart).id}`
    rawWorkerExitCode = await crashRawWorker(ownedDocker, port, queueName, prefix, stalledJobId)
    await waitForJobState(queue, stalledJobId, "active")
    await Bun.sleep(750)

    const recovered: string[] = []
    const recoveryErrors: string[] = []
    const recoveryWorker = createWorker(
      async (job, _token, signal) => {
        return await processReport(
          background(),
          store!,
          job.data,
          job.attemptsMade,
          async (report, _attempt, nativeSignal) => {
            assert(nativeSignal === signal, "recovery lost BullMQ's native signal")
            recovered.push(report.window.id)
          },
          signal
        )
      },
      {
        concurrency: 1,
        name: "batch-stalled-recovery",
        lockDuration: 500,
        stalledInterval: 250,
        maxStalledCount: 2
      }
    )
    recoveryWorker.on("error", (error) => recoveryErrors.push(error.message))
    workerServer = startServer(newBullMqWorkerServer(recoveryWorker))
    await waitForServer(workerServer, "recovery Worker readiness", () => recoveryWorker.isRunning())
    const recoveredJob = await waitForJobState(queue, stalledJobId, "completed").catch(
      (error: unknown) => {
        throw new Error(`stalled recovery errors: ${recoveryErrors.join(" | ")}`, { cause: error })
      }
    )
    stalledAttemptsStarted = recoveredJob.attemptsStarted
    stalledCounter = recoveredJob.stalledCounter
    assert(recovered.includes(reportWindow(SecondStart).id), "recovery Worker did not publish")
    assert(stalledAttemptsStarted >= 2, "stalled job was not started twice")
    assert(stalledCounter >= 1, "stalled counter did not advance")
    finalCheckpoint = (await readCheckpoint(background(), store)) ?? -1
    assert(finalCheckpoint === SecondStart, "stalled recovery did not commit checkpoint")

    await stopServer(cronServer)
    cronServer = null
    shutdownOrder.push("scheduler")
    await stopServer(workerServer)
    workerServer = null
    shutdownOrder.push("worker")
    await queue.close()
    queue = null
    shutdownOrder.push("queue")
    await stopServer(storeServer)
    storeServer = null
    shutdownOrder.push("store")

    const reopened = newFileStore(newNodeFileStoreHost(), checkpointDirectory)
    const reopenedServer = startServer(reopened)
    try {
      await waitForServer(reopenedServer, "reopened File Store readiness", async () => {
        await reopened.read(background(), "__go-like_e2e_readiness__")
        return true
      })
      finalCheckpoint = (await readCheckpoint(background(), reopened)) ?? -1
      assert(finalCheckpoint === SecondStart, "fresh File Store readback lost the checkpoint")
    } finally {
      await stopServer(reopenedServer)
    }
    const program = Bun.spawn(["bun", "run", "start:prepared"], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...scenarioDockerEnvironment(ownedDocker),
        REDIS_URL: `redis://127.0.0.1:${port}`,
        CRON_SCHEDULE: "*/1 * * * * *",
        CHECKPOINT_DIR: join(checkpointDirectory, "program"),
        QUEUE_NAME: `entry-${crypto.randomUUID()}`,
        QUEUE_PREFIX: `entry-${crypto.randomUUID()}`
      },
      detached: true,
      stdout: "pipe",
      stderr: "pipe"
    })
    let programOutput = ""
    const outputTask = (async (): Promise<void> => {
      const reader = program.stdout.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        programOutput += decoder.decode(item.value, { stream: true })
      }
      programOutput += decoder.decode()
    })()
    const errorTask = new Response(program.stderr).text()
    let outputJoined = false
    let forced = false
    let terminationTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      try {
        await waitUntil(
          "start:prepared task publication",
          () =>
            programOutput.includes('GO_LIKE_EXAMPLE_READY={"example":"batch-reporting"') &&
            programOutput.includes("GO_LIKE_REPORT_PUBLISHED="),
          30_000
        )
      } catch (error) {
        throw new Error(`start:prepared failed: ${errorSummary(error)}`)
      }
      process.kill(-program.pid, "SIGTERM")
      terminationTimeout = setTimeout(() => {
        forced = true
        try {
          process.kill(-program.pid, "SIGKILL")
        } catch {
          // The process group can finish between the timeout and signal delivery.
        }
      }, 10_000)
      const exitCode = await program.exited
      await outputTask
      outputJoined = true
      clearTimeout(terminationTimeout)
      if (forced) throw new Error("start:prepared did not stop after SIGTERM")
      assert(
        exitCode === 0 || exitCode === 143,
        `start:prepared exited ${exitCode}: ${errorSummary(await errorTask)}`
      )
    } finally {
      if (terminationTimeout !== null) clearTimeout(terminationTimeout)
      if (!outputJoined) {
        try {
          process.kill(-program.pid, "SIGKILL")
        } catch {
          // The process group already exited.
        }
      }
      if (program.exitCode === null) {
        await program.exited
      }
      await outputTask
    }
    persistentAfterStop = await persistentRedisConnections(ownedDocker, container)
    assert(persistentAfterStop === 0, "start:prepared left persistent Redis connections")
  } catch (value) {
    primary = asError(value, "batch E2E failed with a non-Error value")
  } finally {
    for (const [name, managed] of [
      ["scheduler", cronServer],
      ["worker", workerServer],
      ["store", storeServer]
    ] as const) {
      if (managed === null) continue
      try {
        await stopServer(managed)
      } catch (value) {
        cleanupErrors.push(asError(value, `${name} cleanup failed`))
      }
    }
    if (queue !== null) {
      try {
        await queue.close()
      } catch (value) {
        cleanupErrors.push(asError(value, "Queue cleanup failed"))
      }
    }
    try {
      await closeOwnedDockerContext(ownedDocker)
    } catch (value) {
      cleanupErrors.push(asError(value, "Owned Docker context cleanup failed"))
    }
    try {
      await rm(checkpointDirectory, { recursive: true, force: true })
    } catch (value) {
      cleanupErrors.push(asError(value, "checkpoint directory cleanup failed"))
    }
  }
  if (primary !== null || cleanupErrors.length > 0) {
    const failures = primary === null ? cleanupErrors : [primary, ...cleanupErrors]
    throw failures.length === 1 ? failures[0]! : new AggregateError(failures, "batch E2E failed")
  }
}

await run()
