import { expect, test } from "bun:test"

import { secure, timeout, withTimeout } from "@go-like/transport"
import type { Message, Options } from "@go-like/transport"
import {
  executor,
  maxMessageBytes,
  newHTTPTransport,
  type HTTPExecutor
} from "@go-like/transport-http"
import {
  applyHTTPCommonOptions,
  applyHTTPDialOptions,
  applyHTTPListenOptions,
  applyHTTPTransportOptions,
  defaultHTTPCommonOptions,
  defaultHTTPTransportOptions,
  host,
  snapshotHTTPCommonOptions
} from "../src/options"
import type { HTTPHost } from "../src/types"

/** Creates a host whose methods must not run during construction or common init. */
function inertHost(): HTTPHost {
  return Object.freeze({
    /** Reports the portable baseline capabilities. */
    capabilities() {
      return Object.freeze({
        tls: false,
        forceClose: false,
        connectionMetadata: false
      })
    },
    /** Rejects because this helper is never expected to bind. */
    bind() {
      return Promise.reject(new Error("unexpected bind"))
    }
  })
}

/** Completes a standard callable executor with runtime-specific Fetch statics. */
function httpExecutor(
  run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): HTTPExecutor {
  return Object.assign(run, {
    /** Allows runtimes to expose optional connection warming without affecting tests. */
    preconnect(): void {}
  })
}

test("HTTP construction options are immutable borrowed executor reducers", () => {
  const calls: Request[] = []
  const injected = httpExecutor(function injectedExecutor(
    input: RequestInfo | URL,
    init?: RequestInit
  ) {
    calls.push(new Request(input, init))
    return Promise.resolve(new Response())
  })
  const base = Object.freeze({
    executor: globalThis.fetch,
    maxMessageBytes: 4 * 1024 * 1024
  })
  const reduced = executor(injected)(base)

  expect(Object.isFrozen(reduced)).toBe(true)
  expect(reduced.executor).toBe(injected)
  expect(reduced.maxMessageBytes).toBe(4 * 1024 * 1024)
  expect(base.executor).toBe(globalThis.fetch)
  expect(calls).toEqual([])
})

test("HTTP message limits are immutable positive safe-integer reducers", () => {
  const base = Object.freeze({
    executor: globalThis.fetch,
    maxMessageBytes: 4 * 1024 * 1024
  })
  const reduced = maxMessageBytes(17)(base)

  expect(Object.isFrozen(reduced)).toBe(true)
  expect(reduced.executor).toBe(globalThis.fetch)
  expect(reduced.maxMessageBytes).toBe(17)
  expect(base.maxMessageBytes).toBe(4 * 1024 * 1024)
  expect(defaultHTTPTransportOptions().maxMessageBytes).toBe(4 * 1024 * 1024)

  for (const value of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    expect(() => maxMessageBytes(value)).toThrow(RangeError)
  }
})

test("host is an immutable listen-only reducer and does not perform I/O", () => {
  const value = inertHost()
  const base = Object.freeze({ host: null })
  const reduced = host(value)(base)

  expect(Object.isFrozen(reduced)).toBe(true)
  expect(reduced.host).toBe(value)
  expect(base.host).toBeNull()
})

test("common Options are applied only through init in declaration order", () => {
  const value = newHTTPTransport()
  value.init(timeout(10), timeout(20), secure(true))

  expect(value.options()).toMatchObject({ timeoutMs: 20, secure: true })
})

test("rejects timeout values that platform timers would truncate", () => {
  const overflow = 2_147_483_648
  const value = newHTTPTransport()

  expect(() => value.init(timeout(overflow))).toThrow(RangeError)
  expect(() => applyHTTPDialOptions([withTimeout(overflow)])).toThrow(RangeError)
})

/** Creates one valid raw common option object for boundary probes. */
function commonOptions(): Options {
  return Object.freeze({
    codec: null,
    logger: null,
    timeoutMs: 0,
    secure: false,
    tlsConfig: null
  })
}

