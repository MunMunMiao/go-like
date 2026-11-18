import { expect, test } from "bun:test"

import { background, canceled, cause } from "../../src/context"
import { newTelemetry, withTelemetry } from "../../src/telemetry"
import { newTelemetryRecorder } from "../../src/testing"
import { requestContext } from "../../src/web"
import { serveWebRequest } from "../../src/web/serve"

const encoder = new TextEncoder()

/** Builds telemetry that records, and ignores only /skip. */
function recording(ignore = true) {
  const recorder = newTelemetryRecorder()
  const telemetry = newTelemetry({
    tracerProvider: recorder.tracerProvider,
    meterProviders: [recorder.meterProvider],
    logHandlers: [recorder.logHandler],
    completionLogs: "all",
    ignoreRequest(request: Request): boolean {
      return ignore && new URL(request.url).pathname === "/skip"
    }
  })
  return { recorder, ctx: withTelemetry(background(), telemetry) }
}

/** A body whose first pull requires the host Context to still be active. */
function dependentBody(request: Request, text: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller): void {
        const bound = requestContext(request)
        if (bound === null || bound.err() !== null) {
          controller.error(bound?.err() ?? new Error("missing request context"))
          return
        }
        controller.enqueue(encoder.encode(text))
        controller.close()
      }
    })
  )
}

test("serves an ignored request without a unit and still binds its context", async () => {
  const telemetry = newTelemetry({ ignoreRequest: () => true })
  const ctx = withTelemetry(background(), telemetry)
  const response = serveWebRequest(
    ctx,
    () => new Response("plain"),
    new Request("http://localhost/skip")
  )
  expect(response).toBeInstanceOf(Response)
  expect(await (response as Response).text()).toBe("plain")

  const failed = serveWebRequest(
    ctx,
    () => Promise.reject(new Error("handler failed")),
    new Request("http://localhost/skip")
  )
  await expect(failed).rejects.toThrow("handler failed")
  const throwing = newTelemetry({
    ignoreRequest() {
      throw new Error("predicate failed")
    }
  })
  const answered = serveWebRequest(
    withTelemetry(background(), throwing),
    () => new Response("still"),
    new Request("http://localhost/skip")
  )
  expect(await (answered as Response).text()).toBe("still")

  const asyncPlain = serveWebRequest(
    ctx,
    () => Promise.resolve(new Response("later")),
    new Request("http://localhost/skip")
  )
  expect(await (await asyncPlain).text()).toBe("later")

  expect(() =>
    serveWebRequest(
      ctx,
      () => {
        throw new Error("sync")
      },
      new Request("http://localhost/skip")
    )
  ).toThrow("sync")
})

test("an ignored stream keeps its Context until the body ends and records nothing", async () => {
  for (const asyncHandler of [false, true]) {
    const { recorder, ctx } = recording()
    const request = new Request("http://localhost/skip")
    const produce = (): Response => dependentBody(request, "ok")
    const response = serveWebRequest(
      ctx,
      asyncHandler ? () => Promise.resolve(produce()) : produce,
      request
    )
    expect(await (await response).text()).toBe("ok")
    expect(requestContext(request)?.err()).toBe(canceled)
    expect(recorder.spans()).toEqual([])
    expect(recorder.logs()).toEqual([])
    expect(recorder.measurements()).toEqual([])
  }
})

test("a recorded stream keeps its Context until the body ends and then records the unit", async () => {
  const { recorder, ctx } = recording(false)
  const request = new Request("http://localhost/keep")
  const response = serveWebRequest(ctx, () => dependentBody(request, "kept"), request)
  expect(await (response as Response).text()).toBe("kept")
  expect(requestContext(request)?.err()).toBe(canceled)
  expect(recorder.spans().map((span) => span.name)).toEqual(["GET"])
  expect(recorder.logs()).toHaveLength(1)
})

test.each([
  [false, "end"],
  [true, "end"],
  [false, "error"],
  [true, "error"]
] as const)(
  "keeps Web SSE open for ordinary events: ignored=%s event=%s",
  async (ignored, event) => {
    const { ctx, recorder } = recording(ignored)
    const request = new Request("http://localhost/skip")
    const frames = [
      `event: ${event}\ndata: ordinary-web-event\n\n`,
      "data: later-payload\n\n"
    ] as const
    let index = 0
    const response = await serveWebRequest(
      ctx,
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                const frame = frames[index++]
                if (frame === undefined) controller.close()
                else controller.enqueue(encoder.encode(frame))
              }
            },
            { highWaterMark: 0 }
          ),
          { headers: { "content-type": "text/event-stream" } }
        ),
      request
    )
    const reader = response.body!.getReader()
    try {
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toBe(frames[0])
      expect(requestContext(request)?.err()).toBeNull()
      const second = await reader.read()
      expect(new TextDecoder().decode(second.value)).toBe(frames[1])
      expect(requestContext(request)?.err()).toBeNull()
      expect((await reader.read()).done).toBe(true)
      expect(requestContext(request)?.err()).toBe(canceled)
      if (ignored) {
        expect(recorder.spans()).toEqual([])
        expect(recorder.logs()).toEqual([])
        expect(recorder.measurements()).toEqual([])
      } else {
        expect(recorder.spans()).toHaveLength(1)
        expect(recorder.spans()[0]?.attributes["go_like.outcome"]).toBe("success")
      }
    } finally {
      await reader.cancel()
    }
  }
)

