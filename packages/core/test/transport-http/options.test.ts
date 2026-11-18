import { expect, test } from "bun:test"

import { secure, timeout, withTimeout } from "../../src/transport"
import type { Options } from "../../src/transport"
import {
  executor,
  maxMessageBytes,
  newHTTPTransport,
  type HTTPExecutor
} from "../../src/transport/http"
import {
  applyHTTPCommonOptions,
  applyHTTPDialOptions,
  applyHTTPListenOptions,
  applyHTTPTransportOptions,
  defaultHTTPCommonOptions,
  defaultHTTPTransportOptions,
  host,
  snapshotHTTPCommonOptions
} from "../../src/transport/http/options"
import type { HTTPHost } from "../../src/transport/http/types"

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

test("common snapshots detach TLS and its outputs", () => {
  const tlsBytes = new Uint8Array([1, 2])
  const raw: Options = Object.freeze({
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
})

test("common option snapshots reject every malformed structural boundary", () => {
  const invalid: unknown[] = [
    null,
    Object.freeze({
      timeoutMs: -1,
      secure: false,
      tlsConfig: null
    }),
    Object.freeze({
      timeoutMs: 0,
      secure: "false",
      tlsConfig: null
    }),
    Object.freeze({
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
