import { createRequire } from "node:module"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

interface Logger {
  info(message: string, metadata: Readonly<Record<string, unknown>>): unknown
  listenerCount(event: string): number
  once(event: string, listener: () => void): unknown
}

interface WinstonModule {
  createLogger(options: {
    readonly format: unknown
    readonly transports: readonly unknown[]
  }): Logger
  readonly format: {
    json(): unknown
  }
  readonly transports: {
    readonly File: new (options: { readonly filename: string }) => unknown
  }
}

interface PackageJson {
  readonly version: string
}

interface WinstonAdapterModule {
  newWinstonServer(logger: Logger): {
    start(ctx: unknown): Promise<void>
    stop(ctx: unknown): Promise<void>
  }
}

interface ContextModule {
  background(): unknown
}

interface ListenerCounts {
  readonly error: number
  readonly finish: number
  readonly close: number
}

/** Captures the three public logger lifecycle listener counts owned by the adapter. */
function listenerCounts(logger: Logger): ListenerCounts {
  return Object.freeze({
    error: logger.listenerCount("error"),
    finish: logger.listenerCount("finish"),
    close: logger.listenerCount("close")
  })
}

/** Returns the aggregate listener delta against one pre-transfer baseline. */
function listenerDelta(baseline: ListenerCounts, current: ListenerCounts): number {
  return (
    current.error -
    baseline.error +
    current.finish -
    baseline.finish +
    current.close -
    baseline.close
  )
}

/** Confirms the adapter installed exactly one listener for every owned lifecycle event. */
function adapterListenersInstalled(baseline: ListenerCounts, current: ListenerCounts): boolean {
  return (
    current.error === baseline.error + 1 &&
    current.finish === baseline.finish + 1 &&
    current.close === baseline.close + 1
  )
}

/** Confirms all three owned lifecycle listener counts returned exactly to baseline. */
function listenerCountsRestored(baseline: ListenerCounts, current: ListenerCounts): boolean {
  return (
    current.error === baseline.error &&
    current.finish === baseline.finish &&
    current.close === baseline.close
  )
}

/** Confirms one filesystem path no longer exists. */
async function removed(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return true
    }
    throw error
  }
}

const require = createRequire(resolve(process.cwd(), "package.json"))
const winston = require("winston") as WinstonModule
const packageJson = require("winston/package.json") as PackageJson
if (packageJson.version !== "3.19.0") {
  throw new Error(`unexpected Winston version ${packageJson.version}`)
}
const adapter = (await import(
  pathToFileURL(resolve(process.cwd(), "dist/index.js")).href
)) as WinstonAdapterModule
const context = (await import(
  pathToFileURL(resolve(process.cwd(), "../../packages/context/dist/index.js")).href
)) as ContextModule

const directory = await mkdtemp(resolve(tmpdir(), "go-like-winston-e2e-"))
const logPath = resolve(directory, "service.log")
let fileLanded = false
let nativeLoggerRecord = false
let startPendingBeforeStop = false
let nativeFinishObserved = false
const lifecycleOrder: string[] = []

try {
  const logger = winston.createLogger({
    format: winston.format.json(),
    transports: [new winston.transports.File({ filename: logPath })]
  })
  const baseline = listenerCounts(logger)
  const server = adapter.newWinstonServer(logger)
  if (listenerDelta(baseline, listenerCounts(logger)) !== 0) {
    throw new Error("Winston adapter installed listeners before lifecycle transfer")
  }

  const running = server.start(context.background())
  let startSettled = false
  void running.then(
    function resolved(): void {
      startSettled = true
    },
    function rejected(): void {
      startSettled = true
    }
  )
  await Promise.resolve()
  startPendingBeforeStop = !startSettled
  if (!startPendingBeforeStop) {
    throw new Error("Winston Server start settled before its native Logger terminal")
  }
  if (!adapterListenersInstalled(baseline, listenerCounts(logger))) {
    throw new Error("Winston adapter did not install exactly three lifecycle listeners")
  }

  logger.once("finish", function observeNativeFinish() {
    nativeFinishObserved = true
    lifecycleOrder.push("native-finish")
  })
  logger.info("native logger", { component: "winston", final: true })
  const stopping = server.stop(context.background())
  const joined = server.stop(context.background())
  await Promise.all([stopping, joined])
  lifecycleOrder.push("stop-resolved")
  await running
  lifecycleOrder.push("start-resolved")
  if (!nativeFinishObserved)
    throw new Error("Winston Logger did not reach its native finish terminal")

  const finalListeners = listenerCounts(logger)
  if (!listenerCountsRestored(baseline, finalListeners)) {
    throw new Error("Winston adapter lifecycle listeners remained installed")
  }

  const lines = (await readFile(logPath, "utf8")).trim().split("\n")
  lifecycleOrder.push("file-read")
  fileLanded = lines.length === 1
  const record: unknown = JSON.parse(lines[0] ?? "null")
  nativeLoggerRecord =
    typeof record === "object" &&
    record !== null &&
    "component" in record &&
    record.component === "winston" &&
    "final" in record &&
    record.final === true &&
    "message" in record &&
    record.message === "native logger"
  if (!fileLanded || !nativeLoggerRecord) {
    throw new Error("Winston File transport did not persist the native structured record")
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

const directoryRemoved = await removed(directory)
if (!directoryRemoved) throw new Error("Winston E2E temporary directory remained after cleanup")