test("ignored null bodies and handler failures cancel without a unit", async () => {
  const { recorder, ctx } = recording()
  const empty = new Request("http://localhost/skip")
  const response = serveWebRequest(ctx, () => new Response(null, { status: 204 }), empty)
  expect((response as Response).status).toBe(204)
  expect(requestContext(empty)?.err()).toBe(canceled)

  const thrown = new Request("http://localhost/skip")
  expect(() =>
    serveWebRequest(
      ctx,
      () => {
        throw new Error("sync")
      },
      thrown
    )
  ).toThrow("sync")
  expect(requestContext(thrown)?.err()).toBe(canceled)

  const rejected = new Request("http://localhost/skip")
  await expect(
    serveWebRequest(ctx, () => Promise.reject(new Error("handler failed")), rejected)
  ).rejects.toThrow("handler failed")
  expect(requestContext(rejected)?.err()).toBe(canceled)
  expect(recorder.spans()).toEqual([])
})

test("an ignored body failure or cancel ends the Context once", async () => {
  const { ctx } = recording()
  const failed = new Request("http://localhost/skip")
  const broken = serveWebRequest(
    ctx,
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            const bound = requestContext(failed)
            if (bound === null || bound.err() !== null) {
              controller.error(bound?.err() ?? new Error("missing request context"))
              return
            }
            controller.error(new Error("broke"))
          }
        })
      ),
    failed
  )
  await expect((broken as Response).text()).rejects.toThrow("broke")
  expect(requestContext(failed)?.err()).toBe(canceled)

  const stopped = new Request("http://localhost/skip")
  let release = function unblock(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  try {
    const response = serveWebRequest(
      ctx,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(): Promise<void> {
              const bound = requestContext(stopped)
              if (bound === null || bound.err() !== null) {
                throw bound?.err() ?? new Error("missing request context")
              }
              await gate
            }
          })
        ),
      stopped
    )
    const reader = (response as Response).body?.getReader()
    if (reader === undefined) throw new Error("missing body")
    const pending = reader.read()
    expect(requestContext(stopped)?.err()).toBeNull()
    await reader.cancel(new Error("stop"))
    await pending.catch(function ignore(): void {})
    expect(requestContext(stopped)?.err()).toBe(canceled)
  } finally {
    release()
  }
})

test("aborting an ignored request ends its Context and a later abort does not replace the cause", async () => {
  const { ctx } = recording()
  const controller = new AbortController()
  const request = new Request("http://localhost/skip", { signal: controller.signal })
  let release = function unblock(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const reason = new Error("gone")
  try {
    const response = serveWebRequest(
      ctx,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(): Promise<void> {
              const bound = requestContext(request)
              if (bound === null || bound.err() !== null) {
                throw bound?.err() ?? new Error("missing request context")
              }
              await gate
            }
          })
        ),
      request
    )
    const reader = (response as Response).body?.getReader()
    if (reader === undefined) throw new Error("missing body")
    const pending = reader.read()
    expect(requestContext(request)?.err()).toBeNull()
    controller.abort(reason)
    await pending.catch(function ignore(): void {})
    expect(requestContext(request)?.err()).toBe(canceled)
    expect(cause(requestContext(request) ?? background())).toBe(reason)
    controller.abort(new Error("later"))
    expect(cause(requestContext(request) ?? background())).toBe(reason)
  } finally {
    release()
  }
})

test("recorded handler failures cancel the request context after the unit is classified", async () => {
  const { ctx } = recording(false)
  const thrown = new Request("http://localhost/keep")
  expect(() =>
    serveWebRequest(
      ctx,
      () => {
        throw new Error("sync")
      },
      thrown
    )
  ).toThrow("sync")
  expect(requestContext(thrown)?.err()).toBe(canceled)

  const rejected = new Request("http://localhost/keep")
  await expect(
    serveWebRequest(ctx, () => Promise.reject(new Error("later")), rejected)
  ).rejects.toThrow("later")
  expect(requestContext(rejected)?.err()).toBe(canceled)

  const invalid = new Request("http://localhost/skip")
  const { ctx: ignored } = recording()
  expect(serveWebRequest(ignored, () => "no" as never, invalid) as unknown).toBe("no")
  expect(requestContext(invalid)?.err()).toBe(canceled)
})

test("keeps an unparsable URL on http and cancels an already aborted request", async () => {
  const broken = serveWebRequest(background(), () => new Response("ok"), {
    url: "http://[",
    method: "GET",
    headers: new Headers(),
    signal: new AbortController().signal
  } as Request)
  expect((broken as Response).status).toBe(200)

  const controller = new AbortController()
  controller.abort(new Error("gone"))
  const aborted = serveWebRequest(
    background(),
    () => new Response(null, { status: 204 }),
    new Request("http://localhost/aborted", { signal: controller.signal })
  )
  expect((aborted as Response).status).toBe(204)

  const text = new AbortController()
  text.abort("stop")
  const nonError = serveWebRequest(
    background(),
    () => new Response(null, { status: 204 }),
    new Request("http://localhost/text", { signal: text.signal })
  )
  expect((nonError as Response).status).toBe(204)
})
