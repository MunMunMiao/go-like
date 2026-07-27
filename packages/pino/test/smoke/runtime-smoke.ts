import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { background } from "@likego/context"
import { logWebHandler, newPinoServer } from "@likego/pino"
import pino from "pino"

const directory = await mkdtemp(join(tmpdir(), "likego-pino-native-"))
try {
  const sonicPath = join(directory, "sonic.log")
  const sonic = pino.destination({ dest: sonicPath, mkdir: true, sync: false })
  const sonicLogger = pino({ base: null, timestamp: false, redact: ["secret"] }, sonic)
  const sonicServer = newPinoServer(sonicLogger, sonic)
  const sonicRunning = sonicServer.start(background())
  sonicLogger.info({ component: "sonic", secret: "hidden" }, "native destination")
  const response = logWebHandler(
    () => new Response(null, { status: 204 }),
    sonicLogger
  )(new Request("https://example.test/private", { method: "PATCH" }))
  assert.equal(response instanceof Promise, false)
  assert.equal((response as Response).status, 204)
  await sonicServer.stop(background())
  await sonicRunning
  const sonicRecords = (await readFile(sonicPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const sonicRecord = sonicRecords.find((record) => record.component === "sonic")
  const webRecord = sonicRecords.find((record) => record.component === "web")
  assert.notEqual(sonicRecord, undefined)
  assert.notEqual(webRecord, undefined)
  if (sonicRecord === undefined || webRecord === undefined)
    throw new Error("Pino smoke records missing")
  assert.equal(sonicRecord.component, "sonic")
  assert.equal(sonicRecord.secret, "[Redacted]")
  assert.equal(webRecord.operation, "PATCH")
  assert.equal(webRecord.outcome, "success")
  assert.equal(webRecord.httpStatus, 204)
  assert.equal(JSON.stringify(webRecord).includes("/private"), false)

  const transportPath = join(directory, "transport.log")
  const transport = pino.transport({
    target: "pino/file",
    options: { destination: transportPath, mkdir: true }
  })
  const transportLogger = pino({ base: null, timestamp: false }, transport)
  const transportServer = newPinoServer(transportLogger, transport)
  const transportRunning = transportServer.start(background())
  transportLogger.info({ component: "thread" }, "native transport")
  await transportServer.stop(background())
  await transportRunning
  const transportRecord = JSON.parse((await readFile(transportPath, "utf8")).trim()) as Record<
    string,
    unknown
  >
  assert.equal(transportRecord.component, "thread")

  const packageJson = JSON.parse(
    await readFile(new URL("../../node_modules/pino/package.json", import.meta.url), "utf8")
  ) as { version: string }
  console.log(`log-pino-node-runtime-smoke ok pino=${packageJson.version}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
