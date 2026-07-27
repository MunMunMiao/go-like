import { EventEmitter } from "node:events"
import {
  Agent as HTTPAgent,
  createServer as createHTTPServer,
  type ClientRequest,
  type IncomingMessage
} from "node:http"
import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  IncomingHttpHeaders,
  OutgoingHttpHeaders
} from "node:http2"
import type { Socket } from "node:net"
import { TLSSocket } from "node:tls"
import { runInNewContext } from "node:vm"

import { expect, test } from "bun:test"

import { normalizeHTTPDialTarget } from "../src/address"
import {
  executeNodeHTTP1,
  executeNodeHTTP2,
  newNodeHTTPExecutor,
  type NodeHTTPClientRuntime
} from "../src/node-client"
import { applyHTTPDialOptions, defaultHTTPCommonOptions } from "../src/options"

interface ResourceState {
  destroyed: boolean
}

interface FakeTLSHandle {
  readonly socket: TLSSocket
  secure(): void
}

interface FakePooledHTTP2 {
  readonly session: ClientHttp2Session
  readonly requestCount: number
  emit(event: string, ...values: readonly unknown[]): void
}

interface FakeStreamingHTTP1Response {
  readonly response: IncomingMessage
  readonly destroyCalls: number
  emit(event: string, ...values: readonly unknown[]): void
  listenerCount(event: string): number
}

/** Returns one Promise rejection without imposing runtime-specific Error branding. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
    return null
  } catch (error) {
    return error
  }
}

/** Creates one inert TLS identity whose destruction is observable. */
function fakeTLSSocket(state: ResourceState): TLSSocket {
  const socket: TLSSocket = Object.create(TLSSocket.prototype)
  Object.defineProperties(socket, {
    destroyed: {
      get(): boolean {
        return state.destroyed
      }
    },
    destroy: {
      value(): TLSSocket {
        state.destroyed = true
        return socket
      }
    }
  })
  return socket
}

/** Creates one event-capable TLS socket for deterministic owner handshakes. */
function eventTLSSocket(protocol: string): FakeTLSHandle {
  const socket = new EventEmitter()
  let destroyed = false
  Object.defineProperties(socket, {
    alpnProtocol: { value: protocol },
    destroyed: {
      get(): boolean {
        return destroyed
      }
    },
    destroy: {
      value(): EventEmitter {
        if (destroyed) return socket
        destroyed = true
        socket.emit("close")
        return socket
      }
    }
  })
  return Object.freeze({
    socket: socket as unknown as TLSSocket,
    secure(): void {
      socket.emit("secureConnect")
    }
  })
}

/** Creates one observable fake socket suitable for HTTP Agent inventories. */
function agentSocket(initiallyDestroyed: boolean): Socket {
  const socket = new EventEmitter()
  let destroyed = initiallyDestroyed
  Object.defineProperties(socket, {
    destroyed: {
      get(): boolean {
        return destroyed
      }
    },
    destroy: {
      value(): EventEmitter {
        if (destroyed) return socket
        destroyed = true
        socket.emit("close")
        return socket
      }
    }
  })
  return socket as unknown as Socket
}

/** Creates one deterministic HTTP/1 request that fails from end. */
function failingHTTP1Request(): ClientRequest {
  const request = new EventEmitter()
  let destroyed = false
  Object.defineProperties(request, {
    destroyed: {
      get(): boolean {
        return destroyed
      }
    },
    end: {
      value(): void {
        request.emit("error", new Error("deterministic HTTP/1 failure"))
      }
    },
    destroy: {
      value(): EventEmitter {
        destroyed = true
        return request
      }
    }
  })
  return request as unknown as ClientRequest
}

/** Creates one runtime around supplied deterministic TLS and HTTP/2 constructors. */
function ownerRuntime(
  agent: HTTPAgent,
  connectTLS: NodeHTTPClientRuntime["connectTLS"],
  connectHTTP2: NodeHTTPClientRuntime["connectHTTP2"],
  requestHTTP: NodeHTTPClientRuntime["requestHTTP"] = failingHTTP1Request
): NodeHTTPClientRuntime {
  return Object.freeze({
    newHTTPAgent(): HTTPAgent {
      return agent
    },
    connectTLS,
    connectHTTP2,
    requestHTTP
  })
}

