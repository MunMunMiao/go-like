import { SQL } from "bun"

import { background } from "@go-like/context"
import {
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type JetStreamClient
} from "@nats-io/jetstream"
import { connect, type NatsConnection, type Status } from "@nats-io/transport-node"

import { errorSummary } from "../../../e2e/harness/diagnostics"
import {
  closeOwnedDockerContext,
  createContainer,
  createVolume,
  ownedDockerContextFromEnvironment,
  scenarioDockerEnvironment,
  type OwnedDockerContext
} from "../../../e2e/harness/owned-docker"
import { newPaymentHandler } from "../src/http"
import { publishNextOutbox } from "../src/nats"
import { paymentStream, paymentSubject } from "../src/payment"
import { postPayment } from "../src/post-payment"
import { createLedgerAccount, migrateLedger } from "../src/postgres"

const PostgresImage =
  "docker.io/library/postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"
const NatsImage =
  "docker.io/library/nats:2.14.4-alpine@sha256:f2123f533c2b0cada0a5c5ec434fb2b8cfe1cf220215ef9d7517e1372917ad66"
const ExpectedPostgresVersion = "18.4"
const ExpectedNatsVersion = "2.14.4"
const DockerKnownSecrets = Object.freeze(["local-e2e-only"])
const RunId = crypto.randomUUID()
const PostgresContainer = `go-like-payments-postgres-${RunId}`
const NatsContainer = `go-like-payments-nats-${RunId}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface ReadbackCount {
  readonly value: number
}

interface ReadbackText {
  readonly value: string
}

/** Throws when one real-service invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs Docker without a shell and captures the complete result. */
async function docker(
  ownedDocker: OwnedDockerContext,
  args: readonly string[],
  allowFailure = false
): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], {
    env: scenarioDockerEnvironment(ownedDocker),
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  const result = Object.freeze({
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode
  })
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`Docker operation failed with exit code ${exitCode}`)
  }
  return result
}

/** Produces one bounded diagnostic without retaining raw secrets or stacks. */
function safeErrorSummary(error: unknown): string {
  return errorSummary(error, { knownSecrets: DockerKnownSecrets }, 1_024)
}

/** Wraps a failure without retaining its raw cause. */
function safeFailure(summary: string, error: unknown): Error {
  const diagnostic = safeErrorSummary(error)
  return new Error(diagnostic.length === 0 ? summary : `${summary}: ${diagnostic}`)
}

/** Reserves two distinct loopback ports so Docker restart cannot change their mapping. */
function allocateHostPorts(): readonly [number, number] {
  const postgres = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 })
  })
  const nats = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 })
  })
  const postgresPort = postgres.port
  const natsPort = nats.port
  postgres.stop(true)
  nats.stop(true)
  assert(postgresPort !== undefined && natsPort !== undefined, "Bun did not allocate host ports")
  return [postgresPort, natsPort]
}

/** Waits for a bounded observable real-service condition. */
async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      // A container can publish its port before the service accepts traffic.
    }
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Creates a direct Bun PostgreSQL client and confirms it can run a query. */
async function connectPostgres(port: number): Promise<SQL> {
  let lastError: unknown = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const sql = new SQL({
      adapter: "postgres",
      hostname: "127.0.0.1",
      port,
      username: "go-like",
      password: "local-e2e-only",
      database: "ledger",
      tls: false,
      max: 8
    })
    try {
      await sql.connect()
      await sql`SELECT 1`
      return sql
    } catch (error) {
      lastError = error
      await sql.close({ timeout: 0 }).catch(() => {})
      await Bun.sleep(50)
    }
  }
  throw new Error(
    `PostgreSQL container never accepted a stable TCP connection: ${safeErrorSummary(lastError)}`
  )
}

/** Opens an official reconnecting NATS connection after the container is ready. */
async function connectNats(port: number): Promise<NatsConnection> {
  let lastError: unknown = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      return await connect({
        servers: `nats://127.0.0.1:${port}`,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
        reconnectJitter: 0,
        timeout: 1_000
      })
    } catch (error) {
      lastError = error
      await Bun.sleep(50)
    }
  }
  throw new Error(
    `NATS container never accepted an official client connection: ${safeErrorSummary(lastError)}`
  )
}

/** Closes one application-owned official connection. */
async function closeNats(connection: NatsConnection | null): Promise<void> {
  if (connection === null || connection.isClosed()) return
  try {
    await connection.drain()
  } catch {
    await connection.close()
  }
}

