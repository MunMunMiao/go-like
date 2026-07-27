import { describe, expect, test } from "bun:test"

import type {
  DialOption,
  Message,
  MessageCodec,
  Option,
  TLSConfig,
  TransportLogger
} from "../src/types"
import * as OptionsModule from "../src/options"
import {
  reduceTestDialOptions,
  reduceTestListenOptions,
  reduceTestOptions
} from "./runtime/options-fixture"

const codec: (value: MessageCodec | null) => Option = Reflect.get(OptionsModule, "codec")
const logger: (value: TransportLogger | null) => Option = Reflect.get(OptionsModule, "logger")
const timeout: (timeoutMs: number) => Option = Reflect.get(OptionsModule, "timeout")
const secure: (enabled: boolean) => Option = Reflect.get(OptionsModule, "secure")
const tlsConfig: (value: TLSConfig | null) => Option = Reflect.get(OptionsModule, "tlsConfig")
const withTimeout: (timeoutMs: number) => DialOption = Reflect.get(OptionsModule, "withTimeout")
const withConnClose: () => DialOption = Reflect.get(OptionsModule, "withConnClose")

function optionsImplemented(): boolean {
  return [codec, logger, timeout, secure, tlsConfig, withTimeout, withConnClose].every(
    (value) => typeof value === "function"
  )
}

function requireOptionsImplementation(): boolean {
  const implemented = optionsImplemented()
  expect(implemented).toBe(true)
  return implemented
}