/** Creates one event-capable reusable HTTP/2 session. */
function pooledHTTP2Session(
  status: number,
  requestFailure: Error | null = null,
  closeFailure: Error | null = null,
  goawayDuringResponse = false,
  holdClose = false
): FakePooledHTTP2 {
  const session = new EventEmitter()
  let destroyed = false
  let closed = false
  let requests = 0
  Object.defineProperties(session, {
    destroyed: {
      get(): boolean {
        return destroyed
      }
    },
    closed: {
      get(): boolean {
        return closed
      }
    },
    request: {
      value(): ClientHttp2Stream {
        requests += 1
        if (requestFailure !== null) throw requestFailure
        const stream = new EventEmitter()
        let streamDestroyed = false
        Object.defineProperties(stream, {
          destroyed: {
            get(): boolean {
              return streamDestroyed
            }
          },
          pause: { value(): void {} },
          resume: { value(): void {} },
          destroy: {
            value(): EventEmitter {
              if (streamDestroyed) return stream
              streamDestroyed = true
              stream.emit("close")
              return stream
            }
          },
          end: {
            value(): void {
              const headers: IncomingHttpHeaders = Object.create(null)
              Object.defineProperty(headers, ":status", { value: status })
              stream.emit("response", headers)
              if (goawayDuringResponse) session.emit("goaway")
              if (status <= 599) {
                stream.emit("data", Buffer.from("ok"))
                stream.emit("end")
              }
            }
          }
        })
        return stream as unknown as ClientHttp2Stream
      }
    },
    close: {
      value(): void {
        if (closeFailure !== null) throw closeFailure
      }
    },
    destroy: {
      value(): void {
        if (destroyed) return
        destroyed = true
        if (!holdClose) {
          closed = true
          session.emit("close")
        }
      }
    }
  })
  return {
    session: session as unknown as ClientHttp2Session,
    get requestCount(): number {
      return requests
    },
    emit(event: string, ...values: readonly unknown[]): void {
      Reflect.apply(session.emit, session, [event, ...values])
    }
  }
}

/** Creates one inert HTTP/1 response suitable for bodyless and invalid-status paths. */
function fakeHTTP1Response(status: number, state: ResourceState): IncomingMessage {
  const response: IncomingMessage = Object.create(null)
  Object.defineProperties(response, {
    statusCode: { value: status },
    statusMessage: { value: "" },
    headers: { value: Object.freeze({}) },
    destroyed: {
      get(): boolean {
        return state.destroyed
      }
    },
    on: {
      value(): IncomingMessage {
        return response
      }
    },
    once: {
      value(): IncomingMessage {
        return response
      }
    },
    off: {
      value(): IncomingMessage {
        return response
      }
    },
    pause: {
      value(): IncomingMessage {
        return response
      }
    },
    resume: {
      value(): IncomingMessage {
        return response
      }
    },
    destroy: {
      value(): IncomingMessage {
        state.destroyed = true
        return response
      }
    }
  })
  return response
}

