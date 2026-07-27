import { expect, test } from "bun:test"

import type { Context } from "@likego/context"
import type { Server } from "@likego/core"

import { serverConformanceCases } from "../src/server"

/** Creates one minimal blocking structural Server. */
function newFixture(): Server {
  let resolveRunning: (() => void) | null = null
  let started = false
  return {
    start(_ctx: Context): Promise<void> {
      started = true
      return new Promise<void>((resolve) => {
        resolveRunning = resolve
      })
    },
    stop(_ctx: Context): Promise<void> {
      if (!started) return Promise.reject(new Error("server has not started"))
      resolveRunning?.()
      return Promise.resolve()
    }
  }
}

test("publishes the Kratos-style blocking lifecycle case", async () => {
  const cases = serverConformanceCases(newFixture)
  expect(cases.map((entry) => entry.name)).toEqual(["server start remains active until stop"])
  await expect(cases[0]?.run()).resolves.toBeUndefined()
})

test("requires a factory", () => {
  expect(() => serverConformanceCases(null as never)).toThrow(TypeError)
})

test("propagates a Server.stop rejection", async () => {
  const failure = new Error("stop failed")
  const cases = serverConformanceCases(() => ({
    start(): Promise<void> {
      return new Promise<void>(() => {})
    },
    stop(): Promise<void> {
      return Promise.reject(failure)
    }
  }))

  await expect(cases[0]?.run()).rejects.toBe(failure)
})

test("bounds a Server.stop that never settles", async () => {
  const cases = serverConformanceCases(() => ({
    start(): Promise<void> {
      return new Promise<void>(() => {})
    },
    stop(): Promise<void> {
      return new Promise<void>(() => {})
    }
  }))

  await expect(cases[0]?.run()).rejects.toThrow("Server.stop exceeded 1000ms")
})
