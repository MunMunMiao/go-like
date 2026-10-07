import type { Context } from "@go-like/context"
import { struct } from "@go-like/struct"

import {
  defineService,
  type ServerStream,
  type ServiceClient,
  type ServiceHandler,
  type ServiceServer
} from "../src/index"

const request = struct.object({ value: struct.number() })
const response = struct.object({ value: struct.number() })
const payment = defineService("payments.v1", {
  add: { request, response },
  health: { response },
  watch: { request, response, stream: true },
  ping: { response, stream: true }
})

declare const ctx: Context
declare const conn: {
  call(...args: readonly unknown[]): Promise<unknown>
}

const handler: ServiceHandler<typeof payment> = {
  add(_ctx, value) {
    const typed: number = value.value
    return { value: typed }
  },
  health(_ctx) {
    return { value: 1 }
  },
  async *watch(_ctx, value) {
    yield { value: value.value }
  },
  async *ping(_ctx) {
    yield { value: 1 }
  }
}

const accepting: ServiceServer = {
  registerHandlers(): void {}
}
payment.registerHandler(accepting, handler)
const client: ServiceClient<typeof payment> = payment.newClient(conn)
const added: Promise<{ value: number }> = client.add(ctx, { value: 1 })
const healthy: Promise<{ value: number }> = client.health(ctx)
const watched: Promise<ServerStream<{ value: number }>> = client.watch(ctx, { value: 1 })
const pinged: Promise<ServerStream<{ value: number }>> = client.ping(ctx)
const unaryStream: false = payment.endpoints.add.stream
const omittedStream: false = payment.endpoints.health.stream
const watchStream: true = payment.endpoints.watch.stream
const pingStream: true = payment.endpoints.ping.stream

declare const events: ServerStream<{ value: number }>
const next: Promise<IteratorResult<{ value: number }>> = events[Symbol.asyncIterator]().next()
const closing: Promise<void> = events.close()
const disposing: Promise<void> = events[Symbol.asyncDispose]()

void [
  handler,
  added,
  healthy,
  watched,
  pinged,
  unaryStream,
  omittedStream,
  watchStream,
  pingStream,
  next,
  closing,
  disposing
]

// @ts-expect-error Missing service method.
const missing: ServiceHandler<typeof payment> = {
  add: () => ({ value: 1 }),
  health: () => ({ value: 1 }),
  async *watch() {
    yield { value: 1 }
  }
}
void missing

// @ts-expect-error Service registration requires registerHandlers.
payment.registerHandler({}, handler)

const extra: ServiceHandler<typeof payment> = {
  add: () => ({ value: 1 }),
  health: () => ({ value: 1 }),
  async *watch() {
    yield { value: 1 }
  },
  async *ping() {
    yield { value: 1 }
  },
  // @ts-expect-error Extra service method.
  other: () => ({ value: 1 })
}
void extra

// @ts-expect-error Request must match the request Struct.
client.add(ctx, { value: "1" })
// @ts-expect-error Omitted request does not accept a request object.
client.health(ctx, { value: 1 })
// @ts-expect-error Stream call requires the request value.
client.watch(ctx)
// @ts-expect-error Stream request must match the request Struct.
client.watch(ctx, { value: "1" })
// @ts-expect-error Omitted stream request does not accept a request object.
client.ping(ctx, { value: 1 })

const badResponse: ServiceHandler<typeof payment> = {
  // @ts-expect-error Handler response must match the response Struct.
  add: () => ({ value: "bad" }),
  health: () => ({ value: 1 }),
  async *watch() {
    yield { value: 1 }
  },
  async *ping() {
    yield { value: 1 }
  }
}
void badResponse

const badStream: ServiceHandler<typeof payment> = {
  add: () => ({ value: 1 }),
  health: () => ({ value: 1 }),
  // @ts-expect-error Stream handler must return an AsyncIterable.
  watch: () => ({ value: 1 }),
  async *ping() {
    yield { value: 1 }
  }
}
void badStream

defineService("payments.v1", {
  add: {
    request,
    response,
    // @ts-expect-error stream must be true or omitted.
    stream: false
  }
})

defineService("payments.v1", {
  // @ts-expect-error Endpoint declarations only allow request, response, and stream.
  add: { request, response, extra: true }
})

defineService("payments.v1", {
  // @ts-expect-error Every endpoint requires a response Struct.
  add: { request }
})

// @ts-expect-error ServerStream requires close.
const incomplete: ServerStream<number> = {
  async *[Symbol.asyncIterator]() {
    yield 1
  },
  async [Symbol.asyncDispose]() {}
}
void incomplete
