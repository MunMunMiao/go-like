import { SQL } from "bun"

import type { Context } from "@likego/context"
import type { JetStreamClient } from "@nats-io/jetstream"

import { requireActiveContext, requireIdentifier, type OutboxPublishResult } from "./payment"

const encoder = new TextEncoder()

interface OutboxRow {
  readonly event_id: string
  readonly subject: string
  readonly payload_json: string
}

/** Claims and publishes at most one outbox row without holding a database transaction over NATS. */
export async function publishNextOutbox(
  ctx: Context,
  sql: SQL,
  client: JetStreamClient,
  owner: string
): Promise<OutboxPublishResult> {
  requireActiveContext(ctx)
  requireIdentifier("outbox owner", owner)
  const claimed = await sql.begin(async (transaction) => {
    return await transaction<OutboxRow[]>`
      WITH candidate AS (
        SELECT event_id
        FROM outbox_event
        WHERE published_at IS NULL
          AND available_at <= now()
          AND (leased_until IS NULL OR leased_until < now())
        ORDER BY created_at, event_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE outbox_event AS event
      SET leased_by = ${owner},
          leased_until = now() + interval '5 seconds',
          attempts = attempts + 1,
          last_error_code = NULL
      FROM candidate
      WHERE event.event_id = candidate.event_id
      RETURNING event.event_id, event.subject, event.payload::text AS payload_json
    `
  })
  const row = claimed[0]
  if (row === undefined) return Object.freeze({ kind: "idle" })

  try {
    const acknowledgement = await client.publish(row.subject, encoder.encode(row.payload_json), {
      msgID: row.event_id,
      timeout: 500
    })
    const marked = await sql<{ readonly event_id: string }[]>`
      UPDATE outbox_event
      SET published_at = now(), leased_by = NULL, leased_until = NULL
      WHERE event_id = ${row.event_id} AND leased_by = ${owner} AND published_at IS NULL
      RETURNING event_id
    `
    if (marked.length !== 1) throw new Error("published outbox lease was lost")
    return Object.freeze({ kind: "published", eventId: row.event_id, acknowledgement })
  } catch (primary) {
    try {
      await sql`
        UPDATE outbox_event
        SET leased_by = NULL,
            leased_until = NULL,
            available_at = now() + interval '100 milliseconds',
            last_error_code = 'PUBLISH_FAILED'
        WHERE event_id = ${row.event_id} AND leased_by = ${owner} AND published_at IS NULL
      `
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], "outbox publish and lease release failed", {
        cause: primary
      })
    }
    throw primary
  }
}
