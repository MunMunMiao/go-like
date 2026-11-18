import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"
import { afterStart, id, name, newApp, telemetry, version } from "@go-like/core"
import { background } from "@go-like/core/context"
import type { LogRecord } from "@go-like/core/log"
import { LogField, newTelemetry } from "@go-like/core/telemetry"
import { logHandlerConformance } from "@go-like/core/testing"
import { newWinstonHandler } from "@go-like/winston/log"
import winston from "winston"

import { FakeLogger } from "./helpers"

function record(level: LogRecord["level"], message: string): LogRecord {
  return Object.freeze({ time: 0, level, message, event: "", attrs: Object.freeze({}) })
}

test("winston log handler passes the core conformance suite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-winston-conformance-"))
  let sequence = 0
  let records: Record<string, unknown>[] = []
  try {
    const cases = logHandlerConformance({
      newHandler() {
        records = []
        const logger = winston.createLogger({
          level: "debug",
          format: winston.format((info) => {
            records.push(info)
            return info
          })(),
          transports: [
            new winston.transports.File({ filename: join(directory, `${sequence++}.log`) })
          ]
        })
        return newWinstonHandler(logger)
      },
      async written() {
        return records
      }
    })
    for (const item of cases) await item.run()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("writes a native record and drops a throwing logger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-winston-record-"))
  const path = join(directory, "service.log")
  try {
    const logger = winston.createLogger({
      format: winston.format.json(),
      transports: [new winston.transports.File({ filename: path })]
    })
    const handler = newWinstonHandler(logger)
    const failure = new Error("disk full")
    handler.handle(background(), {
      time: 0,
      level: "info",
      message: "native logger",
      event: "",
      attrs: { component: "winston", [LogField.exception]: failure }
    })
    logger.log = function fail(): winston.Logger {
      throw new Error("native write failed")
    }
    expect(() => handler.handle(background(), record("info", "dropped"))).not.toThrow()
    await handler.lifecycle.stop(background())
    const line = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, unknown>
    expect(line.message).toBe("native logger")
    expect(line.component).toBe("winston")
    expect(line).toHaveProperty("error")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("stop before start ends the logger and a later start fails", async () => {
  const logger = new FakeLogger()
  const lifecycle = newWinstonHandler(logger.official()).lifecycle
  await lifecycle.stop(background())
  expect(logger.endCalls).toBe(1)
  expect(logger.listenerCount("error")).toBe(0)
  await expect(lifecycle.start(background())).rejects.toMatchObject({
    code: "GO_LIKE_WINSTON_ALREADY_STARTED"
  })
})

test("stop before start rejects a logger that already finished or closed", async () => {
  const finished = new FakeLogger()
  finished.finished = true
  await expect(
    newWinstonHandler(finished.official()).lifecycle.stop(background())
  ).rejects.toMatchObject({
    code: "GO_LIKE_WINSTON_LOGGER_FINISHED"
  })
  const closed = new FakeLogger()
  closed.closed = true
  await expect(
    newWinstonHandler(closed.official()).lifecycle.stop(background())
  ).rejects.toMatchObject({
    code: "GO_LIKE_WINSTON_LOGGER_CLOSED"
  })
})

test("stop before start reports a logger that cannot accept listeners", async () => {
  const logger = new FakeLogger()
  logger.on = function rejectListener(): FakeLogger {
    throw new Error("cannot listen")
  }
  await expect(newWinstonHandler(logger.official()).lifecycle.stop(background())).rejects.toThrow(
    "cannot listen"
  )
})

test("admission binds service resource attributes onto later records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-winston-resource-"))
  const path = join(directory, "resource.log")
  let release = (): void => {
    throw new Error("admission did not start")
  }
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const logger = winston.createLogger({
      format: winston.format.json(),
      transports: [new winston.transports.File({ filename: path })]
    })
    const handler = newWinstonHandler(logger)
    const app = newApp(
      name("orders"),
      version("1.2.3"),
      id("box-1"),
      telemetry(newTelemetry({ logHandlers: [handler] })),
      afterStart(async function writeReady(): Promise<void> {
        handler.handle(background(), record("info", "ready"))
        release()
      })
    )
    const running = app.run()
    await admitted
    await app.stop()
    await running
    const line = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .find((item) => item.message === "ready")
    if (line === undefined) throw new Error("ready record missing")
    expect(line.message).toBe("ready")
    expect(line["service.name"]).toBe("orders")
    expect(line["service.version"]).toBe("1.2.3")
    expect(line["service.instance.id"]).toBe("box-1")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
