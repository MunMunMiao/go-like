import process from "node:process"

import { SQL } from "bun"

import type { Context } from "@likego/context"
import { afterStart, name, newApp, server, type Server } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Handler } from "@likego/web"
import { RetentionPolicy, StorageType, jetstream, jetstreamManager } from "@nats-io/jetstream"
import { connect, type NatsConnection } from "@nats-io/transport-node"

import { newPaymentHandler } from "./http"
import { publishNextOutbox } from "./nats"
import { paymentStream, paymentSubject } from "./payment"
import { createLedgerAccount, migrateLedger } from "./postgres"
import { newOutboxPublisherServer } from "./worker"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://likego:local-e2e-only@127.0.0.1:35432/ledger"
const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:34222"
const publisherOwner = process.env.PUBLISHER_OWNER ?? `publisher_${crypto.randomUUID()}`

/** Hosts one standard Fetch Handler through Bun's native server as a structural LikeGo Server. */
function newBunWebServer(handler: Handler): Server {
  let started = false
  let native: ReturnType<typeof Bun.serve> | null = null
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      if (started) throw new Error("Bun web server has already started")
      const failure = ctx.err()
      if (failure !== null) throw failure
      started = true
      native = Bun.serve({ hostname: host, port: portNumber, fetch: handler })
      await done
    },
    async stop(ctx: Context): Promise<void> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      await native?.stop(false)
      resolveDone?.()
    }
  })
}

/** Gives Core ownership of the SQL and NATS client resources. */
function dependencyServer(sql: SQL, connection: NatsConnection): Server {
  const done = connection.closed().then((failure) => {
    if (failure !== undefined) throw failure
  })
  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      await done
    },
    async stop(): Promise<void> {
      if (!connection.isClosed()) await connection.drain()
      await sql.close({ timeout: 5 })
    }
  })
}

/** Installs the schema once and preserves repeatable demo accounts across restarts. */
async function ensureLedger(sql: SQL): Promise<void> {
  const tables = await sql<{ readonly name: string | null }[]>`
    SELECT to_regclass('public.ledger_account')::text AS name
  `
  if (tables[0]?.name === null) await migrateLedger(sql)
  for (const accountId of ["account_customer_1", "account_merchant_1"] as const) {
    const existing = await sql<{ readonly present: number }[]>`
      SELECT 1::integer AS present
      FROM ledger_account
      WHERE tenant_id = 'tenant_acme' AND account_id = ${accountId}
    `
    if (existing.length === 0) {
      await createLedgerAccount(sql, {
        tenantId: "tenant_acme",
        accountId,
        currency: "USD"
      })
    }
  }
}

const sql = new SQL(databaseUrl)
let connection: NatsConnection | null = null
try {
  await sql.connect()
  await sql`SELECT 1`
  await ensureLedger(sql)
  connection = await connect({
    servers: natsUrl,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 100,
    reconnectJitter: 0,
    timeout: 2_000
  })
  const manager = await jetstreamManager(connection)
  try {
    await manager.streams.info(paymentStream)
  } catch {
    await manager.streams.add({
      name: paymentStream,
      subjects: [paymentSubject],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File
    })
  }
  const publisherClient = jetstream(connection)
  const publisher = newOutboxPublisherServer(
    (ctx) => publishNextOutbox(ctx, sql, publisherClient, publisherOwner),
    100
  )
  const handler = newPaymentHandler(sql, function resolveTenant(_ctx, request): string {
    return request.headers.get("X-Tenant-Id") ?? "tenant_acme"
  })
  const origin = `http://${host}:${portNumber}`
  const app = newApp(
    signal(),
    name("payments-ledger"),
    server(dependencyServer(sql, connection), publisher, newBunWebServer(handler)),
    afterStart(function announceReady(): void {
      process.stdout.write(
        `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "payments-ledger", origin })}\n`
      )
    })
  )
  await app.run()
} finally {
  if (connection !== null && !connection.isClosed()) await connection.close()
  await sql.close({ timeout: 0 }).catch(() => {})
}
