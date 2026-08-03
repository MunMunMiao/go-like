import { createConnection, createServer } from "node:net"
import { resolve } from "node:path"

import { errorSummary } from "./harness/diagnostics"
import { authorityToEnvironment } from "./harness/owned-docker"
import { createProcessSupervisor, type ProcessSupervisor } from "./harness/process"

const RepositoryRoot = resolve(import.meta.dir, "..")
const readyPrefix = "LIKEGO_EXAMPLE_READY="
const commandTimeoutMs = 30_000

function timeout<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolveWork, rejectWork) => {
    const timer = setTimeout(() => rejectWork(new Error(message)), milliseconds)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolveWork(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        rejectWork(error)
      }
    )
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.once("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        rejectPort(new Error("no loopback port"))
      } else {
        resolvePort(address.port)
      }
    })
  })
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
  )
  return port
}

async function released(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const closed = await new Promise<boolean>((resolveClosed) => {
      const socket = createConnection({ host: "127.0.0.1", port })
      let settled = false
      const finish = (value = false): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolveClosed(value)
      }
      socket.setTimeout(250, finish)
      socket.once("connect", finish)
      socket.once("error", (error) =>
        finish(error instanceof Error && "code" in error && error.code === "ECONNREFUSED")
      )
    })
    if (closed) return true
    await Bun.sleep(100)
  }
  return false
}

export async function runExample(
  cwd: string,
  signal?: AbortSignal,
  supervisor?: ProcessSupervisor
): Promise<void> {
  signal?.throwIfAborted()
  const ownedSupervisor =
    supervisor === undefined ? await createProcessSupervisor("managed", RepositoryRoot) : null
  const runner = supervisor ?? ownedSupervisor
  if (runner === null) throw new Error("example process supervisor is unavailable")
  let stdout = ""
  let stderr = ""
  let primary: unknown = null
  try {
    if (ownedSupervisor !== null) await ownedSupervisor.preflight()
    const name = String((await Bun.file(resolve(cwd, "package.json")).json()).name)
    const port = await freePort()
    const commandController = new AbortController()
    const completedRequest = new Error("example request completed")
    const forwardAbort = (): void => commandController.abort(signal?.reason)
    signal?.addEventListener("abort", forwardAbort, { once: true })
    let readyResolve: ((origin: string) => void) | null = null
    let readyReject: ((error: Error) => void) | null = null
    const ready = new Promise<string>((resolveReady, rejectReady) => {
      readyResolve = resolveReady
      readyReject = rejectReady
    })
    const running = runner.run(RepositoryRoot, {
      cwd,
      command: ["bun", "run", "start:prepared"],
      timeoutMs: commandTimeoutMs,
      environment: {
        ...authorityToEnvironment(null),
        HOST: "127.0.0.1",
        PORT: String(port)
      },
      signal: commandController.signal,
      onStdout(value) {
        stdout += value
        const line = stdout.split("\n").find((candidate) => candidate.startsWith(readyPrefix))
        if (line === undefined || readyResolve === null) return
        try {
          const payload = JSON.parse(line.slice(readyPrefix.length)) as {
            readonly origin?: unknown
          }
          if (typeof payload.origin === "string") readyResolve(payload.origin)
          else readyReject?.(new Error(`${name} published an invalid origin`))
        } catch (error) {
          readyReject?.(new Error(`${name} published invalid readiness JSON`, { cause: error }))
        }
        readyResolve = null
        readyReject = null
      },
      onStderr(value) {
        stderr += value
      }
    })
    try {
      const origin = await timeout(
        Promise.race([
          ready,
          running.then((result) => {
            throw new Error(
              `${name} exited before readiness with ${result.termination} ${result.exitCode ?? result.signal ?? "unknown"}`
            )
          })
        ]),
        15_000,
        `${name} did not become ready`
      )
      const requestSignal =
        signal === undefined
          ? AbortSignal.timeout(3_000)
          : AbortSignal.any([signal, AbortSignal.timeout(3_000)])
      const response = await fetch(`${origin}/`, { signal: requestSignal })
      await response.arrayBuffer()
      if (response.status >= 500) throw new Error(`${name} returned HTTP ${response.status}`)

      commandController.abort(completedRequest)
      const commandResult = await running
      if (
        commandResult.termination !== "abort" ||
        commandResult.abortReason !== errorSummary(completedRequest)
      ) {
        throw new Error(
          `${name} did not stop for the completed request: ` +
            `${commandResult.termination} ${commandResult.abortReason ?? "without abort reason"}`
        )
      }
      if (commandResult.cleanupFailures.length > 0) {
        throw new Error(
          `${name} cleanup failed: ${commandResult.cleanupFailures
            .map((failure) => `${failure.code}: ${failure.summary}`)
            .join("; ")}`
        )
      }
      if (commandResult.residual !== "zero-observed") {
        throw new Error(`${name} process cleanup reported residual=${commandResult.residual}`)
      }
      if (!(await released(port))) throw new Error(`${name} left port ${port} open`)
    } finally {
      commandController.abort(completedRequest)
      await running.catch(() => {})
      signal?.removeEventListener("abort", forwardAbort)
    }
  } catch (error) {
    primary = new Error(
      `${error instanceof Error ? error.message : String(error)}\n${stdout}${stderr}`,
      {
        cause: error
      }
    )
  }
  if (ownedSupervisor !== null) {
    try {
      await ownedSupervisor.close()
    } catch (closeError) {
      if (primary === null) primary = closeError
      else
        throw new AggregateError(
          [primary, closeError],
          "example failed and supervisor close failed"
        )
    }
  }
  if (primary !== null) throw primary
}

if (import.meta.main) {
  const controller = new AbortController()
  const onSigint = () => controller.abort(new Error("example E2E interrupted by SIGINT"))
  const onSigterm = () => controller.abort(new Error("example E2E interrupted by SIGTERM"))
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    await runExample(process.cwd(), controller.signal)
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}