/** Creates one controllable HTTP/1 response with observable listener cleanup. */
function fakeStreamingHTTP1Response(status = 200): FakeStreamingHTTP1Response {
  const listeners = new Map<string, Set<(...values: readonly unknown[]) => void>>()
  const once = new Map<string, Set<(...values: readonly unknown[]) => void>>()
  let destroyed = false
  let destroyCalls = 0
  const response: IncomingMessage = Object.create(null)
  /** Adds one native response observer. */
  function add(event: string, listener: (...values: readonly unknown[]) => void): void {
    const selected = listeners.get(event) ?? new Set()
    selected.add(listener)
    listeners.set(event, selected)
  }
  /** Publishes one native response event to a stable observer snapshot. */
  function emit(event: string, ...values: readonly unknown[]): void {
    const selected = listeners.get(event)
    if (selected === undefined) return
    const singleUse = once.get(event)
    for (const listener of Array.from(selected)) {
      if (singleUse?.has(listener) === true) {
        selected.delete(listener)
        singleUse.delete(listener)
      }
      listener(...values)
    }
  }
  Object.defineProperties(response, {
    statusCode: { value: status },
    statusMessage: { value: "OK" },
    headers: { value: Object.freeze({}) },
    destroyed: {
      get(): boolean {
        return destroyed
      }
    },
    on: {
      value(event: string, listener: (...values: readonly unknown[]) => void): IncomingMessage {
        add(event, listener)
        return response
      }
    },
    once: {
      value(event: string, listener: (...values: readonly unknown[]) => void): IncomingMessage {
        add(event, listener)
        const selected = once.get(event) ?? new Set()
        selected.add(listener)
        once.set(event, selected)
        return response
      }
    },
    off: {
      value(event: string, listener: (...values: readonly unknown[]) => void): IncomingMessage {
        listeners.get(event)?.delete(listener)
        once.get(event)?.delete(listener)
        return response
      }
    },
    pause: {
      value(): IncomingMessage {
        return response
      }
    },
    resume: {
      value(): IncomingMessage {
        return response
      }
    },
    destroy: {
      value(): IncomingMessage {
        if (!destroyed) {
          destroyed = true
          destroyCalls += 1
          emit("close")
        }
        return response
      }
    }
  })
  return {
    response,
    get destroyCalls(): number {
      return destroyCalls
    },
    emit,
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0
    }
  }
}

/** Creates one inert HTTP/2 stream and optionally publishes response headers from end. */
function fakeHTTP2Stream(
  state: ResourceState,
  onceFailure: Error | null,
  endFailure: Error | null,
  status: number | null
): ClientHttp2Stream {
  const stream: ClientHttp2Stream = Object.create(null)
  let responseListener: ((headers: IncomingHttpHeaders) => void) | null = null
  Object.defineProperties(stream, {
    destroyed: {
      get(): boolean {
        return state.destroyed
      }
    },
    on: {
      value(): ClientHttp2Stream {
        return stream
      }
    },
    once: {
      value(event: string, listener: (headers: IncomingHttpHeaders) => void): ClientHttp2Stream {
        if (onceFailure !== null) throw onceFailure
        if (event === "response") responseListener = listener
        return stream
      }
    },
    off: {
      value(): ClientHttp2Stream {
        return stream
      }
    },
    pause: {
      value(): ClientHttp2Stream {
        return stream
      }
    },
    resume: {
      value(): ClientHttp2Stream {
        return stream
      }
    },
    end: {
      value(): void {
        if (endFailure !== null) throw endFailure
        if (status !== null && responseListener !== null) {
          const headers: IncomingHttpHeaders = Object.create(null)
          Object.defineProperty(headers, ":status", { value: status })
          responseListener(headers)
        }
      }
    },
    destroy: {
      value(): ClientHttp2Stream {
        state.destroyed = true
        return stream
      }
    }
  })
  return stream
}

/** Creates one inert HTTP/2 session with observable request and cleanup boundaries. */
function fakeHTTP2Session(
  state: ResourceState,
  socket: TLSSocket,
  stream: ClientHttp2Stream,
  requestFailure: Error | null,
  onceFailure: Error | null,
  observeHeaders?: (headers: OutgoingHttpHeaders) => void
): ClientHttp2Session {
  const session: ClientHttp2Session = Object.create(null)
  Object.defineProperties(session, {
    destroyed: {
      get(): boolean {
        return state.destroyed
      }
    },
    request: {
      value(headers: OutgoingHttpHeaders): ClientHttp2Stream {
        if (requestFailure !== null) throw requestFailure
        observeHeaders?.(headers)
        return stream
      }
    },
    once: {
      value(): ClientHttp2Session {
        if (onceFailure !== null) throw onceFailure
        return session
      }
    },
    destroy: {
      value(): void {
        state.destroyed = true
        socket.destroy()
      }
    }
  })
  return session
}

