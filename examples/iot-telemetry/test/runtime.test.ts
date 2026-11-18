import { describe, expect, test } from "bun:test"

import { afterStart, name, newApp, resources, server } from "@go-like/core"
import { background } from "@go-like/core/context"
import type { Server } from "@go-like/core/lifecycle"
import type { JetStreamManager } from "@nats-io/jetstream"
import type { NatsConnection } from "@nats-io/transport-node"

import {
  consumerName,
  deadLetterStream,
  ensureTelemetryTopology,
  newNatsConnectionResource,
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

/** Resolves `start` when `stop` runs, matching a resident server-tier participant. */
function resident(label: string, events: string[]): Server {
  let resolveStart: (() => void) | null = null
  const started = new Promise<void>((resolve) => {
    resolveStart = resolve
  })
  return {
    async start(): Promise<void> {
      events.push(`${label}-start`)
      await started
    },
    async stop(): Promise<void> {
      events.push(`${label}-stop`)
      resolveStart?.()
    }
  }
}

/** Polls until the predicate holds. */
async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(1)
  }
}

describe("NATS connection resource", () => {
  test("admits while the connection is open and drains it once on stop", async () => {
    let closed = false
    let drains = 0
    const connection = {
      closed: () => new Promise<Error | undefined>(() => {}),
      isClosed: () => closed,
      async drain() {
        drains += 1
        closed = true
      }
    } as unknown as NatsConnection
    const resource = newNatsConnectionResource(connection)

    await resource.start(background())
    expect(drains).toBe(0)
    await resource.stop(background())
    await resource.stop(background())

    expect({ closed, drains }).toEqual({ closed: true, drains: 1 })
  })

  test("does not drain an already closed connection", async () => {
    let drains = 0
    const resource = newNatsConnectionResource({
      closed: () => new Promise<Error | undefined>(() => {}),
      isClosed: () => true,
      async drain() {
        drains += 1
      }
    } as unknown as NatsConnection)

    await resource.start(background())
    await resource.stop(background())

    expect(drains).toBe(0)
  })

  test("stops the worker before draining the connection", async () => {
    const events: string[] = []
    const connection = {
      closed: () => new Promise<Error | undefined>(() => {}),
      isClosed: () => false,
      async drain() {
        events.push("nats-drain")
      }
    } as unknown as NatsConnection
    const app = newApp(
      name("iot-telemetry-order"),
      resources(newNatsConnectionResource(connection)),
      server(resident("worker", events))
    )
    const running = app.run()
    void running.catch(() => {})

    await waitFor("worker start", () => events.includes("worker-start"))
    await app.stop()
    await running

    const workerStop = events.indexOf("worker-stop")
    const drain = events.indexOf("nats-drain")
    expect(workerStop).toBeGreaterThanOrEqual(0)
    expect(drain).toBeGreaterThan(workerStop)
    expect(events.filter((event) => event === "nats-drain")).toEqual(["nats-drain"])
  })

  test("a failed connection close fails the running app", async () => {
    const failure = new Error("NATS connection failed")
    let finish: (error: Error) => void = () => {}
    const terminal = new Promise<Error>((resolve) => {
      finish = resolve
    })
    let drains = 0
    const connection = {
      closed: () => terminal,
      isClosed: () => false,
      async drain() {
        drains += 1
      }
    } as unknown as NatsConnection
    let ready = false
    const app = newApp(
      name("iot-telemetry-terminal"),
      resources(newNatsConnectionResource(connection)),
      afterStart(() => {
        ready = true
      })
    )
    const running = app.run()
    void running.catch(() => {})

    await waitFor("admission", () => ready)
    finish(failure)

    await expect(running).rejects.toBe(failure)
    expect(drains).toBe(1)
  })
})
