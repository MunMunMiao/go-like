import { expect, test } from "bun:test"

import { withCancel, withoutCancel, type Context } from "@go-like/context"
import { newMemoryTransport } from "@go-like/transport-memory"

import type { Listener, ListenOption, Transport, TransportHandler } from "../src/index"
import { transportConformanceCases } from "../src/testing"

type BodyEvent = "delivery" | "chunk" | "end" | "error" | "cancel"
type Mutation = (handler: TransportHandler) => TransportHandler

const endsCase =
  "a Context derived from the handler Context is canceled when the Response body ends"
const activeCase =
  "the handler Context stays active while the Response body is unread or partly read"
const terminalEvents: readonly BodyEvent[] = ["end", "error", "cancel"]

/** Rebuilds response so emit sees its delivery, first chunk, and terminal event. */
function watchBody(response: Response, emit: (event: BodyEvent) => void): Response {
  emit("delivery")
  if (response.body === null) {
    emit("end")
    return response
  }
  const reader = response.body.getReader()
  let first = true
  const body = new ReadableStream<Uint8Array>(
    {
      /** Forwards one chunk and reports the first chunk, EOF, or a read error. */
      async pull(controller): Promise<void> {
        try {
          const next = await reader.read()
          if (next.done) {
            emit("end")
            controller.close()
            return
          }
          controller.enqueue(next.value)
          if (first) emit("chunk")
          first = false
        } catch (error) {
          emit("error")
          controller.error(error)
        }
      },
      /** Reports consumer cancellation and forwards it to the source. */
      cancel(reason): Promise<void> {
        emit("cancel")
        return reader.cancel(reason)
      }
    },
    { highWaterMark: 0 }
  )
  return new Response(body, { status: response.status, headers: response.headers })
}

/** Builds a hand-written Listener policy that cancels the handler Context on the listed events only. */
function cancelOn(events: readonly BodyEvent[]): Mutation {
  /** Runs the handler under a Context detached from the host Listener's own cancellation. */
  function mutate(handler: TransportHandler): TransportHandler {
    /** Serves one request with the event-driven Context. */
    async function detached(hostCtx: Context, request: Request): Promise<Response> {
      const [ctx, cancel] = withCancel(withoutCancel(hostCtx))
      const produced = await handler(ctx, request)
      return watchBody(produced, function emit(event): void {
        if (events.includes(event)) cancel()
      })
    }
    return detached
  }
  return mutate
}

/** Reports cancellation through err() but never aborts done(), so derived Contexts miss it. */
function silentDone(handler: TransportHandler): TransportHandler {
  const never = new AbortController().signal
  /** Serves one request with a Context whose signal stays quiet. */
  function silent(hostCtx: Context, request: Request): Response | Promise<Response> {
    return handler(
      Object.freeze({
        deadline: () => hostCtx.deadline(),
        done: () => never,
        err: () => hostCtx.err(),
        value: (key: unknown) => hostCtx.value(key)
      }),
      request
    )
  }
  return silent
}

/** Wraps the memory Transport so every served handler runs through mutate. */
function mutantTransport(mutate: Mutation): Transport {
  const memory = newMemoryTransport()
  return {
    init: memory.init,
    options: memory.options,
    dial: memory.dial,
    string: memory.string,
    /** Binds a memory Listener whose serve installs the mutated handler. */
    async listen(ctx: Context, address: string, ...options: readonly ListenOption[]) {
      const bound = await memory.listen(ctx, address, ...options)
      const listener: Listener = {
        addr: () => bound.addr(),
        close: (closeCtx) => bound.close(closeCtx),
        serve: (serveCtx, handler) => bound.serve(serveCtx, mutate(handler))
      }
      return listener
    }
  }
}

/** Runs one named conformance case against memory behind mutate. */
async function runCase(mutate: Mutation, name: string, observeOpenBody = true): Promise<void> {
  const cases = transportConformanceCases(() => mutantTransport(mutate), {
    listenAddress: "memory://mutant",
    faultHarness: null,
    operationTimeoutMs: 200,
    observeOpenBody
  })
  const entry = cases.find(function matches(item): boolean {
    return item.name === name
  })
  if (entry === undefined) throw new Error(`missing conformance case ${name}`)
  await entry.run()
}

for (const observeOpenBody of [true, false]) {
  test(`passes a Listener that cancels the handler Context exactly at body end (observeOpenBody ${observeOpenBody})`, async () => {
    await runCase(cancelOn(terminalEvents), endsCase, observeOpenBody)
    await runCase(cancelOn(terminalEvents), activeCase, observeOpenBody)
  })
}

test("does not require an observable open body to skip the cancel termination", async () => {
  await runCase(cancelOn(["end", "error"]), endsCase, false)
})

const mutants: readonly {
  readonly name: string
  readonly mutate: Mutation
  readonly caseName: string
  readonly message: string
  readonly observeOpenBody?: boolean
}[] = [
  {
    name: "never cancels the handler Context",
    mutate: cancelOn([]),
    caseName: endsCase,
    message: "a derived Context must be canceled when the Response body ends"
  },
  {
    name: "does not cancel it when the body ends",
    mutate: cancelOn(["error", "cancel"]),
    caseName: endsCase,
    message: "a derived Context must be canceled when the Response body ends"
  },
  {
    name: "does not cancel it when the body errors",
    mutate: cancelOn(["end", "cancel"]),
    caseName: endsCase,
    message: "a derived Context must be canceled when the Response body errors"
  },
  {
    name: "does not cancel it when the body is canceled",
    mutate: cancelOn(["end", "error"]),
    caseName: endsCase,
    message: "a derived Context must be canceled when the Response body is canceled"
  },
  {
    name: "cancels err() without aborting done() for derived Contexts",
    mutate: silentDone,
    caseName: endsCase,
    message: "a derived Context must be canceled when the Response body ends"
  },
  {
    name: "cancels the handler Context at delivery",
    mutate: cancelOn(["delivery", ...terminalEvents]),
    caseName: activeCase,
    message: "the handler Context must stay active while the Response body is unread"
  },
  {
    name: "cancels the handler Context at delivery when open bodies are not observable",
    mutate: cancelOn(["delivery", ...terminalEvents]),
    caseName: activeCase,
    message: "the handler Context must stay active while the Response body is produced",
    observeOpenBody: false
  },
  {
    name: "cancels the handler Context when the first chunk is read",
    mutate: cancelOn(["chunk", ...terminalEvents]),
    caseName: activeCase,
    message: "the handler Context must stay active while the Response body is partly read"
  },
  {
    name: "cancels the handler Context when the first chunk is read and open bodies are not observable",
    mutate: cancelOn(["chunk", ...terminalEvents]),
    caseName: activeCase,
    message: "the handler Context must stay active while the Response body is produced",
    observeOpenBody: false
  }
]

for (const mutant of mutants) {
  test(`fails a Listener that ${mutant.name}`, async () => {
    await expect(runCase(mutant.mutate, mutant.caseName, mutant.observeOpenBody)).rejects.toThrow(
      mutant.message
    )
  })
}
