import { expect, test } from "bun:test"

import { createAdaptorServer, type ServerType } from "../../../src/web/node-fetch-bridge"
import { serveWebRequest } from "../../../src/web/serve"
import { background } from "../../../src/context"
import { LogEvent, LogField, withTelemetry } from "../../../src/telemetry"
import { newTelemetryRecorder, type TelemetryRecorder } from "../../../src/testing"

const secret = "secret-response-detail"

/** Binds one unlistened bridge and returns its port. */
async function listen(server: ServerType): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("bridge server did not bind a TCP address")
  }
  return address.port
}

/** Closes one bridge after the test, including when the assertion throws. */
async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error instanceof Error) reject(error)
      else resolve()
    })
  })
}

/** Reads one response. A destroyed socket is the bridge's response-failure path. */
async function read(port: number, path: string): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    await response.arrayBuffer()
  } catch {
    // handleResponseError destroys the socket after logging the failure.
  }
}

/** A stream the bridge writes, then fails while the host Request still carries telemetry. */
function failingStream(premature: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode("first"))
    },
    pull(controller): void {
      const error = new Error(secret)
      if (premature) Object.assign(error, { code: "ERR_STREAM_PREMATURE_CLOSE" })
      controller.error(error)
    }
  })
}

/** Serves one host request through the Node bridge. */
function host(
  recorder: TelemetryRecorder | null,
  stream: ReadableStream<Uint8Array> | null
): ServerType {
  const ctx = recorder === null ? background() : withTelemetry(background(), recorder.telemetry)
  return createAdaptorServer({
    hostname: "127.0.0.1",
    fetch(request: Request): Response | Promise<Response> {
      return serveWebRequest(
        ctx,
        () => {
          if (stream === null) return new Response("ok")
          return new Response(stream, { headers: { "transfer-encoding": "chunked" } })
        },
        request
      )
    }
  })
}

test("a successful Node web response records neither host diagnostic", async () => {
  const recorder = newTelemetryRecorder()
  const server = host(recorder, null)
  try {
    const port = await listen(server)
    const response = await fetch(`http://127.0.0.1:${port}/ok`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(
      recorder.logs().some((item) => item.record.event === LogEvent.webHostClientAborted)
    ).toBe(false)
    expect(
      recorder.logs().some((item) => item.record.event === LogEvent.webHostResponseFailed)
    ).toBe(false)
    expect(recorder.measurements().some((item) => item.descriptor.name.includes("web.host"))).toBe(
      false
    )
  } finally {
    await closeServer(server)
  }
})

test("a premature response close records client_aborted and a write failure records response_failed", async () => {
  const recorder = newTelemetryRecorder()
  const aborted = host(recorder, failingStream(true))
  try {
    const port = await listen(aborted)
    await read(port, "/aborted")
    const logged = recorder
      .logs()
      .filter((item) => item.record.event === LogEvent.webHostClientAborted)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.record.level).toBe("info")
    expect(logged[0]?.record.message).toBe("web host client aborted")
    expect(logged[0]?.record.message).not.toContain(secret)
    expect(logged[0]?.record.attrs[LogField.exception]).toBeInstanceOf(Error)
    expect(
      recorder.logs().some((item) => item.record.event === LogEvent.webHostResponseFailed)
    ).toBe(false)
  } finally {
    await closeServer(aborted)
  }

  recorder.reset()
  const failed = host(recorder, failingStream(false))
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(" "))
  }
  try {
    const port = await listen(failed)
    await read(port, "/failed")
    const logged = recorder
      .logs()
      .filter((item) => item.record.event === LogEvent.webHostResponseFailed)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.record.level).toBe("error")
    expect(logged[0]?.record.message).toBe("web host response failed")
    expect(logged[0]?.record.message).not.toContain(secret)
    expect(logged[0]?.record.attrs[LogField.exception]).toBeInstanceOf(Error)
    expect(lines.join("\n")).not.toContain(secret)
    expect(lines.join("\n")).not.toContain(LogEvent.webHostResponseFailed)
  } finally {
    console.error = original
    await closeServer(failed)
  }
})

test("Node web host diagnostics produce no recorder record when telemetry is not installed", async () => {
  const recorder = newTelemetryRecorder()
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(" "))
  }
  const aborted = host(null, failingStream(true))
  try {
    const port = await listen(aborted)
    await read(port, "/aborted")
    expect(recorder.logs()).toEqual([])
    expect(recorder.spans()).toEqual([])
    expect(recorder.measurements()).toEqual([])
    expect(lines.join("\n")).not.toContain(LogEvent.webHostClientAborted)
    expect(lines.join("\n")).not.toContain(secret)
  } finally {
    console.error = original
    await closeServer(aborted)
  }

  const fallback: string[] = []
  console.error = (...args: unknown[]): void => {
    fallback.push(args.map((item) => String(item)).join(" "))
  }
  const failed = host(null, failingStream(false))
  try {
    const port = await listen(failed)
    await read(port, "/failed")
    const line = fallback.find((item) => item.includes(LogEvent.webHostResponseFailed))
    if (line === undefined) throw new Error("missing response_failed fallback")
    expect(JSON.parse(line)).toEqual({
      "event.name": LogEvent.webHostResponseFailed,
      "error.type": "Error",
      "go_like.operation": "_OTHER"
    })
    expect(line).not.toContain(secret)
    expect(recorder.logs()).toEqual([])
    expect(recorder.spans()).toEqual([])
    expect(recorder.measurements()).toEqual([])
  } finally {
    console.error = original
    await closeServer(failed)
  }
})