/** Executes the PostgreSQL journal and JetStream outbox real-service contract. */
export async function main(): Promise<void> {
  const ownedDocker = await ownedDockerContextFromEnvironment(process.env)
  let sql: SQL | null = null
  let connection: NatsConnection | null = null
  let statusTask: Promise<void> | null = null
  let primary: unknown | null = null
  const cleanupFailures: unknown[] = []
  const statuses: Status["type"][] = []
  let postgresVersion = "unobserved"
  let natsVersion = "unobserved"
  let postgresImageId = "unobserved"
  let natsImageId = "unobserved"
  let constraintCode = "unobserved"
  let outageError = "unobserved"
  let drainDurationMs = -1
  let persistent = false
  let phase = "startup"

  try {
    phase = "create Docker resources"
    const [postgresPort, natsPort] = allocateHostPorts()
    const postgresVolume = await createVolume(ownedDocker, [], {
      knownSecrets: DockerKnownSecrets
    })
    const natsVolume = await createVolume(ownedDocker, [], {
      knownSecrets: DockerKnownSecrets
    })
    await createContainer(
      ownedDocker,
      [
        "--name",
        PostgresContainer,
        "--publish",
        `127.0.0.1:${postgresPort}:5432`,
        "--mount",
        `source=${postgresVolume.id},target=/var/lib/postgresql`,
        "--env",
        "POSTGRES_USER=go-like",
        "--env",
        "POSTGRES_PASSWORD=local-e2e-only",
        "--env",
        "POSTGRES_DB=ledger",
        PostgresImage
      ],
      { knownSecrets: DockerKnownSecrets }
    )
    await createContainer(
      ownedDocker,
      [
        "--name",
        NatsContainer,
        "--publish",
        `127.0.0.1:${natsPort}:4222`,
        "--mount",
        `source=${natsVolume.id},target=/data`,
        NatsImage,
        "-js",
        "-sd",
        "/data"
      ],
      { knownSecrets: DockerKnownSecrets }
    )

    phase = "connect real services"
    await waitUntil("PostgreSQL readiness", async () => {
      const ready = await docker(
        ownedDocker,
        [
          "exec",
          PostgresContainer,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "go-like",
          "-d",
          "ledger"
        ],
        true
      )
      return ready.exitCode === 0
    })
    sql = await connectPostgres(postgresPort)
    connection = await connectNats(natsPort)
    statusTask = (async () => {
      if (connection === null) return
      for await (const status of connection.status()) statuses.push(status.type)
    })()
    void statusTask.catch(() => {})

    phase = "read service versions"
    const versionRow = (await sql<ReadbackText[]>`SELECT version() AS value`)[0]
    assert(versionRow !== undefined, "PostgreSQL version readback was empty")
    postgresVersion = versionRow.value
    natsVersion = (await docker(ownedDocker, ["exec", NatsContainer, "nats-server", "--version"]))
      .stdout
    postgresImageId = (
      await docker(ownedDocker, ["inspect", "--format", "{{.Image}}", PostgresContainer])
    ).stdout
    natsImageId = (await docker(ownedDocker, ["inspect", "--format", "{{.Image}}", NatsContainer]))
      .stdout
    assert(
      postgresVersion.includes(ExpectedPostgresVersion),
      `unexpected PostgreSQL: ${postgresVersion}`
    )
    assert(natsVersion.includes(ExpectedNatsVersion), `unexpected NATS: ${natsVersion}`)

    phase = "migrate and seed ledger"
    await migrateLedger(sql)
    await createLedgerAccount(sql, {
      tenantId: "tenant_acme",
      accountId: "account_customer_1",
      currency: "USD"
    })
    await createLedgerAccount(sql, {
      tenantId: "tenant_acme",
      accountId: "account_merchant_1",
      currency: "USD"
    })

    phase = "create payment stream"
    const manager = await jetstreamManager(connection)
    await manager.streams.add({
      name: paymentStream,
      subjects: [paymentSubject],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File
    })
    const streamConfig = await manager.streams.info(paymentStream)
    assert(streamConfig.config.storage === StorageType.File, "payment stream is not file-backed")

    phase = "exercise idempotent payment handler"
    const paymentBody = {
      debitAccountId: "account_customer_1",
      creditAccountId: "account_merchant_1",
      currency: "USD",
      amountMinor: "1250",
      reference: "order_1001"
    }
    const receipts = await Promise.all([
      postPayment(background(), sql, "tenant_acme", "order_1001", paymentBody),
      postPayment(background(), sql, "tenant_acme", "order_1001", paymentBody)
    ])
    assert(
      receipts[0]?.transactionId === receipts[1]?.transactionId &&
        receipts[0]?.eventId === receipts[1]?.eventId &&
        receipts.some((receipt) => receipt.replayed) &&
        receipts.some((receipt) => !receipt.replayed),
      `concurrent idempotent receipts differ: ${JSON.stringify(receipts)}`
    )

    const handler = newPaymentHandler(sql, () => "tenant_acme")
    const body = JSON.stringify(paymentBody)
    const request = () =>
      new Request("http://payments.test/v1/ledger/payments", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "order_1001" },
        body
      })
    const replayResponse = await handler(request())
    const replayReceipt: unknown = await replayResponse.json()
    assert(
      replayResponse.status === 201 &&
        replayReceipt !== null &&
        typeof replayReceipt === "object" &&
        "transactionId" in replayReceipt &&
        replayReceipt.transactionId === receipts[0]?.transactionId,
      `HTTP replay failed: status=${replayResponse.status}, body=${JSON.stringify(replayReceipt)}`
    )

    const conflict = await handler(
      new Request("http://payments.test/v1/ledger/payments", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "order_1001" },
        body: JSON.stringify({
          debitAccountId: "account_customer_1",
          creditAccountId: "account_merchant_1",
          currency: "USD",
          amountMinor: "1251",
          reference: "order_1001"
        })
      })
    )
    assert(conflict.status === 409, "idempotency conflict did not return 409")

    const counts = await Promise.all([
      sql<ReadbackCount[]>`SELECT count(*)::integer AS value FROM idempotency_request`,
      sql<ReadbackCount[]>`SELECT count(*)::integer AS value FROM ledger_transaction`,
      sql<ReadbackCount[]>`SELECT count(*)::integer AS value FROM ledger_posting`,
      sql<ReadbackCount[]>`SELECT count(*)::integer AS value FROM outbox_event`
    ])
    assert(
      counts[0][0]?.value === 1 &&
        counts[1][0]?.value === 1 &&
        counts[2][0]?.value === 2 &&
        counts[3][0]?.value === 1,
      "idempotency did not converge to one journal, two postings, and one outbox"
    )
    const total = (
      await sql<ReadbackText[]>`
      SELECT sum(amount_minor)::text AS value FROM ledger_posting
    `
    )[0]
    assert(total?.value === "0", "ledger postings are not balanced")

    phase = "reject unbalanced transaction"
    try {
      await sql.begin(async (transaction) => {
        const transactionId = crypto.randomUUID()
        await transaction`
          INSERT INTO ledger_transaction (
            transaction_id, tenant_id, currency, reference, posted_at
          ) VALUES (
            ${transactionId}, 'tenant_acme', 'USD', 'unbalanced-probe', now()
          )
        `
        await transaction`
          INSERT INTO ledger_posting (
            posting_id, transaction_id, tenant_id, account_id, currency, amount_minor
          ) VALUES (
            ${crypto.randomUUID()}, ${transactionId}, 'tenant_acme',
            'account_customer_1', 'USD', -1
          )
        `
      })
      throw new Error("unbalanced journal unexpectedly committed")
    } catch (error) {
      if (error instanceof Error && "errno" in error && typeof error.errno === "string") {
        constraintCode = error.errno
      } else {
        throw error
      }
    }
    assert(constraintCode === "23514", `unexpected balance constraint code: ${constraintCode}`)

    phase = "inject NATS outage"
    await docker(ownedDocker, ["stop", "--time", "1", NatsContainer])
    await waitUntil("official client disconnect", () => statuses.includes("disconnect"))
    try {
      await publishNextOutbox(background(), sql, jetstream(connection), `publisher_${RunId}`)
      throw new Error("outbox publish unexpectedly succeeded during NATS outage")
    } catch (error) {
      outageError = error instanceof Error ? error.name : typeof error
    }
    const unpublished = (
      await sql<ReadbackCount[]>`
      SELECT count(*)::integer AS value FROM outbox_event WHERE published_at IS NULL
    `
    )[0]
    assert(unpublished?.value === 1, "outbox was marked published without PubAck")

    phase = "recover NATS and publish outbox"
    await docker(ownedDocker, ["start", NatsContainer])
    await waitUntil(
      "restarted NATS JetStream API",
      async () => {
        await manager.streams.info(paymentStream)
        return true
      },
      30_000
    )
    assert(
      statuses.includes("reconnect"),
      `official client did not report reconnect: ${statuses.join(",")}`
    )
    await Bun.sleep(150)
    const published = await publishNextOutbox(
      background(),
      sql,
      jetstream(connection),
      `publisher_${RunId}`
    )
    assert(
      published.kind === "published" && published.acknowledgement.stream === paymentStream,
      "outbox did not receive the expected real PubAck"
    )
    const publishedCount = (
      await sql<ReadbackCount[]>`
      SELECT count(*)::integer AS value FROM outbox_event WHERE published_at IS NOT NULL
    `
    )[0]
    assert(publishedCount?.value === 1, "outbox was not marked after PubAck")

    phase = "drain and restart real services"
    const drainStarted = performance.now()
    await closeNats(connection)
    drainDurationMs = Math.round(performance.now() - drainStarted)
    connection = null
    if (statusTask !== null) await statusTask
    statusTask = null
    await sql.close()
    sql = null

    await docker(ownedDocker, ["restart", PostgresContainer])
    await docker(ownedDocker, ["restart", NatsContainer])
    await waitUntil("restarted PostgreSQL readiness", async () => {
      const ready = await docker(
        ownedDocker,
        [
          "exec",
          PostgresContainer,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "go-like",
          "-d",
          "ledger"
        ],
        true
      )
      return ready.exitCode === 0
    })
    sql = await connectPostgres(postgresPort)
    connection = await connectNats(natsPort)
    const persistentTransaction = (
      await sql<ReadbackCount[]>`
      SELECT count(*)::integer AS value FROM ledger_transaction
    `
    )[0]
    const persistentStream = await (await jetstreamManager(connection)).streams.info(paymentStream)
    persistent =
      persistentTransaction?.value === 1 &&
      persistentStream.state.messages === 1 &&
      persistentStream.config.storage === StorageType.File
    assert(persistent, "named-volume restart did not preserve ledger and JetStream data")

    phase = "run public start:prepared entrypoint"
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 204 })
    })
    const programPort = reservation.port
    reservation.stop(true)
    assert(programPort !== undefined, "Bun did not allocate the program port")
    const program = Bun.spawn(["bun", "run", "start:prepared"], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...scenarioDockerEnvironment(ownedDocker),
        HOST: "127.0.0.1",
        PORT: String(programPort),
        DATABASE_URL: `postgres://go-like:local-e2e-only@127.0.0.1:${postgresPort}/ledger`,
        NATS_URL: `nats://127.0.0.1:${natsPort}`,
        PUBLISHER_OWNER: `entry_${RunId}`
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
    void errorTask.catch(() => {})
    let outputJoined = false
    let forced = false
    let terminationTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await waitUntil(
        "start:prepared readiness",
        () => programOutput.includes('GO_LIKE_EXAMPLE_READY={"example":"payments-ledger"'),
        30_000
      )
      const entryReference = `entry-${RunId}`
      const response = await fetch(`http://127.0.0.1:${programPort}/v1/ledger/payments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": entryReference,
          "X-Tenant-Id": "tenant_acme"
        },
        body: JSON.stringify({
          debitAccountId: "account_customer_1",
          creditAccountId: "account_merchant_1",
          currency: "USD",
          amountMinor: "250",
          reference: entryReference
        })
      })
      const receipt: unknown = await response.json()
      assert(
        response.status === 201 &&
          receipt !== null &&
          typeof receipt === "object" &&
          "eventId" in receipt,
        `start:prepared payment probe failed: ${JSON.stringify(receipt)}`
      )
      await waitUntil("start:prepared outbox PubAck", async () => {
        const row = (
          await sql!<ReadbackCount[]>`
            SELECT count(*)::integer AS value
            FROM outbox_event
            WHERE published_at IS NOT NULL
          `
        )[0]
        return row?.value === 2
      })
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
      assert(exitCode === 0 || exitCode === 143, `start:prepared exited ${exitCode}`)
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
      await errorTask
    }
    const released = Bun.serve({
      hostname: "127.0.0.1",
      port: programPort,
      fetch: () => new Response(null, { status: 204 })
    })
    released.stop(true)
  } catch (error) {
    primary = safeFailure(`payments-ledger E2E failed during ${phase}`, error)
  } finally {
    if (sql !== null) {
      try {
        await sql.close({ timeout: 1 })
      } catch (error) {
        cleanupFailures.push(safeFailure("PostgreSQL cleanup failed", error))
      }
    }
    try {
      await closeNats(connection)
    } catch (error) {
      cleanupFailures.push(safeFailure("NATS cleanup failed", error))
    }
    if (statusTask !== null) {
      try {
        await statusTask
      } catch (error) {
        cleanupFailures.push(safeFailure("NATS status cleanup failed", error))
      }
    }
    try {
      await closeOwnedDockerContext(ownedDocker)
    } catch (error) {
      cleanupFailures.push(safeFailure("Owned Docker context cleanup failed", error))
    }
  }

  if (primary !== null || cleanupFailures.length > 0) {
    const failures = primary === null ? cleanupFailures : [primary, ...cleanupFailures]
    throw new AggregateError(failures, "payments-ledger Docker scenario failed")
  }
}

if (import.meta.main) await main()
