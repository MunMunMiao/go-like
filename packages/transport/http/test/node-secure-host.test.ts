import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { connect, createSecureServer, type ClientHttp2Session } from "node:http2"

import { describe, expect, test } from "bun:test"

import { background } from "@go-like/context"
import type { TLSConfig, TLSEncodedBytes } from "@go-like/transport"

import {
  allowHTTP1,
  clientAuth,
  newNodeHTTPHost,
  newNodeHTTPHostWithSecureFactory,
  type NodeHTTPHostOption
} from "../src/node-host"
import type { HTTPHostHandle, HTTPHostListenOptions, HTTPServeHandle } from "../src/types"

const ca = readFileSync(new URL("fixtures/tls/ca.pem", import.meta.url))
const serverCertificate = readFileSync(new URL("fixtures/tls/server.pem", import.meta.url))
const serverKey = readFileSync(new URL("fixtures/tls/server-key.pem", import.meta.url))
const clientCertificate = readFileSync(new URL("fixtures/tls/client.pem", import.meta.url))
const clientKey = readFileSync(new URL("fixtures/tls/client-key.pem", import.meta.url))

interface HTTP2Reply {
  readonly body: string
  readonly protocol: string
}

interface FakeSession extends EventEmitter {
  /** Simulates graceful HTTP/2 session close. */
  close(): void
  /** Simulates forced HTTP/2 session destruction. */
  destroy(): void
}

/** Creates one detached PEM transport value. */
function pem(bytes: Uint8Array): TLSEncodedBytes {
  return Object.freeze({ encoding: "pem", bytes: new Uint8Array(bytes) })
}

/** Creates the server identity and peer trust used only by loopback tests. */
function serverTLS(): TLSConfig {
  return Object.freeze({
    serverName: null,
    caCertificate: pem(ca),
    certificateChain: pem(serverCertificate),
    privateKey: pem(serverKey)
  })
}

/** Returns secure listen options for one real Node host bind. */
function secureListen(tls: TLSConfig = serverTLS()): HTTPHostListenOptions {
  return Object.freeze({ secure: true, tlsConfig: tls })
}

/** Returns the port portion of one normalized host-port authority. */
function port(address: string): number {
  return Number(address.slice(address.lastIndexOf(":") + 1))
}

/** Opens a verified HTTP/2 session and keeps its error observable. */
function openHTTP2(address: string): ClientHttp2Session {
  const session = connect(`https://localhost:${port(address)}`, {
    ca,
    cert: clientCertificate,
    key: clientKey,
    servername: "localhost",
    rejectUnauthorized: true
  })
  return session
}

/** Executes one POST over a caller-owned HTTP/2 session. */
function requestHTTP2(session: ClientHttp2Session, body: string): Promise<HTTP2Reply> {
  return new Promise<HTTP2Reply>(function exchange(resolve, reject): void {
    const chunks: Buffer[] = []
    const request = session.request(
      Object.freeze({ ":method": "POST", ":path": "/secure", "content-type": "text/plain" })
    )
    request.once("error", reject)
    request.on("data", function received(chunk: Buffer): void {
      chunks.push(chunk)
    })
    request.once("end", function ended(): void {
      resolve(
        Object.freeze({
          body: Buffer.concat(chunks).toString(),
          protocol: session.alpnProtocol ?? ""
        })
      )
    })
    request.end(body)
  })
}

/** Best-effort cleanup for a partially exercised secure host. */
async function cleanup(
  handle: HTTPHostHandle | null,
  session: ClientHttp2Session | null
): Promise<void> {
  if (session !== null && !session.destroyed) session.destroy()
  if (handle === null) return
  try {
    await handle.forceClose?.(new Error("test cleanup"))
  } catch {}
  try {
    await handle.close(background())
  } catch {}
  try {
    await handle.done()
  } catch {}
}

