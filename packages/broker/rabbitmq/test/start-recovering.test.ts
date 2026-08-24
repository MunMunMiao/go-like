import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { background, type Context } from "@go-like/context"
import type { ChannelModel, ConfirmChannel, RecoveringChannelModel } from "amqplib"
import * as RabbitMq from "../src/index"
import {
  newRecoveringRabbitMqBroker,
  type RabbitMqRecoveryConnector,
  type RecoveringRabbitMqBroker
} from "../src/index"
import { fakeConfirmChannel, nextTurn } from "./helpers"

function deferred(): {
  readonly promise: Promise<void>
  resolve(): void
} {
  let resolve = (): void => {}
  const promise = new Promise<void>((ok) => {
    resolve = ok
  })
  return {
    promise,
    resolve() {
      resolve()
    }
  }
}

function recoveringConnection(): RecoveringChannelModel & { closeCalls: number } {
  const recovering = new EventEmitter() as RecoveringChannelModel & { closeCalls: number }
  recovering.closeCalls = 0
  Object.defineProperty(recovering, "close", {
    value: async () => {
      recovering.closeCalls += 1
    }
  })
  return recovering
}

function throwOnClose(channel: ReturnType<typeof fakeConfirmChannel>): void {
  const nativeClose = channel.native.close.bind(channel.native)
  channel.native.close = async () => {
    await nativeClose()
    throw new Error("channel close failed")
  }
}

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

  test("closes a channel created after stop during rebuild", async () => {
    const channel = fakeConfirmChannel()
    throwOnClose(channel)
    const entered = deferred()
    const release = deferred()
    const recovering = recoveringConnection()
    const handle = startRecoveringRabbitMqBroker(background(), async (setup) => {
      await setup({
        createConfirmChannel: async () => {
          entered.resolve()
          await release.promise
          return channel.native
        }
      } as ChannelModel)
      return recovering
    })

    await entered.promise
    const stopping = handle.stop(background())
    await handle.stop(background())
    release.resolve()
    await stopping
    await expect(handle.ready(background())).rejects.toThrow(
      "RabbitMQ recovering broker was stopped"
    )
    expect(channel.calls.close).toBe(1)
    expect(recovering.closeCalls).toBe(1)
  })

  test("closes a rebuilt channel if stop wins after topology attach", async () => {
    const channel = fakeConfirmChannel()
    throwOnClose(channel)
    const channelEntered = deferred()
    const channelRelease = deferred()
    const consumeEntered = deferred()
    const consumeRelease = deferred()
    const consume = channel.native.consume.bind(channel.native) as ConfirmChannel["consume"]
    channel.native.consume = (async (queue, onMessage, options) => {
      consumeEntered.resolve()
      await consumeRelease.promise
      return consume(queue, onMessage, options)
    }) as ConfirmChannel["consume"]
    const recovering = recoveringConnection()
    const handle = startRecoveringRabbitMqBroker(background(), async (setup) => {
      await setup({
        createConfirmChannel: async () => {
          channelEntered.resolve()
          await channelRelease.promise
          return channel.native
        }
      } as ChannelModel)
      return recovering
    })

    await channelEntered.promise
    const subscribing = handle.broker.subscribe(background(), "jobs", async () => {})
    await nextTurn()
    channelRelease.resolve()
    await consumeEntered.promise
    await handle.stop(background())
    consumeRelease.resolve()
    await expect(handle.ready(background())).rejects.toThrow(
      "RabbitMQ recovering broker was stopped"
    )
    await subscribing
    expect(channel.calls.close).toBeGreaterThanOrEqual(1)
  })

  test("discards a recovered connection if stop wins after setup completes", async () => {
    const channel = fakeConfirmChannel()
    const recovering = recoveringConnection()
    const handle = startRecoveringRabbitMqBroker(background(), async (setup) => {
      await setup({
        createConfirmChannel: async () => channel.native
      } as ChannelModel)
      recovering.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
        void handle.stop(background())
        return EventEmitter.prototype.on.call(recovering, event, listener)
      }) as typeof recovering.on
      return recovering
    })

    await expect(handle.ready(background())).rejects.toThrow(
      "RabbitMQ recovering broker was stopped"
    )
    await handle.stop(background())
    expect(recovering.closeCalls).toBe(1)
  })

  test("stop after ready discards the retained recovering connection", async () => {
    const channel = fakeConfirmChannel()
    const recovering = recoveringConnection()
    const handle = startRecoveringRabbitMqBroker(background(), async (setup) => {
      await setup({
        createConfirmChannel: async () => channel.native
      } as ChannelModel)
      return recovering
    })
    const provider = await handle.ready(background())
    expect(provider.connection).toBe(recovering)

    await handle.stop(background())
    await handle.stop(background())
    expect(recovering.closeCalls).toBe(1)
    await expect(
      handle.broker.publish(background(), "jobs", {
        headers: {},
        body: new Uint8Array()
      })
    ).rejects.toThrow("RabbitMQ recovering broker is disconnected")
  })
})
