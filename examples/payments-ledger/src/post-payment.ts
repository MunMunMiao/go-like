import { SQL } from "bun"

import type { Context } from "@go-like/context"

import {
  parsePaymentRequest,
  paymentFailure,
  paymentSubject,
  requireActiveContext,
  requireIdentifier,
  type PaymentEvent,
  type PaymentReceipt
} from "./payment"

interface IdempotencyRow {
  readonly same_request: boolean
  readonly response_status: number
  readonly transaction_id: string | null
  readonly event_id: string | null
}

/** Atomically records idempotency, a balanced journal, and its outbox event. */
export async function postPayment(
  ctx: Context,
  sql: SQL,
  tenantId: string,
  idempotencyKey: string,
  value: unknown
): Promise<PaymentReceipt> {
  requireActiveContext(ctx)
  requireIdentifier("tenantId", tenantId)
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 128 ||
    /[^\x21-\x7e]/u.test(idempotencyKey)
  ) {
    throw paymentFailure("PAYMENT_VALIDATION", "Idempotency-Key is invalid")
  }
  const request = parsePaymentRequest(value)
  const transactionId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const postedAt = new Date().toISOString()
  const response = Object.freeze({ transactionId, eventId })
  const event: PaymentEvent = {
    schemaVersion: 1,
    eventId,
    transactionId,
    tenantId,
    currency: request.currency,
    reference: request.reference,
    postedAt,
    postings: [
      { accountId: request.debitAccountId, amountMinor: `-${request.amountMinor}` },
      { accountId: request.creditAccountId, amountMinor: request.amountMinor }
    ]
  }
  const requestJson = JSON.stringify(request)
  const responseJson = JSON.stringify(response)
  const eventJson = JSON.stringify(event)

  return await sql.begin(async (transaction) => {
    const claimed = await transaction<{ readonly idempotency_key: string }[]>`
      INSERT INTO idempotency_request (
        tenant_id, idempotency_key, request_payload, response_status,
        response_payload, transaction_id, created_at
      ) VALUES (
        ${tenantId}, ${idempotencyKey}, ${requestJson}::text::jsonb, 201,
        ${responseJson}::text::jsonb, ${transactionId}, ${postedAt}
      )
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `
    if (claimed.length === 0) {
      const existing = await transaction<IdempotencyRow[]>`
        SELECT
          request_payload = ${requestJson}::text::jsonb AS same_request,
          response_status,
          response_payload ->> 'transactionId' AS transaction_id,
          response_payload ->> 'eventId' AS event_id
        FROM idempotency_request
        WHERE tenant_id = ${tenantId} AND idempotency_key = ${idempotencyKey}
        FOR UPDATE
      `
      const row = existing[0]
      if (row === undefined || !row.same_request) {
        throw paymentFailure(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used for another request"
        )
      }
      if (row.response_status !== 201 || row.transaction_id === null || row.event_id === null) {
        throw new Error("stored idempotency response is invalid")
      }
      return Object.freeze({
        transactionId: row.transaction_id,
        eventId: row.event_id,
        replayed: true
      })
    }

    await transaction`
      INSERT INTO ledger_transaction (
        transaction_id, tenant_id, currency, reference, posted_at
      ) VALUES (
        ${transactionId}, ${tenantId}, ${request.currency}, ${request.reference}, ${postedAt}
      )
    `
    await transaction`
      INSERT INTO ledger_posting (
        posting_id, transaction_id, tenant_id, account_id, currency, amount_minor
      ) VALUES
        (
          ${crypto.randomUUID()}, ${transactionId}, ${tenantId}, ${request.debitAccountId},
          ${request.currency}, ${request.amountMinor}::bigint * -1
        ),
        (
          ${crypto.randomUUID()}, ${transactionId}, ${tenantId}, ${request.creditAccountId},
          ${request.currency}, ${request.amountMinor}::bigint
        )
    `
    await transaction`
      INSERT INTO outbox_event (
        event_id, transaction_id, subject, payload, created_at, available_at
      ) VALUES (
        ${eventId}, ${transactionId}, ${paymentSubject}, ${eventJson}::text::jsonb,
        ${postedAt}, ${postedAt}
      )
    `
    return Object.freeze({ transactionId, eventId, replayed: false })
  })
}