describe("Node secure HTTP host", () => {
  test("serves verified mTLS over HTTP/2 and gracefully closes the live session", async () => {
    const host = newNodeHTTPHost(clientAuth("require"), allowHTTP1(false))
    let handle: HTTPHostHandle | null = null
    let session: ClientHttp2Session | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", secureListen())
      const served = handle.serve(background(), async function echo(input): Promise<Response> {
        const body = await input.request.text()
        return new Response(`${input.request.url}|${body}`)
      })
      await served.ready()
      session = openHTTP2(handle.address())
      const reply = await requestHTTP2(session, "http2")

      expect(reply.protocol).toBe("h2")
      expect(reply.body).toBe(`https://${handle.address()}/secure|http2`)

      const sessionClosed = new Promise<void>(function observe(resolve): void {
        session?.once("close", resolve)
      })
      const closing = handle.close(background())
      await sessionClosed
      await closing
      await served.done()
      await handle.done()
      session = null
      handle = null
    } finally {
      await cleanup(handle, session)
    }
  })

  test("constructs no-client-auth and HTTP/1.1 ALPN policy", async () => {
    const host = newNodeHTTPHost(clientAuth("none"), allowHTTP1(true))
    let handle: HTTPHostHandle | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", secureListen())
      await handle.close(background())
      await handle.done()
      handle = null
    } finally {
      await cleanup(handle, null)
    }
  })

  test("force destroys an active HTTP/2 session without fabricating terminal state", async () => {
    const host = newNodeHTTPHost(clientAuth("require"))
    let handle: HTTPHostHandle | null = null
    let session: ClientHttp2Session | null = null
    let served: HTTPServeHandle | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", secureListen())
      served = handle.serve(background(), function stream(): Response {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode("active"))
            }
          })
        )
      })
      await served.ready()
      session = openHTTP2(handle.address())
      const request = session.request(Object.freeze({ ":path": "/force" }))
      const admitted = new Promise<void>(function observe(resolve, reject): void {
        request.once("response", function response(): void {
          resolve()
        })
        request.once("error", reject)
      })
      request.end()
      await admitted

      await handle.forceClose?.(new Error("forced"))
      await handle.done()
      await served.done()
      if (!session.destroyed) session.destroy()
      session = null
      handle = null
      served = null
    } finally {
      await cleanup(handle, session)
    }
  })

  test("fails closed for invalid host policy and underspecified TLS material", async () => {
    expect(() => allowHTTP1(null as never)).toThrow(TypeError)
    expect(() => clientAuth("invalid" as never)).toThrow(TypeError)
    expect(() => newNodeHTTPHost(null as never)).toThrow(TypeError)
    const invalidReducer: NodeHTTPHostOption = () => null as never
    expect(() => newNodeHTTPHost(invalidReducer)).toThrow(TypeError)
    const invalidAllowHTTP1: NodeHTTPHostOption = () =>
      Object.freeze({ allowHTTP1: null as never, clientAuth: "none" })
    const invalidClientAuth: NodeHTTPHostOption = () =>
      Object.freeze({ allowHTTP1: true, clientAuth: "invalid" as never })
    expect(() => newNodeHTTPHost(invalidAllowHTTP1)).toThrow(TypeError)
    expect(() => newNodeHTTPHost(invalidClientAuth)).toThrow(TypeError)
    expect(() => newNodeHTTPHostWithSecureFactory(null as never)).toThrow(TypeError)

    await expect(
      newNodeHTTPHost(clientAuth("require")).bind(background(), "127.0.0.1:0", {
        secure: false,
        tlsConfig: null
      })
    ).rejects.toThrow("requires TLS")

    const withoutCA = Object.freeze({
      serverName: null,
      caCertificate: null,
      certificateChain: pem(serverCertificate),
      privateKey: pem(serverKey)
    })
    await expect(
      newNodeHTTPHost(clientAuth("require")).bind(
        background(),
        "127.0.0.1:0",
        secureListen(withoutCA)
      )
    ).rejects.toThrow("requires a PEM CA certificate")

    const derCertificate = Object.freeze({
      serverName: null,
      caCertificate: pem(ca),
      certificateChain: Object.freeze({
        encoding: "der" as const,
        bytes: new Uint8Array(serverCertificate)
      }),
      privateKey: pem(serverKey)
    })
    await expect(
      newNodeHTTPHost().bind(background(), "127.0.0.1:0", secureListen(derCertificate))
    ).rejects.toThrow("must use PEM encoding")
  })

  test("aggregates secure session close and destroy failures through the native seam", async () => {
    const closeFailure = new Error("session close failed")
    const destroyFailure = new Error("session destroy failed")
    let closeDestroyCalls = 0
    let throwingDestroyCalls = 0
    const closeThrows = Object.assign(new EventEmitter(), {
      /** Throws once while the later force path still releases this fake session. */
      close(): void {
        throw closeFailure
      },
      /** Publishes true fake-session terminal during force. */
      destroy(): void {
        closeDestroyCalls += 1
        closeThrows.emit("close")
      }
    })
    const destroyThrows = Object.assign(new EventEmitter(), {
      /** Deliberately retains this fake session until force. */
      close(): void {},
      /** Throws once, re-enters observation, and then publishes terminal. */
      destroy(): void {
        throwingDestroyCalls += 1
        queueMicrotask(function settle(): void {
          Reflect.apply(server.emit, server, ["session", destroyThrows])
          destroyThrows.emit("close")
        })
        throw destroyFailure
      }
    })
    const sessions: readonly FakeSession[] = Object.freeze([closeThrows, destroyThrows])
    const server = createSecureServer()
    const host = newNodeHTTPHostWithSecureFactory(function factory(options, listener) {
      server.setSecureContext(options)
      server.on("request", listener)
      server.once("listening", function publishSessions(): void {
        for (const session of sessions) Reflect.apply(server.emit, server, ["session", session])
      })
      return server
    }, clientAuth("require"))
    expect(host.capabilities()).toEqual(
      Object.freeze({
        tls: true,
        forceClose: true,
        connectionMetadata: true
      })
    )
    let handle: HTTPHostHandle | null = null
    try {
      handle = await host.bind(background(), "127.0.0.1:0", secureListen())
      const closing = handle.close(background())
      await handle.forceClose?.(new Error("force session faults"))
      const failure = await closing.catch(function rejected(error: Error): Error {
        return error
      })
      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError)) throw failure
      expect(Array.from(failure.errors)).toEqual([closeFailure, destroyFailure])
      expect(closeDestroyCalls).toBe(1)
      expect(throwingDestroyCalls).toBe(1)
      await expect(handle.done()).rejects.toBe(failure)
      handle = null
    } finally {
      await cleanup(handle, null)
    }
  })
})