test("Node HTTP/1 synchronously thrown admission stages release owned resources", async () => {
  for (const stage of ["open", "once", "end"]) {
    const socketState = { destroyed: false }
    const socket = fakeTLSSocket(socketState)
    let requestDestroyed = false
    const failure = new Error(`HTTP/1 ${stage} failed`)
    const result = executeNodeHTTP1(
      new Request("https://localhost/internal/call", { method: "POST" }),
      new Uint8Array([1]),
      applyHTTPDialOptions([]),
      socket,
      function openRequest() {
        if (stage === "open") throw failure
        return {
          get destroyed(): boolean {
            return requestDestroyed
          },
          once(): void {
            if (stage === "once") throw failure
          },
          end(): void {
            if (stage === "end") throw failure
          },
          destroy(): void {
            requestDestroyed = true
          }
        }
      }
    )
    expect(await rejection(result)).toBe(failure)
    expect(socketState.destroyed).toBeTrue()
    expect(requestDestroyed).toBe(stage !== "open")
  }
})

test("Node HTTP/1 preserves a cross-realm native failure", async () => {
  const failure = runInNewContext('new Error("foreign native failure")') as Error
  const socketState = { destroyed: false }
  const socket = fakeTLSSocket(socketState)
  const result = executeNodeHTTP1(
    new Request("https://localhost/internal/call", { method: "POST" }),
    new Uint8Array(),
    applyHTTPDialOptions([]),
    socket,
    function openRequest(): never {
      throw failure
    }
  )

  expect(failure instanceof Error).toBe(false)
  expect(await rejection(result)).toBe(failure)
  expect(socketState.destroyed).toBeTrue()
})

test("Node HTTP/1 returns null bodies for forbidden statuses and closes every owner", async () => {
  for (const status of [204, 205, 304]) {
    const socketState = { destroyed: false }
    const responseState = { destroyed: false }
    const lateResponseState = { destroyed: false }
    const socket = fakeTLSSocket(socketState)
    let requestDestroyed = false
    const result = await executeNodeHTTP1(
      new Request("https://localhost/internal/call", { method: "POST" }),
      new Uint8Array(),
      applyHTTPDialOptions([]),
      socket,
      function respond(_request, _headers, _socket, received) {
        return {
          get destroyed(): boolean {
            return requestDestroyed
          },
          once(): void {},
          end(): void {
            received(fakeHTTP1Response(status, responseState))
            received(fakeHTTP1Response(status, lateResponseState))
          },
          destroy(): void {
            requestDestroyed = true
          }
        }
      }
    )
    expect(result.status).toBe(status)
    expect(result.body).toBeNull()
    expect(responseState.destroyed).toBeTrue()
    expect(lateResponseState.destroyed).toBeTrue()
    expect(requestDestroyed).toBeTrue()
    expect(socketState.destroyed).toBeTrue()
  }
})

test("Node HTTP/1 response construction failure rejects and closes every owner", async () => {
  const socketState = { destroyed: false }
  const responseState = { destroyed: false }
  const socket = fakeTLSSocket(socketState)
  let requestDestroyed = false
  const result = executeNodeHTTP1(
    new Request("https://localhost/internal/call", { method: "POST" }),
    new Uint8Array(),
    applyHTTPDialOptions([]),
    socket,
    function respond(_request, _headers, _socket, received) {
      return {
        get destroyed(): boolean {
          return requestDestroyed
        },
        once(): void {},
        end(): void {
          received(fakeHTTP1Response(600, responseState))
        },
        destroy(): void {
          requestDestroyed = true
        }
      }
    }
  )
  expect(await rejection(result)).toBeInstanceOf(RangeError)
  expect(responseState.destroyed).toBeTrue()
  expect(requestDestroyed).toBeTrue()
  expect(socketState.destroyed).toBeTrue()
})

test("Node HTTP/1 body terminals detach every observer and release owners once", async () => {
  for (const terminal of ["end", "error", "aborted", "close", "cancel"]) {
    const native = fakeStreamingHTTP1Response()
    let requestDestroyed = false
    let requestDestroyCalls = 0
    const response = await executeNodeHTTP1(
      new Request("http://localhost/internal/call", { method: "POST" }),
      new Uint8Array(),
      applyHTTPDialOptions([]),
      null,
      function respond(_request, _headers, _socket, received) {
        return {
          get destroyed(): boolean {
            return requestDestroyed
          },
          once(): void {},
          end(): void {
            received(native.response)
          },
          destroy(): void {
            if (!requestDestroyed) {
              requestDestroyed = true
              requestDestroyCalls += 1
            }
          }
        }
      }
    )
    if (response.body === null) throw new Error("streaming response omitted its body")
    if (terminal === "cancel") {
      await response.body.cancel(new Error("caller canceled"))
    } else {
      const reading = response.body.getReader().read()
      const failure = new Error("native body failed")
      native.emit(terminal, failure)
      if (terminal === "end") {
        expect(await reading).toEqual({ done: true, value: undefined })
      } else {
        const result = await rejection(reading)
        if (terminal === "error") expect(result).toBe(failure)
        else expect(result).toBeInstanceOf(Error)
      }
    }
    for (const event of ["data", "end", "error", "aborted", "close"]) {
      expect(native.listenerCount(event)).toBe(0)
    }
    native.emit("end")
    native.emit("error", new Error("late"))
    expect(requestDestroyCalls).toBe(1)
    expect(native.destroyCalls).toBe(terminal === "end" ? 0 : 1)
  }
})

