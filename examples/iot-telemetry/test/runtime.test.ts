import { describe, expect, test } from "bun:test"

import { background, withCancel } from "@go-like/context"
import type { JetStreamManager } from "@nats-io/jetstream"
import type { NatsConnection } from "@nats-io/transport-node"

import {
  consumerName,
  deadLetterStream,
  ensureTelemetryTopology,
  newNatsConnectionServer,
  rawStream,
  validatedStream
} from "../src/runtime"

describe("telemetry topology", () => {
  test("leaves existing streams and consumer unchanged", async () => {
    const inspected: string[] = []
    const manager = {
      streams: {
        async info(name: string) {
          inspected.push(`stream:${name}`)
          return {}
        },
        async add() {
          throw new Error("existing streams must not be added")
        }
      },
      consumers: {
        async info(stream: string, consumer: string) {
          inspected.push(`consumer:${stream}:${consumer}`)
          return {}
        },
        async add() {
          throw new Error("existing consumer must not be added")
        }
      }
    } as unknown as JetStreamManager

    await ensureTelemetryTopology(manager)

    expect(inspected).toEqual([
      `stream:${rawStream}`,
      `stream:${validatedStream}`,
      `stream:${deadLetterStream}`,
      `consumer:${rawStream}:${consumerName}`
    ])
  })

  test("adds every missing stream and durable consumer", async () => {
    type StreamConfig = Parameters<JetStreamManager["streams"]["add"]>[0]
    type ConsumerConfig = Parameters<JetStreamManager["consumers"]["add"]>[1]
    const streams: StreamConfig[] = []
    const consumers: Array<{ readonly stream: string; readonly config: ConsumerConfig }> = []
    const manager = {
      streams: {
        async info() {
          throw new Error("missing stream")
        },
        async add(config: StreamConfig) {
          streams.push(config)
          return {}
        }
      },
      consumers: {
        async info() {
          throw new Error("missing consumer")
        },
        async add(stream: string, config: ConsumerConfig) {
          consumers.push({ stream, config })
          return {}
        }
      }
    } as unknown as JetStreamManager

    await ensureTelemetryTopology(manager)

    expect(streams).toEqual([
      {
        name: rawStream,
        subjects: ["telemetry.raw.v1.*"],
        retention: "limits",
        storage: "file"
      },
      {
        name: validatedStream,
        subjects: ["telemetry.validated.v1.*"],
        retention: "limits",
        storage: "file"
      },
      {
        name: deadLetterStream,
        subjects: ["telemetry.dlq.v1"],
        retention: "limits",
        storage: "file"
      }
    ])
    expect(consumers).toEqual([
      {
        stream: rawStream,
        config: {
          durable_name: consumerName,
          name: consumerName,
          ack_policy: "explicit",
          ack_wait: 2_000_000_000,
          max_ack_pending: 1,
          max_deliver: -1,
          filter_subject: "telemetry.raw.v1.*"
        }
      }
    ])
  })
})

describe("NATS connection server", () => {
  test("waits for a clean close and drains an open connection", async () => {
    let closed = false
    let drains = 0
    let finishClose: (failure?: Error) => void = () => {}
    const terminal = new Promise<Error | undefined>((resolve) => {
      finishClose = resolve
    })
    const connection = {
      closed: () => terminal,
      isClosed: () => closed,
      async drain() {
        drains += 1
        closed = true
      }
    } as unknown as NatsConnection
    const server = newNatsConnectionServer(connection)
    let settled = false
    const started = server.start(background()).then(() => {
      settled = true
    })

    await Promise.resolve()
    try {
      expect(settled).toBe(false)
    } finally {
      finishClose()
      await started
    }
    await server.stop(background())
    expect({ closed, drains }).toEqual({ closed: true, drains: 1 })
  })

  test("rejects an aborted start before waiting for connection close", async () => {
    const [ctx, cancel] = withCancel(background())
    cancel()
    const server = newNatsConnectionServer({
      closed: () => new Promise(() => {}),
      isClosed: () => false,
      async drain() {}
    } as unknown as NatsConnection)

    await expect(server.start(ctx)).rejects.toThrow("context canceled")
  })

  test("surfaces a failed connection close", async () => {
    const failure = new Error("NATS connection failed")
    const server = newNatsConnectionServer({
      closed: async () => failure,
      isClosed: () => true,
      async drain() {}
    } as unknown as NatsConnection)

    await expect(server.start(background())).rejects.toBe(failure)
  })

  test("does not drain an already closed connection", async () => {
    let drains = 0
    const server = newNatsConnectionServer({
      closed: async () => undefined,
      isClosed: () => true,
      async drain() {
        drains += 1
      }
    } as unknown as NatsConnection)

    await server.stop(background())
    expect(drains).toBe(0)
  })
})
