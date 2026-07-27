import { background } from "@likego/context"
import type { Server } from "@likego/core"

import type { ConformanceCase } from "./index"

/** Creates a fresh structural Server for one isolated conformance case. */
export type ServerFactory = () => Server | PromiseLike<Server>

const cleanupTimeoutMs = 1_000

/** Bounds one conformance operation so a broken subject cannot hang the test runner. */
function bounded(operation: PromiseLike<void>, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} exceeded ${cleanupTimeoutMs}ms`))
    }, cleanupTimeoutMs)
    Promise.resolve(operation).then(
      () => {
        clearTimeout(timeout)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

/** Verifies the Kratos Server contract: start runs until stop completes. */
async function runsUntilStop(factory: ServerFactory): Promise<void> {
  const server = await factory()
  let settled = false
  const running = Promise.resolve()
    .then(() => server.start(background()))
    .finally(() => {
      settled = true
    })

  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  if (settled) throw new Error("Server.start must remain active until Server.stop")

  await bounded(server.stop(background()), "Server.stop")
  await bounded(running, "Server.start")
}

/** Builds the runner-neutral case for the public Kratos-style Server contract. */
export function serverConformanceCases(factory: ServerFactory): readonly ConformanceCase[] {
  if (typeof factory !== "function") throw new TypeError("server factory must be a function")
  return Object.freeze([
    Object.freeze({
      name: "server start remains active until stop",
      /** Runs the blocking-start conformance assertion. */
      run(): Promise<void> {
        return runsUntilStop(factory)
      }
    })
  ])
}
