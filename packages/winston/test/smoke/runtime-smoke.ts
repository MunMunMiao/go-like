import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { newApp, server, type Server } from "@likego/core"
import { logWebHandler, newWinstonServer } from "@likego/winston"
import winston from "winston"

const directory = await mkdtemp(join(tmpdir(), "likego-winston-native-"))
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
    upstreamTerminal.signal.addEventListener(
      "abort",
      () => {
        resolve()
      },
      { once: true }
    )
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
  const logging = newWinstonServer(logger)
  const handler = logWebHandler(() => new Response(null, { status: 204 }), logger)
  assert.equal(logger.listenerCount("error"), listenerBaseline.error)
  assert.equal(logger.listenerCount("finish"), listenerBaseline.finish)
  assert.equal(logger.listenerCount("close"), listenerBaseline.close)
  const app = newApp(server(upstream, logging))
  const running = app.run()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(logger.listenerCount("error"), listenerBaseline.error + 1)
  assert.equal(logger.listenerCount("finish"), listenerBaseline.finish + 1)
  assert.equal(logger.listenerCount("close"), listenerBaseline.close + 1)
  const response = handler(new Request("https://example.test/private", { method: "POST" }))
  assert.equal(response instanceof Promise, false)
  assert.equal((response as Response).status, 204)
  await app.stop()
  await running
  assert.equal(logger.listenerCount("error"), listenerBaseline.error)
  assert.equal(logger.listenerCount("finish"), listenerBaseline.finish)
  assert.equal(logger.listenerCount("close"), listenerBaseline.close)

  const lines = (await readFile(path, "utf8")).trim().split("\n")
  assert.equal(lines.length, 2)
  const completion: unknown = JSON.parse(lines[0] ?? "null")
  assert.equal(typeof completion, "object")
  assert.notEqual(completion, null)
  if (typeof completion !== "object" || completion === null)
    throw new Error("Winston completion record is not an object")
  assert.equal("component" in completion ? completion.component : null, "web")
  assert.equal("operation" in completion ? completion.operation : null, "POST")
  assert.equal("outcome" in completion ? completion.outcome : null, "success")
  assert.equal("httpStatus" in completion ? completion.httpStatus : null, 204)
  assert.equal("url" in completion, false)

  const record: unknown = JSON.parse(lines[1] ?? "null")
  assert.equal(typeof record, "object")
  assert.notEqual(record, null)
  if (typeof record !== "object" || record === null)
    throw new Error("Winston record is not an object")
  assert.equal("component" in record ? record.component : null, "winston")
  assert.equal("final" in record ? record.final : null, true)
  assert.equal("message" in record ? record.message : null, "native logger")

  const packageJson: unknown = JSON.parse(
    await readFile(new URL("../../node_modules/winston/package.json", import.meta.url), "utf8")
  )
  if (typeof packageJson !== "object" || packageJson === null || !("version" in packageJson)) {
    throw new Error("Winston package version is unavailable")
  }
  assert.equal(packageJson.version, "3.19.0")
  console.log(`log-winston-node-runtime-smoke ok winston=${String(packageJson.version)}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