test("pooled HTTP/1 bodyless terminals retain only healthy connections", async () => {
  for (const terminal of ["end", "error", "aborted", "close"]) {
    const native = fakeStreamingHTTP1Response(204)
    let requestDestroyed = false
    const response = await executeNodeHTTP1(
      new Request("http://localhost/internal/call", { method: "POST" }),
      new Uint8Array(),
      applyHTTPDialOptions([]),
      null,
      function respond(_request, _headers, _socket, received) {
        return {
          get destroyed(): boolean {
            return requestDestroyed
          },
          once(): void {},
          end(): void {
            received(native.response)
          },
          destroy(): void {
            requestDestroyed = true
          }
        }
      },
      true
    )
    expect(response.body).toBeNull()
    native.emit(terminal, new Error("bodyless terminal"))
    expect(requestDestroyed).toBe(terminal !== "end")
    expect(native.destroyCalls).toBe(terminal === "end" ? 0 : 1)
    for (const event of ["end", "error", "aborted", "close"]) {
      expect(native.listenerCount(event)).toBe(0)
    }
  }
})

test("Node owner close joins active and free HTTP/1 agent sockets", async () => {
  const active = agentSocket(true)
  const free = agentSocket(false)
  const agent: HTTPAgent = Object.create(null)
  Object.defineProperties(agent, {
    sockets: { value: { active: [active], missing: undefined } },
    freeSockets: { value: { free: [free], missing: undefined } },
    destroy: {
      value(): void {
        active.destroy()
        free.destroy()
      }
    }
  })
  const runtime = ownerRuntime(
    agent,
    function unusedTLS(): never {
      throw new Error("unexpected TLS")
    },
    function unusedHTTP2(): never {
      throw new Error("unexpected HTTP/2")
    }
  )
  const owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget("http://localhost:1", false),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([]),
    runtime
  )
  const closing = owner.close()
  expect(owner.close()).toBe(closing)
  await closing
  expect(free.destroyed).toBeTrue()
})

