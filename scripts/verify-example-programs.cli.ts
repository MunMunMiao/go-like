import { createServer } from "node:net"
import { join } from "node:path"

import { portIsReleased } from "./example-program-port"
import { verifyExampleProgram } from "./verify-workspace"

interface CatalogEntry {
  readonly id: string
  readonly requiresExternalServices?: true
}

interface Catalog {
  readonly examples: readonly CatalogEntry[]
}

const root = join(import.meta.dir, "..")
const readyPrefix = "LIKEGO_EXAMPLE_READY="
const startupTimeoutMs = 15_000
const shutdownTimeoutMs = 5_000

function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    work,
    Bun.sleep(timeoutMs).then(function timedOut(): never {
      throw new Error(message)
    })
  ])
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>(function listen(resolvePort, reject) {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", function listening(): void {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("cannot allocate an example HTTP port"))
        return
      }
      resolvePort(address.port)
    })
  })
  await new Promise<void>(function close(resolveClose, reject) {
    server.close(function closed(error): void {
      if (error === undefined) resolveClose()
      else reject(error)
    })
  })
  return port
}

function signalTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
  }
}

async function verifyProgram(entry: CatalogEntry): Promise<void> {
  const cwd = join(root, "examples", entry.id)
  const port = await freePort()
  const child = Bun.spawn(["bun", "run", "start:prepared"], {
    cwd,
    detached: true,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe"
  })
  let stdout = ""
  let stderr = ""
  let resolveReady: ((origin: string) => void) | undefined
  let rejectReady: ((reason: unknown) => void) | undefined
  const ready = new Promise<string>(function wait(resolve, reject) {
    resolveReady = resolve
    rejectReady = reject
  })

  async function capture(
    stream: ReadableStream<Uint8Array>,
    append: (value: string) => void
  ): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }))
    append(decoder.decode())
  }

  const stdoutDone = capture(child.stdout, function append(value): void {
    stdout += value
    const line = stdout.split("\n").find(function readyLine(candidate): boolean {
      return candidate.startsWith(readyPrefix)
    })
    if (line === undefined || resolveReady === undefined) return
    const payload = JSON.parse(line.slice(readyPrefix.length)) as { readonly origin?: unknown }
    if (typeof payload.origin !== "string") {
      rejectReady?.(new Error(`${entry.id} readiness did not publish an HTTP origin`))
      return
    }
    resolveReady(payload.origin)
    resolveReady = undefined
    rejectReady = undefined
  })
  const stderrDone = capture(child.stderr, function append(value): void {
    stderr += value
  })

  try {
    const origin = await within(
      Promise.race([
        ready,
        child.exited.then(function exited(code): never {
          throw new Error(`${entry.id} exited before readiness with code ${code}`)
        })
      ]),
      startupTimeoutMs,
      `${entry.id} did not become ready within ${startupTimeoutMs}ms`
    )
    const response = await fetch(`${origin}/`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(3_000)
    })
    await response.arrayBuffer()
    if (response.status >= 500) {
      throw new Error(`${entry.id} root probe returned HTTP ${response.status}`)
    }

    signalTree(child, "SIGTERM")
    const exitCode = await within(
      child.exited,
      shutdownTimeoutMs,
      `${entry.id} did not stop within ${shutdownTimeoutMs}ms`
    )
    if (exitCode !== 143) {
      throw new Error(`${entry.id} stopped with ${exitCode}, expected 143`)
    }
    if (!(await portIsReleased(port))) {
      throw new Error(`${entry.id} left port ${port} open`)
    }
    await Promise.all([stdoutDone, stderrDone])
    process.stdout.write(`PASS ${entry.id}\n`)
  } catch (error) {
    signalTree(child, "SIGKILL")
    await Promise.allSettled([child.exited, stdoutDone, stderrDone])
    const output = `${stdout}${stderr}`.trim()
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${output === "" ? "" : `\n${output}`}`
    )
  }
}

const catalog = (await Bun.file(join(root, "examples", "catalog.json")).json()) as Catalog
const contractIssues = (
  await Promise.all(
    catalog.examples.map((entry) => verifyExampleProgram(root, `examples/${entry.id}`))
  )
).flat()
if (contractIssues.length > 0) {
  throw new Error(
    contractIssues.map((issue) => `${issue.Code} ${issue.Path}: ${issue.Message}`).join("\n")
  )
}
const runnable = catalog.examples.filter(function withoutExternalServices(entry): boolean {
  return entry.requiresExternalServices !== true
})

for (const entry of runnable) await verifyProgram(entry)
process.stdout.write(`Verified ${runnable.length} directly runnable example programs.\n`)
