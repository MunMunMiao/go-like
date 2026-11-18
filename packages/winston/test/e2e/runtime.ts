import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterStart, newApp, server, telemetry } from "@go-like/core"
import { background } from "@go-like/core/context"
import type { Server } from "@go-like/core/lifecycle"
import { newTelemetry } from "@go-like/core/telemetry"
import { newWinstonHandler } from "@go-like/winston/log"
import winston from "winston"

const directory = await mkdtemp(join(tmpdir(), "go-like-winston-native-"))
const path = join(directory, "service.log")
try {
  const logger = winston.createLogger({
    format: winston.format.json(),
    transports: [new winston.transports.File({ filename: path })]
  })
  const listenerBaseline = Object.freeze({
    error: logger.listenerCount("error"),
    finish: logger.listenerCount("finish"),
    close: logger.listenerCount("close")
  })
  const upstreamTerminal = new AbortController()
  const upstreamDone = new Promise<void>((resolve) => {
    upstreamTerminal.signal.addEventListener("abort", () => resolve(), { once: true })
  })
  const upstream: Server = Object.freeze({
    /** Starts one structural producer whose final record is emitted during shutdown. */
    start(): Promise<void> {
      return upstreamDone
    },
    /** Emits one final native Winston record before logging drains. */
    async stop(): Promise<void> {
      logger.info("native logger", { component: "winston", final: true })
      upstreamTerminal.abort()
    }
  })
  const handler = newWinstonHandler(logger)
  assert.equal(logger.listenerCount("error"), listenerBaseline.error)
  assert.equal(logger.listenerCount("finish"), listenerBaseline.finish)
  assert.equal(logger.listenerCount("close"), listenerBaseline.close)
  let release = (): void => {
    throw new Error("admission did not start")
  }
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = newApp(
    telemetry(newTelemetry({ logHandlers: [handler] })),
    server(upstream),
    afterStart(async function markReady(): Promise<void> {
      release()
    })
  )
  const running = app.run()
  await ready
  assert.equal(logger.listenerCount("error"), listenerBaseline.error + 1)
  assert.equal(logger.listenerCount("finish"), listenerBaseline.finish + 1)
  assert.equal(logger.listenerCount("close"), listenerBaseline.close + 1)
  handler.handle(background(), {
    time: 0,
    level: "info",
    message: "handler record",
    event: "",
    attrs: { component: "handler" }
  })
  await app.stop()
  await running
  assert.equal(logger.listenerCount("error"), listenerBaseline.error)
  assert.equal(logger.listenerCount("finish"), listenerBaseline.finish)
  assert.equal(logger.listenerCount("close"), listenerBaseline.close)

  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const handled = lines.find((line) => line.component === "handler")
  const record = lines.find((line) => line.component === "winston")
  if (handled === undefined) throw new Error("Winston handler record is missing")
  if (record === undefined) throw new Error("Winston record is missing")
  assert.equal(handled.message, "handler record")
  assert.equal(record.final, true)
  assert.equal(record.message, "native logger")

  console.log("log-winston-node-runtime ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