describe("transport options", () => {
  test("publishes the exact internal reducer implementation surface", () => {
    expect(Object.keys(OptionsModule).sort()).toEqual([
      "codec",
      "logger",
      "secure",
      "timeout",
      "tlsConfig",
      "withConnClose",
      "withTimeout"
    ])
  })

  test("freezes the reviewed common, dial, and listen defaults", () => {
    if (!requireOptionsImplementation()) return
    const common = reduceTestOptions()
    const dial = reduceTestDialOptions()
    const listen = reduceTestListenOptions()

    expect(common).toEqual({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
    expect(dial).toEqual({
      timeoutMs: 5_000,
      connectionClose: false
    })
    expect(listen).toEqual({})
    expect(Object.isFrozen(common)).toBe(true)
    expect(Object.isFrozen(dial)).toBe(true)
    expect(Object.isFrozen(listen)).toBe(true)
  })

  test("applies immutable reducers in order with last option winning", () => {
    if (!requireOptionsImplementation()) return
    const defaults = reduceTestOptions()
    const reduced = reduceTestOptions(timeout(10), timeout(20), secure(true), secure(false))
    const dial = reduceTestDialOptions(withTimeout(10), withTimeout(25), withConnClose())

    expect(defaults).toEqual({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
    expect(reduced).toMatchObject({
      timeoutMs: 20,
      secure: false
    })
    expect(dial).toEqual({
      timeoutMs: 25,
      connectionClose: true
    })
    expect(Object.isFrozen(reduced)).toBe(true)
  })

  test("rejects invalid millisecond durations", () => {
    if (!requireOptionsImplementation()) return
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => timeout(value)).toThrow(RangeError)
      expect(() => withTimeout(value)).toThrow(RangeError)
    }
  })

  test("rejects non-boolean public flag inputs", () => {
    if (!requireOptionsImplementation()) return
    expect(() => Reflect.apply(secure, undefined, ["yes"])).toThrow(TypeError)
  })

  test("defensively snapshots TLS material at application and readback", () => {
    if (!requireOptionsImplementation()) return
    const ca = new Uint8Array([1, 2, 3])
    const certificate = new Uint8Array([4, 5])
    const key = new Uint8Array([6, 7])
    const input: TLSConfig = {
      serverName: "service.internal",
      caCertificate: { encoding: "pem", bytes: ca },
      certificateChain: { encoding: "der", bytes: certificate },
      privateKey: { encoding: "pem", bytes: key }
    }
    const reduced = reduceTestOptions(tlsConfig(input))
    ca[0] = 99
    certificate[0] = 99
    key[0] = 99

    expect(reduced.tlsConfig?.caCertificate?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(reduced.tlsConfig?.certificateChain?.bytes).toEqual(new Uint8Array([4, 5]))
    expect(reduced.tlsConfig?.privateKey?.bytes).toEqual(new Uint8Array([6, 7]))
    const tlsSnapshot = reduced.tlsConfig
    if (tlsSnapshot === null) throw new Error("TLS snapshot is missing")
    const exposed = tlsSnapshot.caCertificate?.bytes
    if (exposed === undefined) throw new Error("TLS CA snapshot is missing")
    exposed[0] = 55
    expect(tlsSnapshot.caCertificate?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(Object.isFrozen(tlsSnapshot)).toBe(true)
    expect(Object.isFrozen(tlsSnapshot.caCertificate)).toBe(true)

    const cleared = reduceTestOptions(tlsConfig(input), tlsConfig(null))
    expect(cleared.tlsConfig).toBeNull()
  })

  test("rejects malformed structural TLS configuration before readback", () => {
    if (!requireOptionsImplementation()) return
    const invalidServerName = {
      serverName: 42,
      caCertificate: null,
      certificateChain: null,
      privateKey: null
    }
    const invalidEncoding = {
      serverName: null,
      caCertificate: { encoding: "raw", bytes: new Uint8Array([1]) },
      certificateChain: null,
      privateKey: null
    }
    const serverNameOption = Reflect.apply(tlsConfig, undefined, [invalidServerName])
    const encodingOption = Reflect.apply(tlsConfig, undefined, [invalidEncoding])

    expect(() => reduceTestOptions(serverNameOption)).toThrow(TypeError)
    expect(() => reduceTestOptions(encodingOption)).toThrow(TypeError)
  })

  test("wraps codecs with detached Message and byte boundaries", () => {
    if (!requireOptionsImplementation()) return
    const marshaledInputs: Message[] = []
    const unmarshalInputs: Uint8Array[] = []
    const codecBytes = new Uint8Array([8, 9])
    const decodedHeader = { key: "before" }
    const decodedBody = new Uint8Array([10, 11])
    const structuralCodec: MessageCodec = {
      marshal(message): Uint8Array {
        marshaledInputs.push(message)
        return codecBytes
      },
      unmarshal(bytes): Message {
        unmarshalInputs.push(bytes)
        return { header: decodedHeader, body: decodedBody }
      }
    }
    const wrapped = reduceTestOptions(codec(structuralCodec)).codec
    if (wrapped === null) throw new Error("codec snapshot is missing")

    const sourceHeader = { key: "before" }
    const sourceBody = new Uint8Array([1, 2])
    const encoded = wrapped.marshal({ header: sourceHeader, body: sourceBody })
    sourceHeader.key = "after"
    sourceBody[0] = 99
    codecBytes[0] = 99
    expect(marshaledInputs[0]?.header).toEqual({ key: "before" })
    expect(marshaledInputs[0]?.body).toEqual(new Uint8Array([1, 2]))
    expect(encoded).toEqual(new Uint8Array([8, 9]))

    const wire = new Uint8Array([3, 4])
    const decoded = wrapped.unmarshal(wire)
    wire[0] = 99
    decodedHeader.key = "after"
    decodedBody[0] = 99
    expect(unmarshalInputs[0]).toEqual(new Uint8Array([3, 4]))
    expect(decoded.header).toEqual({ key: "before" })
    expect(decoded.body).toEqual(new Uint8Array([10, 11]))
    const decodedRead = decoded.body
    decodedRead[0] = 77
    expect(decoded.body).toEqual(new Uint8Array([10, 11]))
  })

  test("captures codec and logger callables with their original receivers", () => {
    if (!requireOptionsImplementation()) return
    const codecOwner = {
      byte: 1,
      marshal(_message: Message): Uint8Array {
        return new Uint8Array([this.byte])
      },
      unmarshal(_bytes: Uint8Array): Message {
        return { header: { byte: String(this.byte) }, body: new Uint8Array([this.byte]) }
      }
    }
    const logMessages: string[] = []
    const loggerOwner = {
      prefix: "original",
      log(_level: Parameters<TransportLogger["log"]>[0], message: string): void {
        logMessages.push(`${this.prefix}:${message}`)
      }
    }
    const configured = reduceTestOptions(codec(codecOwner), logger(loggerOwner))
    const configuredCodec = configured.codec
    const configuredLogger = configured.logger
    if (configuredCodec === null || configuredLogger === null) {
      throw new Error("callable snapshots are missing")
    }

    codecOwner.marshal = function replacementMarshal(): Uint8Array {
      return new Uint8Array([9])
    }
    codecOwner.unmarshal = function replacementUnmarshal(): Message {
      return { header: { byte: "9" }, body: new Uint8Array([9]) }
    }
    loggerOwner.log = function replacementLog(): void {
      logMessages.push("replacement")
    }

    const encoded = configuredCodec.marshal({ header: {}, body: new Uint8Array() })
    const decoded = configuredCodec.unmarshal(new Uint8Array())
    configuredLogger.log("info", "message")

    expect(encoded).toEqual(new Uint8Array([1]))
    expect(decoded.header).toEqual({ byte: "1" })
    expect(decoded.body).toEqual(new Uint8Array([1]))
    expect(logMessages).toEqual(["original:message"])
  })

  test("isolates structural logger failures from transport callers", async () => {
    if (!requireOptionsImplementation()) return
    const seenFields: Readonly<Record<string, unknown>>[] = []
    const structuralLogger: TransportLogger = {
      log(_level, _message, fields): void {
        if (fields !== undefined) seenFields.push(fields)
        throw new Error("logger failed")
      }
    }
    const wrapped = reduceTestOptions(logger(structuralLogger)).logger
    if (wrapped === null) throw new Error("logger snapshot is missing")
    const fields = { attempt: 1 }

    expect(() => wrapped.log("warn", "diagnostic", fields)).not.toThrow()
    fields.attempt = 2
    expect(seenFields[0]).toEqual({ attempt: 1 })
    expect(Object.isFrozen(seenFields[0])).toBe(true)
    expect(reduceTestOptions(logger(structuralLogger), logger(null)).logger).toBeNull()

    const asynchronousFailure = new Error("async logger rejected")
    const thenGetterFailure = new Error("logger then getter threw")
    const thenCallFailure = new Error("logger then call threw")
    const thenRejection = new Error("logger thenable rejected")
    const unhandled: unknown[] = []
    let receiverCalls = 0
    let thenGetterCalls = 0
    let thenCallCalls = 0
    let thenRejectCalls = 0
    let detachedFields: Readonly<Record<string, unknown>> | undefined
    let thenReceiver: unknown = null
    const asyncOwner = {
      marker: "async-owner",
      log(
        _level: "debug" | "info" | "warn" | "error",
        _message: string,
        fields?: Readonly<Record<string, unknown>>
      ) {
        if (this.marker === "async-owner") receiverCalls += 1
        detachedFields = fields
        return Promise.reject(asynchronousFailure)
      }
    }
    const thenGetterOwner = {
      log() {
        return Object.defineProperty({}, "then", {
          /** Throws while Promise assimilation reads the hostile thenable. */
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
          /** Throws while Promise assimilation invokes the hostile thenable. */
          then(this: unknown): never {
            thenCallCalls += 1
            thenReceiver = this
            throw thenCallFailure
          }
        })
      }
    }
    const rejectedThenableOwner = {
      log() {
        return Object.freeze({
          /** Rejects through the standard thenable callback boundary. */
          then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
            thenRejectCalls += 1
            reject(thenRejection)
          }
        })
      }
    }
    /** Records process-level evidence if a diagnostic result escapes observation. */
    function observeUnhandled(reason: unknown): void {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      const asyncLogger = reduceTestOptions(logger(asyncOwner)).logger
      const getterLogger = reduceTestOptions(logger(thenGetterOwner)).logger
      const callLogger = reduceTestOptions(logger(thenCallOwner)).logger
      const rejectedLogger = reduceTestOptions(logger(rejectedThenableOwner)).logger
      if (
        asyncLogger === null ||
        getterLogger === null ||
        callLogger === null ||
        rejectedLogger === null
      ) {
        throw new Error("adversarial logger snapshots are missing")
      }
      const asyncFields = { attempt: 7 }
      asyncLogger.log("error", "async", asyncFields)
      asyncFields.attempt = 8
      getterLogger.log("warn", "then-getter")
      callLogger.log("warn", "then-call")
      rejectedLogger.log("warn", "then-reject")
      await new Promise<void>(function nextTurn(resolve): void {
        setTimeout(resolve, 0)
      })

      expect(receiverCalls).toBe(1)
      expect(detachedFields).toEqual({ attempt: 7 })
      expect(Object.isFrozen(detachedFields)).toBe(true)
      expect(thenGetterCalls).toBe(1)
      expect(thenCallCalls).toBe(1)
      expect(thenReceiver).not.toBeNull()
      expect(thenRejectCalls).toBe(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", observeUnhandled)
    }
  })
})
