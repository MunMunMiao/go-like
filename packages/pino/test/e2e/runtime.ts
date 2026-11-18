import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { background } from "@go-like/core/context"
import type { LogRecord } from "@go-like/core/log"
import { newPinoHandler } from "@go-like/pino/log"
import pino from "pino"

function record(message: string, attrs: LogRecord["attrs"]): LogRecord {
  return Object.freeze({ time: 0, level: "info", message, event: "", attrs })
}

const directory = await mkdtemp(join(tmpdir(), "go-like-pino-native-"))
try {
  const sonicPath = join(directory, "sonic.log")
  const sonic = pino.destination({ dest: sonicPath, mkdir: true, sync: false })
  const sonicLogger = pino({ base: null, timestamp: false, redact: ["secret"] }, sonic)
  const sonicHandler = newPinoHandler(sonicLogger, sonic)
  const sonicRunning = sonicHandler.lifecycle.start(background())
  sonicHandler.handle(background(), record("native destination", { component: "handler" }))
  sonicLogger.info({ component: "sonic", secret: "hidden" }, "redacted")
  await sonicHandler.lifecycle.stop(background())
  await sonicRunning
  const sonicRecords = (await readFile(sonicPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const handlerRecord = sonicRecords.find((item) => item.component === "handler")
  const sonicRecord = sonicRecords.find((item) => item.component === "sonic")
  assert.notEqual(handlerRecord, undefined)
  assert.notEqual(sonicRecord, undefined)
  if (handlerRecord === undefined || sonicRecord === undefined) {
    throw new Error("Pino runtime records missing")
  }
  assert.equal(handlerRecord.msg, "native destination")
  assert.equal(sonicRecord.component, "sonic")
  assert.equal(sonicRecord.secret, "[Redacted]")

  const transportPath = join(directory, "transport.log")
  const transport = pino.transport({
    target: "pino/file",
    options: { destination: transportPath, mkdir: true }
  })
  const transportLogger = pino({ base: null, timestamp: false }, transport)
  const transportHandler = newPinoHandler(transportLogger, transport)
  const transportRunning = transportHandler.lifecycle.start(background())
  transportHandler.handle(background(), record("native transport", { component: "thread" }))
  await transportHandler.lifecycle.stop(background())
  await transportRunning
  const transportRecord = JSON.parse((await readFile(transportPath, "utf8")).trim()) as Record<
    string,
    unknown
  >
  assert.equal(transportRecord.component, "thread")
  assert.equal(transportRecord.msg, "native transport")

  console.log("log-pino-node-runtime ok")
} finally {
  await rm(directory, { recursive: true, force: true })
}