test("Node owner close rejects a body-read-delayed request before HTTP admission", async () => {
  let requests = 0
  const server = createHTTPServer(function respond(_request, response): void {
    requests += 1
    response.end("unexpected")
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("test server did not bind")
  let releaseBody = function pending(): void {}
  const request = new Request(`http://127.0.0.1:${address.port}/internal`, {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller): void {
        releaseBody = function release(): void {
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        }
      }
    })
  })
  const owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget(`http://127.0.0.1:${address.port}/internal`, false),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([])
  )
  try {
    const sending = owner.executor(request)
    await owner.close()
    releaseBody()
    const failure = await rejection(sending)
    await new Promise<void>(function observeLateAdmission(resolve): void {
      setTimeout(resolve, 20)
    })
    expect(requests).toBe(0)
    expect(failure).toBeInstanceOf(Error)
  } finally {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>(function close(resolve, reject): void {
        server.close(function closed(error?: Error): void {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  }
})

test("Node secure HTTP/1 owner transfers one socket and creates later TLS sockets", async () => {
  const agent = new HTTPAgent({ keepAlive: true })
  const sockets: FakeTLSHandle[] = []
  const controller = new AbortController()
  const runtime = ownerRuntime(
    agent,
    function connect(): TLSSocket {
      const handle = eventTLSSocket("http/1.1")
      sockets.push(handle)
      queueMicrotask(function negotiated(): void {
        handle.secure()
        if (sockets.length === 1) controller.abort(new Error("stop after negotiation"))
      })
      return handle.socket
    },
    function unusedHTTP2(): never {
      throw new Error("unexpected HTTP/2")
    }
  )
  const owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget("https://localhost:443/internal", true),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([]),
    runtime
  )
  const request = new Request("https://localhost/internal", {
    method: "POST",
    signal: controller.signal
  })
  expect(await rejection(owner.executor(request))).toBe(controller.signal.reason)
  expect(agent.createConnection({}, function unused(): void {})).toBe(sockets[0]?.socket)
  expect(agent.createConnection({}, function unused(): void {})).toBe(sockets[1]?.socket)
  expect(
    await rejection(owner.executor(new Request("https://localhost/internal", { method: "POST" })))
  ).toBeInstanceOf(Error)
  await owner.close()
})

test("Node owner close wins after selecting a warmed secure HTTP/1 pool", async () => {
  const agent = new HTTPAgent({ keepAlive: true })
  let requests = 0
  const runtime = ownerRuntime(
    agent,
    function connect(): TLSSocket {
      const handle = eventTLSSocket("http/1.1")
      queueMicrotask(handle.secure)
      return handle.socket
    },
    function unusedHTTP2(): never {
      throw new Error("unexpected HTTP/2")
    },
    function request(): ClientRequest {
      requests += 1
      return failingHTTP1Request()
    }
  )
  const owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget("https://localhost:443/internal", true),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([]),
    runtime
  )
  expect(
    await rejection(owner.executor(new Request("https://localhost/internal", { method: "POST" })))
  ).toBeInstanceOf(Error)
  expect(requests).toBe(1)

  const request = new Request("https://localhost/internal", { method: "POST" })
  Object.defineProperty(request, "arrayBuffer", {
    value(): Promise<ArrayBuffer> {
      return Promise.resolve(new Uint8Array([1]).buffer)
    }
  })
  const sending = rejection(owner.executor(request))
  await Promise.resolve()
  await owner.close()
  expect(await sending).toBeInstanceOf(Error)
  expect(requests).toBe(1)
})

test("Node connection-close HTTPS owner negotiates only HTTP/1.1", async () => {
  const agent = new HTTPAgent({ keepAlive: true })
  let negotiated = ""
  let abortAfterNegotiation: AbortController | null = null
  const runtime = ownerRuntime(
    agent,
    function connect(options): TLSSocket {
      negotiated = Array.isArray(options.ALPNProtocols) ? options.ALPNProtocols.join(",") : ""
      const handle = eventTLSSocket("http/1.1")
      queueMicrotask(function secure(): void {
        handle.secure()
        abortAfterNegotiation?.abort(new Error("abort after TLS negotiation"))
      })
      return handle.socket
    },
    function unusedHTTP2(): never {
      throw new Error("unexpected HTTP/2")
    }
  )
  const owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget("https://localhost:443/internal", true),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([
      function close(options) {
        return Object.freeze({ timeoutMs: options.timeoutMs, connectionClose: true })
      }
    ]),
    runtime
  )
  const controller = new AbortController()
  const work = owner.executor(
    new Request("https://localhost/internal", {
      method: "POST",
      signal: controller.signal
    })
  )
  setImmediate(function stopRequest(): void {
    controller.abort(new Error("stop connection-close request"))
  })
  expect(await rejection(work)).not.toBeNull()
  expect(negotiated).toBe("http/1.1")
  const afterTLS = new AbortController()
  abortAfterNegotiation = afterTLS
  const canceled = owner.executor(
    new Request("https://localhost/internal", {
      method: "POST",
      signal: afterTLS.signal
    })
  )
  expect(await rejection(canceled)).toBe(afterTLS.signal.reason)
  await owner.close()
})