test("common snapshots detach TLS, codec, logger, and their outputs", () => {
  const tlsBytes = new Uint8Array([1, 2])
  let marshaledHeader = ""
  let loggedFields: Readonly<Record<string, unknown>> | undefined
  const codec = Object.freeze({
    /** Encodes one fixture while observing the borrowed receiver. */
    marshal(message: Message): Uint8Array {
      marshaledHeader = message.header.topic ?? ""
      return new Uint8Array([message.body[0] ?? 0])
    },
    /** Decodes one fixture Message. */
    unmarshal(bytes: Uint8Array): Message {
      return Object.freeze({
        header: Object.freeze({ topic: "decoded" }),
        body: new Uint8Array(bytes)
      })
    }
  })
  const logger = Object.freeze({
    /** Captures one detached fields record. */
    log(
      _level: "debug" | "info" | "warn" | "error",
      _message: string,
      fields?: Readonly<Record<string, unknown>>
    ): void {
      loggedFields = fields
    }
  })
  const raw: Options = Object.freeze({
    codec,
    logger,
    timeoutMs: 10,
    secure: true,
    tlsConfig: Object.freeze({
      serverName: "service.internal",
      caCertificate: Object.freeze({ encoding: "pem", bytes: tlsBytes }),
      certificateChain: null,
      privateKey: null
    })
  })
  const snapshot = snapshotHTTPCommonOptions(raw)
  tlsBytes[0] = 9
  expect(snapshot.tlsConfig?.caCertificate?.bytes).toEqual(new Uint8Array([1, 2]))
  const exposedTLS = snapshot.tlsConfig?.caCertificate?.bytes
  exposedTLS?.fill(7)
  expect(snapshot.tlsConfig?.caCertificate?.bytes[0]).toBe(1)

  const encoded = snapshot.codec?.marshal(
    Object.freeze({
      header: Object.freeze({ topic: "before" }),
      body: new Uint8Array([3])
    })
  )
  encoded?.fill(8)
  expect(marshaledHeader).toBe("before")
  expect(snapshot.codec?.unmarshal(new Uint8Array([4])).body).toEqual(new Uint8Array([4]))

  const fields = { key: "value" }
  snapshot.logger?.log("info", "message", fields)
  fields.key = "mutated"
  expect(loggedFields).toEqual({ key: "value" })
  snapshot.logger?.log("debug", "without-fields")
  expect(loggedFields).toBeUndefined()
  const throwingLogger = snapshotHTTPCommonOptions(
    Object.freeze({
      codec: null,
      logger: Object.freeze({
        /** Exercises diagnostic isolation. */
        log(): never {
          throw new Error("isolated")
        }
      }),
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
  )
  expect(() => throwingLogger.logger?.log("warn", "ignored", { value: 1 })).not.toThrow()
})

test("raw HTTP logger snapshots observe asynchronous and hostile thenable failures", async () => {
  const asynchronousFailure = new Error("raw HTTP logger rejected")
  const thenGetterFailure = new Error("raw HTTP logger then getter threw")
  const thenCallFailure = new Error("raw HTTP logger then call threw")
  const thenRejection = new Error("raw HTTP logger thenable rejected")
  const unhandled: unknown[] = []
  let asyncReceiver = false
  let detachedFields: Readonly<Record<string, unknown>> | undefined
  let thenGetterCalls = 0
  let thenCallCalls = 0
  let thenRejectCalls = 0
  const asyncOwner = {
    marker: "raw-http",
    log(
      _level: "debug" | "info" | "warn" | "error",
      _message: string,
      fields?: Readonly<Record<string, unknown>>
    ) {
      asyncReceiver = this.marker === "raw-http"
      detachedFields = fields
      return Promise.reject(asynchronousFailure)
    }
  }
  const thenGetterOwner = {
    log() {
      return Object.defineProperty({}, "then", {
        /** Throws while the logger result is assimilated. */
        get(): never {
          thenGetterCalls += 1
          throw thenGetterFailure
        }
      })
    }
  }
  const thenCallOwner = {
    log() {
      return Object.freeze({
        /** Throws from the thenable call boundary. */
        then(): never {
          thenCallCalls += 1
          throw thenCallFailure
        }
      })
    }
  }
  const thenRejectOwner = {
    log() {
      return Object.freeze({
        /** Rejects through the thenable rejection callback. */
        then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
          thenRejectCalls += 1
          reject(thenRejection)
        }
      })
    }
  }
  /** Records any diagnostic result that escaped its failure-isolating wrapper. */
  function observeUnhandled(reason: unknown): void {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", observeUnhandled)
  try {
    const fields = { attempt: 3 }
    const loggers = [asyncOwner, thenGetterOwner, thenCallOwner, thenRejectOwner]
    for (const value of loggers) {
      const snapshot = snapshotHTTPCommonOptions(
        Object.freeze({
          codec: null,
          logger: value,
          timeoutMs: 0,
          secure: false,
          tlsConfig: null
        })
      )
      snapshot.logger?.log("error", "diagnostic", fields)
    }
    fields.attempt = 4
    await new Promise<void>(function nextTurn(resolve): void {
      setTimeout(resolve, 0)
    })

    expect(asyncReceiver).toBe(true)
    expect(detachedFields).toEqual({ attempt: 3 })
    expect(Object.isFrozen(detachedFields)).toBe(true)
    expect(thenGetterCalls).toBe(1)
    expect(thenCallCalls).toBe(1)
    expect(thenRejectCalls).toBe(1)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", observeUnhandled)
  }
})

test("common option snapshots reject every malformed structural boundary", () => {
  const invalid: unknown[] = [
    null,
    Object.freeze({
      codec: null,
      logger: null,
      timeoutMs: -1,
      secure: false,
      tlsConfig: null
    }),
    Object.freeze({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: "false",
      tlsConfig: null
    }),
    Object.freeze({
      codec: Object.freeze({ marshal: null, unmarshal: null }),
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    }),
    Object.freeze({
      codec: null,
      logger: Object.freeze({ log: null }),
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    }),
    Object.freeze({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: Object.freeze({
        serverName: 1,
        caCertificate: null,
        certificateChain: null,
        privateKey: null
      })
    }),
    Object.freeze({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: Object.freeze({
        serverName: null,
        caCertificate: Object.freeze({ encoding: "text", bytes: new Uint8Array() }),
        certificateChain: null,
        privateKey: null
      })
    }),
    Object.freeze({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: Object.freeze({
        serverName: null,
        caCertificate: Object.freeze({ encoding: "pem", bytes: [] }),
        certificateChain: null,
        privateKey: null
      })
    })
  ]
  for (const value of invalid) {
    expect(() => Reflect.apply(snapshotHTTPCommonOptions, undefined, [value])).toThrow()
  }

  const badMarshal = snapshotHTTPCommonOptions(
    Object.freeze({
      codec: Object.freeze({
        /** Returns an invalid codec result for boundary validation. */
        marshal(): Uint8Array {
          return Reflect.get({}, "missing")
        },
        /** Returns a valid unused Message. */
        unmarshal(): Message {
          return Object.freeze({ header: Object.freeze({}), body: new Uint8Array() })
        }
      }),
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
  )
  expect(() =>
    badMarshal.codec?.marshal(Object.freeze({ header: Object.freeze({}), body: new Uint8Array() }))
  ).toThrow()
  expect(() =>
    Reflect.apply(badMarshal.codec?.unmarshal ?? function missing(): void {}, undefined, [[]])
  ).toThrow()
})

test("structural reducers validate common, dial, construction, and listen outputs", () => {
  const defaults = defaultHTTPCommonOptions()
  expect(() => Reflect.apply(applyHTTPCommonOptions, undefined, [defaults, [null]])).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPCommonOptions, undefined, [
      defaults,
      [
        function invalid(): null {
          return null
        }
      ]
    ])
  ).toThrow()

  expect(() => Reflect.apply(applyHTTPDialOptions, undefined, [[null]])).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPDialOptions, undefined, [
      [
        function invalid(): null {
          return null
        }
      ]
    ])
  ).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPDialOptions, undefined, [
      [
        function invalidFlags() {
          return Object.freeze({
            timeoutMs: 1,
            connectionClose: "false"
          })
        }
      ]
    ])
  ).toThrow()
  expect(
    applyHTTPDialOptions([
      function valid(value) {
        return Object.freeze({
          timeoutMs: 1,
          connectionClose: value.connectionClose
        })
      }
    ])
  ).toEqual({ timeoutMs: 1, connectionClose: false })

  expect(() => Reflect.apply(applyHTTPTransportOptions, undefined, [[null]])).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPTransportOptions, undefined, [
      [
        function invalid(): null {
          return null
        }
      ]
    ])
  ).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPTransportOptions, undefined, [
      [
        function invalidExecutor() {
          return Object.freeze({
            executor: null,
            maxMessageBytes: 1
          })
        }
      ]
    ])
  ).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPTransportOptions, undefined, [
      [
        function invalidMessageLimit() {
          return Object.freeze({
            executor: globalThis.fetch,
            maxMessageBytes: 0
          })
        }
      ]
    ])
  ).toThrow()
  expect(() => Reflect.apply(executor, undefined, [null])).toThrow()

  expect(() => Reflect.apply(applyHTTPListenOptions, undefined, [[null]])).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPListenOptions, undefined, [
      [
        function invalid(): null {
          return null
        }
      ]
    ])
  ).toThrow()
  expect(() =>
    Reflect.apply(applyHTTPListenOptions, undefined, [
      [
        function invalidHost() {
          return Object.freeze({ host: {} })
        }
      ]
    ])
  ).toThrow()
  expect(() => Reflect.apply(host, undefined, [null])).toThrow()
})

test("default construction captures the current global Fetch reference", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "fetch")
  const replacement = httpExecutor(function replacement(): Promise<Response> {
    return Promise.resolve(new Response())
  })
  try {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: replacement
    })
    expect(defaultHTTPTransportOptions().executor).toBe(replacement)
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: null
    })
    expect(() => defaultHTTPTransportOptions()).toThrow()
  } finally {
    if (before === undefined) Reflect.deleteProperty(globalThis, "fetch")
    else Object.defineProperty(globalThis, "fetch", before)
  }
})
