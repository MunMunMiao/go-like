import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { background, type Context } from "@go-like/context"
import type { ChannelModel, RecoveringChannelModel } from "amqplib"
import * as RabbitMq from "../src/index"
import {
  newRecoveringRabbitMqBroker,
  type RabbitMqRecoveryConnector,
  type RecoveringRabbitMqBroker
} from "../src/index"
import { fakeConfirmChannel, nextTurn } from "./helpers"

type RecoveringRabbitMqHandle = {
  readonly broker: RecoveringRabbitMqBroker["broker"]
  ready(ctx: Context): Promise<RecoveringRabbitMqBroker>
  stop(ctx: Context): Promise<void>
}

const startRecoveringRabbitMqBroker = (
  RabbitMq as typeof RabbitMq & {
    startRecoveringRabbitMqBroker: (
      ctx: Context,
      connector: RabbitMqRecoveryConnector
    ) => RecoveringRabbitMqHandle
  }
).startRecoveringRabbitMqBroker

describe("startRecoveringRabbitMqBroker", () => {
  test("returns before a hanging recovery connector resolves", () => {
    expect(typeof startRecoveringRabbitMqBroker).toBe("function")
    let connectorResolved = false
    const hanging = new Promise<RecoveringChannelModel>(() => {})
    const handle = startRecoveringRabbitMqBroker(background(), async () => {
      const connection = await hanging
      connectorResolved = true
      return connection
    })

    expect(handle).not.toBeInstanceOf(Promise)
    expect(connectorResolved).toBe(false)
    expect(typeof handle.ready).toBe("function")
    expect(typeof handle.broker.publish).toBe("function")
  })

  test("rejects publish while the recovering broker is disconnected", async () => {
    expect(typeof startRecoveringRabbitMqBroker).toBe("function")
    const hanging = new Promise<RecoveringChannelModel>(() => {})
    const handle = startRecoveringRabbitMqBroker(background(), async () => hanging)

    await expect(
      handle.broker.publish(background(), "jobs", {
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toThrow("RabbitMQ recovering broker is disconnected")
  })

  test("resolves ready after a hanging connector completes initial setup", async () => {
    expect(typeof startRecoveringRabbitMqBroker).toBe("function")
    const channel = fakeConfirmChannel()
    const recovering = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(recovering, "close", { value: async () => {} })
    const model = {
      createConfirmChannel: async () => channel.native
    } as ChannelModel
    let setup: (model: ChannelModel) => Promise<void> = async () => {
      throw new Error("recovery setup was not captured")
    }
    let resolveConnection: (connection: RecoveringChannelModel) => void = () => {}
    const supplied = new Promise<RecoveringChannelModel>((resolve) => {
      resolveConnection = resolve
    })
    let connectorResolved = false
    const handle = startRecoveringRabbitMqBroker(background(), async (provided) => {
      setup = provided
      const connection = await supplied
      connectorResolved = true
      return connection
    })

    expect(handle).not.toBeInstanceOf(Promise)
    expect(connectorResolved).toBe(false)
    await expect(
      handle.broker.publish(background(), "jobs", {
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toThrow("RabbitMQ recovering broker is disconnected")

    await nextTurn()
    await setup(model)
    resolveConnection(recovering)
    const provider = await handle.ready(background())
    expect(connectorResolved).toBe(true)
    expect(provider.connection).toBe(recovering)
    expect(provider.broker).toBe(handle.broker)

    const publishing = handle.broker.publish(background(), "jobs", {
      headers: {},
      body: new Uint8Array([1])
    })
    channel.confirm(0)
    await expect(publishing).resolves.toBe(true)
  })

  test("still rejects a recovery connector that did not complete initial setup", async () => {
    let closeCalls = 0
    const connection = new EventEmitter() as RecoveringChannelModel
    Object.defineProperty(connection, "close", {
      value: async () => {
        closeCalls += 1
      }
    })

    await expect(newRecoveringRabbitMqBroker(background(), async () => connection)).rejects.toThrow(
      "must complete its initial setup"
    )
    expect(closeCalls).toBe(1)
  })
})
