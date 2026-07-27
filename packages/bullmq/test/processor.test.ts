import { expect, test } from "bun:test"
import { background } from "@likego/context"

import {
  newBullMqWorkerServerWithFactory,
  type BullMqWorkerFactoryLike,
  type BullMqWorkerLike
} from "../src/server"
import { fakeWorker } from "./helpers"

test("invokes a lifecycle factory with zero arguments and never requests a processor", async () => {
  const native = fakeWorker()
  let argumentCount = -1
  const guarded = new Proxy(native.worker, {
    get(target, property, receiver): unknown {
      if (property === "processFn" || property === "processor") {
        throw new Error("adapter inspected BullMQ processor data plane")
      }
      return Reflect.get(target, property, receiver)
    }
  })
  const factory: BullMqWorkerFactoryLike = function createWorker(): BullMqWorkerLike {
    argumentCount = arguments.length
    return guarded
  }

  const server = newBullMqWorkerServerWithFactory(factory)
  const running = server.start(background())
  await Promise.resolve()
  await Promise.resolve()
  expect(argumentCount).toBe(0)
  await server.stop(background())
  await running
})
