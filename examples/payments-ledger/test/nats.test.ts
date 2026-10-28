import { describe, expect, test } from "bun:test"
import { SQL } from "bun"

import { background } from "@go-like/context"
import type { JetStreamClient, PubAck } from "@nats-io/jetstream"

import { publishNextOutbox } from "../src/nats"
import { paymentStream, paymentSubject } from "../src/payment"

const row = Object.freeze({
  event_id: "event-1",
  subject: paymentSubject,
  payload_json: '{"eventId":"event-1"}'
})
const acknowledgement = Object.freeze({
  stream: paymentStream,
  seq: 1,
  duplicate: false
}) as PubAck

interface SqlState {
  readonly claimed: boolean
  readonly marked: boolean
  readonly releaseFailure?: Error
  calls: number
}

type Publication = Parameters<JetStreamClient["publish"]>

function outboxSql(state: SqlState): SQL {
  const transaction = (async () => (state.claimed ? [row] : [])) as unknown as SQL
  return Object.assign(
    (async () => {
      state.calls += 1
      if (state.calls === 1 && state.marked) return [{ event_id: row.event_id }]
      if (state.releaseFailure !== undefined) throw state.releaseFailure
      return []
    }) as unknown as SQL,
    {
      async begin<T>(callback: (sql: SQL) => Promise<T>): Promise<T> {
        return await callback(transaction)
      }
    }
  )
}

function publisher(publications: Publication[] = [], failure?: Error): JetStreamClient {
  const publish: JetStreamClient["publish"] = async (...publication) => {
    publications.push(publication)
    if (failure !== undefined) throw failure
    return acknowledgement
  }
  return {
    publish
  } as unknown as JetStreamClient
}

describe("outbox publication", () => {
  test("returns idle when no outbox lease is available", async () => {
    const state = { claimed: false, marked: false, calls: 0 }

    const result = await publishNextOutbox(
      background(),
      outboxSql(state),
      publisher([], new Error("must not publish")),
      "publisher_1"
    )

    expect(result).toEqual({ kind: "idle" })
    expect(state.calls).toBe(0)
  })

  test("publishes and marks one claimed outbox event", async () => {
    const state = { claimed: true, marked: true, calls: 0 }
    const publications: Publication[] = []

    const result = await publishNextOutbox(
      background(),
      outboxSql(state),
      publisher(publications),
      "publisher_1"
    )

    expect(result).toEqual({ kind: "published", eventId: "event-1", acknowledgement })
    expect(publications).toHaveLength(1)
    const [subject, payload, options] = publications[0] ?? []
    expect(subject).toBe(paymentSubject)
    if (!(payload instanceof Uint8Array)) throw new TypeError("expected byte payload")
    expect(new TextDecoder().decode(payload)).toBe('{"eventId":"event-1"}')
    expect(options).toEqual({ msgID: "event-1", timeout: 500 })
    expect(state.calls).toBe(1)
  })

  test("releases a published event whose lease was lost", async () => {
    const state = { claimed: true, marked: false, calls: 0 }

    await expect(
      publishNextOutbox(background(), outboxSql(state), publisher(), "publisher_1")
    ).rejects.toThrow("published outbox lease was lost")
    expect(state.calls).toBe(2)
  })

  test("releases the lease and preserves a publish failure", async () => {
    const failure = new Error("NATS publish failed")
    const state = { claimed: true, marked: false, calls: 0 }

    await expect(
      publishNextOutbox(background(), outboxSql(state), publisher([], failure), "publisher_1")
    ).rejects.toBe(failure)
    expect(state.calls).toBe(1)
  })

  test("reports both publish and lease-release failures", async () => {
    const publishFailure = new Error("NATS publish failed")
    const releaseFailure = new Error("PostgreSQL release failed")
    const state = { claimed: true, marked: false, releaseFailure, calls: 0 }

    try {
      await publishNextOutbox(
        background(),
        outboxSql(state),
        publisher([], publishFailure),
        "publisher_1"
      )
      throw new Error("expected outbox publication to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect(error).toMatchObject({
        message: "outbox publish and lease release failed",
        cause: publishFailure,
        errors: [publishFailure, releaseFailure]
      })
    }
    expect(state.calls).toBe(1)
  })
})
