import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"
import { afterStart, id, name, newApp, telemetry, version } from "@go-like/core"
import { background } from "@go-like/core/context"
import type { LogRecord } from "@go-like/core/log"
import { newTelemetry } from "@go-like/core/telemetry"
import { LogField } from "@go-like/core/telemetry"
import { logHandlerConformance } from "@go-like/core/testing"
import { newPinoHandler } from "@go-like/pino/log"
import pino from "pino"

import { FakeDestination, FakeLogger, fakePinoServer } from "./helpers"

function record(level: LogRecord["level"], message: string): LogRecord {
  return Object.freeze({ time: 0, level, message, event: "", attrs: Object.freeze({}) })
}

test("pino log handler passes the core conformance suite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-conformance-"))
  let sequence = 0
  let records: Record<string, unknown>[] = []
  try {
    const cases = logHandlerConformance({
      newHandler() {
        records = []
        const destination = pino.destination({
          dest: join(directory, `${sequence++}.log`),
          mkdir: true,
          sync: true
        })
        const logger = pino(
          {
            base: null,
            hooks: {
              logMethod(inputArgs, method) {
                const merging: unknown = inputArgs[0]
                const message: unknown = inputArgs[1]
                const row: Record<string, unknown> = {}
                if (typeof merging === "object" && merging !== null) Object.assign(row, merging)
                if (typeof message === "string") row.message = message
                records.push(row)
                return method.apply(this, inputArgs)
              }
            }
          },
          destination
        )
        return newPinoHandler(logger, destination)
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

test("writes every level and keeps a native Error on err", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-levels-"))
  const path = join(directory, "levels.log")
  try {
    const destination = pino.destination({ dest: path, mkdir: true, sync: true })
    const seen: string[] = []
    const logger = pino(
      {
        base: null,
        level: "debug",
        hooks: {
          logMethod(inputArgs, method) {
            const message: unknown = inputArgs[1]
            if (typeof message === "string") seen.push(message)
            return method.apply(this, inputArgs)
          }
        }
      },
      destination
    )
    const handler = newPinoHandler(logger, destination)
    const failure = new Error("disk full")
    for (const level of ["debug", "info", "warn", "error"] as const) {
      handler.handle(background(), {
        time: 0,
        level,
        message: level,
        event: "",
        attrs: level === "error" ? { [LogField.exception]: failure } : {}
      })
    }
    expect(seen).toEqual(["debug", "info", "warn", "error"])
    logger.info = function fail(): void {
      throw new Error("native write failed")
    }
    expect(() => handler.handle(background(), record("info", "dropped"))).not.toThrow()
    await handler.lifecycle.stop(background())
    const lines = (await readFile(path, "utf8")).trim().split("\n")
    const errorLine = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.msg === "error")
    expect(errorLine?.err).toMatchObject({ message: "disk full" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("stop before start drains the destination and a later start fails", async () => {
  const logger = new FakeLogger()
  const destination = new FakeDestination()
  const lifecycle = fakePinoServer(logger.official(destination), destination)
  await lifecycle.stop(background())
  expect(destination.endCalls).toBe(1)
  expect(destination.listenerCount("error")).toBe(0)
  await expect(lifecycle.start(background())).rejects.toMatchObject({
    code: "GO_LIKE_PINO_ALREADY_STARTED"
  })
})

test("stop before start reports a destination that cannot accept listeners", async () => {
  const logger = new FakeLogger()
  const destination = new FakeDestination()
  destination.on = function rejectListener(): FakeDestination {
    throw new Error("cannot listen")
  }
  const lifecycle = fakePinoServer(logger.official(destination), destination)
  await expect(lifecycle.stop(background())).rejects.toThrow("cannot listen")
})

test("admission binds service resource attributes onto later records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-like-pino-resource-"))
  const path = join(directory, "resource.log")
  let release = (): void => {
    throw new Error("admission did not start")
  }
  const admitted = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const destination = pino.destination({ dest: path, mkdir: true, sync: true })
    const logger = pino({ base: null, timestamp: false }, destination)
    const handler = newPinoHandler(logger, destination)
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
      .find((item) => item.msg === "ready")
    if (line === undefined) throw new Error("ready record missing")
    expect(line.msg).toBe("ready")
    expect(line["service.name"]).toBe("orders")
    expect(line["service.version"]).toBe("1.2.3")
    expect(line["service.instance.id"]).toBe("box-1")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
