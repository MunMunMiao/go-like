import { createConnection, createServer } from "node:net"

const readyPrefix = "LIKEGO_EXAMPLE_READY="

interface Capture {
  readonly done: Promise<void>
  readonly cancel: () => Promise<void>
}

function timeout<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") reject(new Error("no loopback port"))
      else resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  )
  return port
}

function sendSignal(child: Bun.Subprocess, value: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync([
        "taskkill",
        "/PID",
        String(child.pid),
        "/T",
        ...(value === "SIGKILL" ? ["/F"] : [])
      ])
    } else process.kill(-child.pid, value)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
  }
}

function processGroupExists(child: Bun.Subprocess): boolean {
  if (process.platform === "win32") return child.exitCode === null
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

async function stopProcessTree(child: Bun.Subprocess, graceMs: number): Promise<void> {
  sendSignal(child, "SIGTERM")
  const deadline = performance.now() + graceMs
  while (processGroupExists(child) && performance.now() < deadline) await Bun.sleep(25)
  if (processGroupExists(child)) sendSignal(child, "SIGKILL")
  await timeout(child.exited, 1_000, "example process tree did not exit")
}

async function released(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port })
      let settled = false
      const finish = (value = false) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
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

function capture(stream: ReadableStream<Uint8Array>, append: (value: string) => void): Capture {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        append(decoder.decode(chunk.value, { stream: true }))
      }
      append(decoder.decode())
    } finally {
      reader.releaseLock()
    }
  })()
  return Object.freeze({ done, cancel: () => reader.cancel() })
}

export async function runExample(cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const name = String((await Bun.file(`${cwd}/package.json`).json()).name)
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
  let readyResolve: ((origin: string) => void) | null = null
  let readyReject: ((error: Error) => void) | null = null
  let abortReject: ((error: unknown) => void) | null = null
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    abortReject = reject
  })
  const onAbort = () => abortReject?.(signal?.reason)
  signal?.addEventListener("abort", onAbort, { once: true })
  const stdoutCapture = capture(child.stdout, (value) => {
    stdout += value
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(readyPrefix))
    if (line === undefined || readyResolve === null) return
    try {
      const payload = JSON.parse(line.slice(readyPrefix.length)) as { readonly origin?: unknown }
      if (typeof payload.origin === "string") readyResolve(payload.origin)
      else readyReject?.(new Error(`${name} published an invalid origin`))
    } catch (error) {
      readyReject?.(new Error(`${name} published invalid readiness JSON`, { cause: error }))
    }
    readyResolve = null
    readyReject = null
  })
  const stderrCapture = capture(child.stderr, (value) => {
    stderr += value
  })
  try {
    const origin = await timeout(
      Promise.race([
        ready,
        aborted,
        child.exited.then((code) => {
          throw new Error(`${name} exited before readiness with code ${code}`)
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

    await stopProcessTree(child, 5_000)
    if (!(await released(port))) throw new Error(`${name} left port ${port} open`)
    await timeout(
      Promise.all([stdoutCapture.done, stderrCapture.done]),
      2_000,
      `${name} left inherited output pipes open`
    )
  } catch (error) {
    await stopProcessTree(child, 0).catch(() => sendSignal(child, "SIGKILL"))
    const drained = Promise.allSettled([child.exited, stdoutCapture.done, stderrCapture.done])
    await timeout(drained, 2_000, `${name} output drain timed out`).catch(async () => {
      await Promise.allSettled([stdoutCapture.cancel(), stderrCapture.cancel()])
      await Promise.allSettled([stdoutCapture.done, stderrCapture.done])
    })
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stdout}${stderr}`)
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
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
