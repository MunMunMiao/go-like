import { expect, test } from "bun:test"

import { background } from "../../src/context"
import { LogEvent, LogField, withTelemetry } from "../../src/telemetry"
import { newTelemetryRecorder } from "../../src/testing"
import { executor, newHTTPTransport, type HTTPExecutor } from "../../src/transport/http"
import { dispatchHTTPHostRequest } from "../../src/transport/http/socket"

const secret = "secret-transport-detail"

/** Completes a callable executor with the optional preconnect static. */
function httpExecutor(run: HTTPExecutor): HTTPExecutor {
  return Object.assign(run, {
    /** Present so a runtime that probes the static does not change the record. */
    preconnect(): void {}
  })
}

/** Builds one request for the portable dial target. */
function request(path: string, body?: string): Request {
  const init: RequestInit = { method: "POST" }
  if (body !== undefined) init.body = body
  return new Request(`http://example.test:8080${path}`, init)
}

test("a successful HTTP handler and client close record no transport diagnostic", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const response = await dispatchHTTPHostRequest(
    traced,
    function succeed(): Response {
      return new Response("ok")
    },
    {
      request: new Request("http://127.0.0.1/rpc", { method: "POST" }),
      localAddress: "",
      remoteAddress: ""
    }
  )
  expect(response.status).toBe(200)
  await response.text()
  const transport = newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(new Response(null, { status: 204 }))
      })
    )
  )
  const client = await transport.dial(traced, "example.test:8080")
  await client.fetch(traced, request("/orders/Create"))
  await client.close(traced)
  expect(recorder.logs()).toEqual([])
  expect(recorder.spans()).toEqual([])
  expect(recorder.measurements()).toEqual([])
})

test("handler rejection records the fixed message and the local exception", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const failure = new Error(secret)
  const response = await dispatchHTTPHostRequest(
    traced,
    function fail(): never {
      throw failure
    },
    {
      request: new Request("http://127.0.0.1/rpc", { method: "POST" }),
      localAddress: "",
      remoteAddress: ""
    }
  )
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain(secret)
  const logged = recorder
    .logs()
    .filter((item) => item.record.event === LogEvent.transportHandlerRejected)
  expect(logged).toHaveLength(1)
  expect(logged[0]?.record.level).toBe("error")
  expect(logged[0]?.record.message).toBe("HTTP transport handler rejected")
  expect(logged[0]?.record.message).not.toContain(secret)
  expect(logged[0]?.record.attrs[LogField.exception]).toBe(failure)
  expect(recorder.measurements()).toEqual([])
  expect(recorder.spans()).toEqual([])
})

test("response cleanup failure records the fixed message and the local exception", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const cleanup = new Error(secret)
  const transport = newHTTPTransport(
    executor(
      httpExecutor(function run(): Promise<Response> {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(): void {},
              cancel(): Promise<void> {
                return Promise.reject(cleanup)
              }
            })
          )
        )
      })
    )
  )
  const client = await transport.dial(traced, "example.test:8080")
  await client.fetch(traced, request("/orders/Create", "x"))
  await expect(client.close(traced)).resolves.toBeUndefined()
  const logged = recorder
    .logs()
    .filter((item) => item.record.event === LogEvent.transportCleanupFailed)
  expect(logged).toHaveLength(1)
  expect(logged[0]?.record.level).toBe("error")
  expect(logged[0]?.record.message).toBe("HTTP client response cleanup failed")
  expect(logged[0]?.record.message).not.toContain(secret)
  expect(logged[0]?.record.attrs[LogField.exception]).toBe(cleanup)
  expect(recorder.measurements()).toEqual([])
  expect(recorder.spans()).toEqual([])
})

test("transport diagnostics produce no recorder record when telemetry is not installed", async () => {
  const recorder = newTelemetryRecorder()
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(" "))
  }
  try {
    const response = await dispatchHTTPHostRequest(
      background(),
      function fail(): never {
        throw new Error(secret)
      },
      {
        request: new Request("http://127.0.0.1/rpc", { method: "POST" }),
        localAddress: "",
        remoteAddress: ""
      }
    )
    await response.text()
    const transport = newHTTPTransport(
      executor(
        httpExecutor(function run(): Promise<Response> {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(): void {},
                cancel(): Promise<void> {
                  return Promise.reject(new Error(secret))
                }
              })
            )
          )
        })
      )
    )
    const client = await transport.dial(background(), "example.test:8080")
    await client.fetch(background(), request("/orders/Create", "x"))
    await client.close(background())
    expect(recorder.logs()).toEqual([])
    expect(recorder.spans()).toEqual([])
    expect(recorder.measurements()).toEqual([])
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, string>)
    expect(parsed).toEqual([
      {
        "event.name": LogEvent.transportHandlerRejected,
        "error.type": "Error",
        "go_like.operation": "_OTHER"
      },
      {
        "event.name": LogEvent.transportCleanupFailed,
        "error.type": "Error",
        "go_like.operation": "_OTHER"
      }
    ])
    expect(lines.join("\n")).not.toContain(secret)
  } finally {
    console.error = original
  }
})