test("Node HTTP/2 synchronously thrown admission stages release owned resources", async () => {
  for (const stage of ["connect", "request", "session-once", "stream-once", "end"]) {
    const socketState = { destroyed: false }
    const sessionState = { destroyed: false }
    const streamState = { destroyed: false }
    const socket = fakeTLSSocket(socketState)
    const failure = new Error(`HTTP/2 ${stage} failed`)
    const stream = fakeHTTP2Stream(
      streamState,
      stage === "stream-once" ? failure : null,
      stage === "end" ? failure : null,
      null
    )
    const session = fakeHTTP2Session(
      sessionState,
      socket,
      stream,
      stage === "request" ? failure : null,
      stage === "session-once" ? failure : null
    )
    const result = executeNodeHTTP2(
      new Request("https://localhost/internal/call", { method: "POST" }),
      new Uint8Array([1]),
      socket,
      function connect() {
        if (stage === "connect") throw failure
        return session
      }
    )
    expect(await rejection(result)).toBe(failure)
    expect(socketState.destroyed).toBeTrue()
    expect(sessionState.destroyed).toBe(stage !== "connect")
    expect(streamState.destroyed).toBe(
      stage === "session-once" || stage === "stream-once" || stage === "end"
    )
  }
})

test("Node HTTP/2 returns null bodies for forbidden statuses and closes every owner", async () => {
  for (const status of [204, 205, 304]) {
    const socketState = { destroyed: false }
    const sessionState = { destroyed: false }
    const streamState = { destroyed: false }
    const socket = fakeTLSSocket(socketState)
    const stream = fakeHTTP2Stream(streamState, null, null, status)
    const session = fakeHTTP2Session(sessionState, socket, stream, null, null)
    const result = await executeNodeHTTP2(
      new Request("https://localhost/internal/call", { method: "POST" }),
      new Uint8Array(),
      socket,
      function connect() {
        return session
      }
    )
    expect(result.status).toBe(status)
    expect(result.body).toBeNull()
    expect(streamState.destroyed).toBeTrue()
    expect(sessionState.destroyed).toBeTrue()
    expect(socketState.destroyed).toBeTrue()
  }
})

test("Node HTTP/2 preserves prototype-named request headers as own fields", async () => {
  const socketState = { destroyed: false }
  const sessionState = { destroyed: false }
  const streamState = { destroyed: false }
  const socket = fakeTLSSocket(socketState)
  const stream = fakeHTTP2Stream(streamState, null, null, 204)
  let captured: OutgoingHttpHeaders | null = null
  const session = fakeHTTP2Session(
    sessionState,
    socket,
    stream,
    null,
    null,
    function capture(headers): void {
      captured = headers
    }
  )

  await executeNodeHTTP2(
    new Request("https://localhost/internal/call", {
      method: "POST",
      headers: [["__proto__", "sentinel"]]
    }),
    new Uint8Array(),
    socket,
    function connect() {
      return session
    }
  )

  expect(Object.getOwnPropertyDescriptor(captured, "__proto__")?.value).toBe("sentinel")
})

test("Node HTTP/2 response construction failure rejects and closes every owner", async () => {
  const socketState = { destroyed: false }
  const sessionState = { destroyed: false }
  const streamState = { destroyed: false }
  const socket = fakeTLSSocket(socketState)
  const stream = fakeHTTP2Stream(streamState, null, null, 600)
  const session = fakeHTTP2Session(sessionState, socket, stream, null, null)
  const result = executeNodeHTTP2(
    new Request("https://localhost/internal/call", { method: "POST" }),
    new Uint8Array(),
    socket,
    function connect() {
      return session
    }
  )
  expect(await rejection(result)).toBeInstanceOf(RangeError)
  expect(streamState.destroyed).toBeTrue()
  expect(sessionState.destroyed).toBeTrue()
  expect(socketState.destroyed).toBeTrue()
})

