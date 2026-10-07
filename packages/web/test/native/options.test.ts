import { expect, test } from "bun:test"

import {
  captureNativeOptions,
  defaultNativeOptions,
  nativeHostname,
  nativePort,
  nativeShutdownTimeout,
  snapshotNativeOptions,
  type NativeServerOptions
} from "../../src/native-options"

const maximumTimerDelayMs = 2_147_483_647
const ids = ["bun", "deno"] as const
const acceptedTimerDelays = [0, 0.5, 1.5, maximumTimerDelayMs - 0.5, maximumTimerDelayMs] as const
const rejectedTimerDelays = [
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  maximumTimerDelayMs + 0.5,
  maximumTimerDelayMs + 1
] as const
const defaults: NativeServerOptions = Object.freeze({
  hostname: "127.0.0.1",
  port: 0,
  shutdownTimeoutMs: 25_000
})

test("defaults are the frozen loopback ephemeral 25s snapshot", () => {
  expect(defaultNativeOptions).toEqual(defaults)
  expect(Object.isFrozen(defaultNativeOptions)).toBe(true)
})

for (const id of ids) {
  test(`${id} hostname option validates its value and replaces only the hostname`, () => {
    for (const value of ["", 1, undefined, null]) {
      expect(() => nativeHostname(id, value as never)).toThrow(TypeError)
    }
    expect(() => nativeHostname(id, "")).toThrow(`${id} hostname must be a non-empty string`)

    const configured = nativeHostname(id, "localhost")(defaults)

    expect(configured).toEqual({ hostname: "localhost", port: 0, shutdownTimeoutMs: 25_000 })
    expect(Object.isFrozen(configured)).toBe(true)
    expect(defaults.hostname).toBe("127.0.0.1")
  })

  test(`${id} port option accepts 0..65535 integers and rejects everything else`, () => {
    for (const value of [0, 1, 8_080, 65_535]) {
      expect(nativePort(id, value)(defaults).port).toBe(value)
    }
    for (const value of [-1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "80", undefined]) {
      expect(() => nativePort(id, value as never)).toThrow(TypeError)
    }
    expect(() => nativePort(id, -1)).toThrow(`${id} port must be an integer in 0..65535`)

    const configured = nativePort(id, 9_090)(defaults)

    expect(configured).toEqual({ hostname: "127.0.0.1", port: 9_090, shutdownTimeoutMs: 25_000 })
    expect(Object.isFrozen(configured)).toBe(true)
  })

  for (const timeoutMs of acceptedTimerDelays) {
    test(`${id} shutdown option and structural snapshots accept the timer value ${timeoutMs}`, () => {
      expect(nativeShutdownTimeout(id, timeoutMs)(defaults).shutdownTimeoutMs).toBe(timeoutMs)
      expect(
        nativeHostname(id, "localhost")({ ...defaults, shutdownTimeoutMs: timeoutMs })
          .shutdownTimeoutMs
      ).toBe(timeoutMs)
    })
  }

  for (const timeoutMs of rejectedTimerDelays) {
    test(`${id} shutdown option and structural snapshots reject the timer value ${timeoutMs}`, () => {
      expect(() => nativeShutdownTimeout(id, timeoutMs)).toThrow(RangeError)
      expect(() =>
        nativeHostname(id, "localhost")({ ...defaults, shutdownTimeoutMs: timeoutMs })
      ).toThrow(RangeError)
    })
  }

  test(`${id} shutdown option names itself in its range error`, () => {
    expect(() => nativeShutdownTimeout(id, -1)).toThrow(
      `${id}ShutdownTimeout must be finite and from 0 to ${maximumTimerDelayMs}`
    )
    expect(() => snapshotNativeOptions(id, { ...defaults, shutdownTimeoutMs: -1 })).toThrow(
      `${id} shutdownTimeoutMs must be finite and from 0 to ${maximumTimerDelayMs}`
    )
  })

  test(`${id} options reject malformed incoming structural snapshots`, () => {
    expect(() => nativeHostname(id, "localhost")(null as never)).toThrow(
      `${id} server options must be an object`
    )
    expect(() => nativePort(id, 80)("options" as never)).toThrow(TypeError)
    expect(() => nativeHostname(id, "localhost")({ ...defaults, hostname: "" })).toThrow(TypeError)
    expect(() => nativeHostname(id, "localhost")({ ...defaults, port: -1 })).toThrow(TypeError)
    expect(() => nativeHostname(id, "localhost")({ ...defaults, port: 1.5 })).toThrow(TypeError)
    expect(() => nativePort(id, 80)({ ...defaults, hostname: 1 as never })).toThrow(TypeError)
    expect(() =>
      nativeShutdownTimeout(id, 1_000)({ ...defaults, shutdownTimeoutMs: Number.NaN })
    ).toThrow(RangeError)
  })

  test(`${id} snapshots read each structural field exactly once`, () => {
    const reads = { hostname: 0, port: 0, shutdownTimeoutMs: 0 }
    const observed: NativeServerOptions = {
      get hostname(): string {
        reads.hostname += 1
        return reads.hostname === 1 ? "127.0.0.9" : ""
      },
      get port(): number {
        reads.port += 1
        return reads.port === 1 ? 4_000 : -1
      },
      get shutdownTimeoutMs(): number {
        reads.shutdownTimeoutMs += 1
        return reads.shutdownTimeoutMs === 1 ? 5 : Number.NaN
      }
    }

    const snapshot = snapshotNativeOptions(id, observed)

    expect(reads).toEqual({ hostname: 1, port: 1, shutdownTimeoutMs: 1 })
    expect(snapshot).toEqual({ hostname: "127.0.0.9", port: 4_000, shutdownTimeoutMs: 5 })
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  test(`${id} capture applies options in order onto the defaults without mutating them`, () => {
    const mutable = { host: "127.0.0.3", port: 9_090, timeout: 100 }
    const options = [
      nativeHostname(id, mutable.host),
      nativePort(id, mutable.port),
      nativeShutdownTimeout(id, mutable.timeout),
      nativePort(id, 9_091)
    ]
    mutable.host = "127.0.0.4"
    mutable.port = 1
    mutable.timeout = 0

    const captured = captureNativeOptions(id, options)

    expect(captured).toEqual({ hostname: "127.0.0.3", port: 9_091, shutdownTimeoutMs: 100 })
    expect(Object.isFrozen(captured)).toBe(true)
    expect(captureNativeOptions(id, [])).toEqual(defaults)
    expect(defaultNativeOptions).toEqual(defaults)
  })

  test(`${id} capture rejects non-callable options and bad snapshots returned by options`, () => {
    expect(() => captureNativeOptions(id, [undefined as never])).toThrow(
      `${id} server option must be callable`
    )
    expect(() => captureNativeOptions(id, ["port" as never])).toThrow(TypeError)
    expect(() => captureNativeOptions(id, [() => null as never])).toThrow(TypeError)
    expect(() => captureNativeOptions(id, [() => ({ ...defaults, hostname: "" })])).toThrow(
      TypeError
    )
    expect(() => captureNativeOptions(id, [() => ({ ...defaults, port: 65_536 })])).toThrow(
      TypeError
    )
    expect(() =>
      captureNativeOptions(id, [
        () => ({ ...defaults, shutdownTimeoutMs: maximumTimerDelayMs + 1 })
      ])
    ).toThrow(RangeError)
  })
}