test("default Node HTTP/1 opener performs one native request", async () => {
  const server = createHTTPServer(function respond(_request, response): void {
    response.end("native")
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("test server did not bind")
  try {
    const result = await executeNodeHTTP1(
      new Request(`http://127.0.0.1:${address.port}/internal`, { method: "POST" }),
      new Uint8Array(),
      applyHTTPDialOptions([]),
      null
    )
    expect(await result.text()).toBe("native")
  } finally {
    await new Promise<void>(function close(resolve): void {
      server.close(function closed(): void {
        resolve()
      })
    })
  }
})

test("Node HTTP/2 owner evicts every failed slot and drains GOAWAY without retry", async () => {
  const requestFailure = new Error("session request failed")
  const closeFailure = new Error("session close failed")
  const failedRequest = pooledHTTP2Session(200, requestFailure)
  const invalidResponse = pooledHTTP2Session(600, null, closeFailure)
  const draining = pooledHTTP2Session(200, null, null, true)
  const destroyed = pooledHTTP2Session(200, null, null, false, true)
  const sessions = [failedRequest, invalidResponse, draining, destroyed]
  let connections = 0
  const runtime = ownerRuntime(
    new HTTPAgent({ keepAlive: true }),
    function connect(): TLSSocket {
      const handle = eventTLSSocket("h2")
      queueMicrotask(handle.secure)
      return handle.socket
    },
    function connect(): ClientHttp2Session {
      connections += 1
      if (connections === 1) throw new Error("session construction failed")
      const selected = sessions[connections - 2]
      if (selected === undefined) throw new Error("test omitted an HTTP/2 session")
      return selected.session
    }
  )
  const owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget("https://localhost:443/internal", true),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([]),
    runtime
  )
  /** Opens one request against the current deterministic HTTP/2 slot. */
  function execute(): Promise<Response> {
    return owner.executor(new Request("https://localhost/internal", { method: "POST" }))
  }

  expect(await rejection(execute())).toBeInstanceOf(Error)
  expect(await rejection(execute())).toBe(requestFailure)
  failedRequest.emit("error", new Error("evict failed request session"))
  expect(await rejection(execute())).toBeInstanceOf(RangeError)
  invalidResponse.emit("goaway")
  const response = await execute()
  expect(await response.text()).toBe("ok")
  const last = await execute()
  expect(await last.text()).toBe("ok")
  destroyed.emit("error", new Error("destroy without close"))
  await owner.close()
  expect(connections).toBe(5)
  expect(draining.requestCount).toBe(1)
})

test("concurrent callers wait independently for one shared TLS handshake", async () => {
  const handle = eventTLSSocket("h2")
  const pooled = pooledHTTP2Session(200)
  let connected = function markConnected(): void {}
  const connectionStarted = new Promise<void>(function capture(resolve): void {
    connected = resolve
  })
  let connections = 0
  const runtime = ownerRuntime(
    new HTTPAgent({ keepAlive: true }),
    function connect(): TLSSocket {
      connections += 1
      connected()
      return handle.socket
    },
    function connect(): ClientHttp2Session {
      return pooled.session
    }
  )
  const owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget("https://localhost:443/internal", true),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([]),
    runtime
  )
  const first = new AbortController()
  const second = new AbortController()
  const firstFailure = runInNewContext('new Error("first caller canceled")') as Error
  const firstWork = owner.executor(
    new Request("https://localhost/internal", { method: "POST", signal: first.signal })
  )
  const secondWork = owner.executor(
    new Request("https://localhost/internal", { method: "POST", signal: second.signal })
  )

  await connectionStarted
  first.abort(firstFailure)
  handle.secure()

  expect(firstFailure instanceof Error).toBe(false)
  expect(await rejection(firstWork)).toBe(firstFailure)
  expect(await (await secondWork).text()).toBe("ok")
  expect(connections).toBe(1)
  await owner.close()
})

test("Node owner close wins after a TLS socket has already negotiated", async () => {
  let owner: ReturnType<typeof newNodeHTTPExecutor> | null = null
  const runtime = ownerRuntime(
    new HTTPAgent({ keepAlive: true }),
    function connect(): TLSSocket {
      const handle = eventTLSSocket("http/1.1")
      queueMicrotask(function negotiatedThenClosed(): void {
        handle.secure()
        void owner?.close()
      })
      return handle.socket
    },
    function unusedHTTP2(): never {
      throw new Error("unexpected HTTP/2")
    }
  )
  owner = newNodeHTTPExecutor(
    normalizeHTTPDialTarget("https://localhost:443/internal", true),
    defaultHTTPCommonOptions(),
    applyHTTPDialOptions([]),
    runtime
  )
  const result = owner.executor(
    new Request("https://localhost/internal", {
      method: "POST"
    })
  )
  expect(await rejection(result)).toBeInstanceOf(Error)
  await owner.close()
})
