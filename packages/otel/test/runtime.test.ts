import { describe, expect, test } from "bun:test"

import { background, canceled, withCancel, withCancelCause } from "@likego/context"

import {
  otelShutdownTimeout,
  newOtelServerWithProviders,
  type OtelProviderLike
} from "../src/runtime"
import { nextTurn, providerControl, settlesWithin } from "./helpers"

describe("OpenTelemetry native provider lifecycle", () => {
  test("accepts provider ownership once and publishes one stable terminal", async () => {
    const providers = providerControl()
    const server = newOtelServerWithProviders(
      {
        tracerProvider: providers.tracerProvider,
        meterProvider: providers.meterProvider
      },
      []
    )
    const running = server.start(background())
    await nextTurn()
    expect(running).toBe(running)
    await expect(server.start(background())).rejects.toMatchObject({
      name: "OtelAlreadyStartedError",
      code: "LIKEGO_OTEL_ALREADY_STARTED",
      status: "running"
    })

    const stopping = server.stop(background())
    expect(providers.calls).toEqual({ trace: 1, metric: 1 })
    providers.traceShutdown.resolve()
    expect(await settlesWithin(stopping)).toBeFalse()
    providers.metricShutdown.resolve()
    await stopping
    await running
    await server.stop(background())
    await expect(server.start(background())).rejects.toMatchObject({ status: "stopped" })
  })

  test("pre-canceled start leaves application providers untouched and remains one-shot", async () => {
    const providers = providerControl()
    const [ctx, cancel] = withCancel(background())
    cancel()
    const server = newOtelServerWithProviders(
      {
        tracerProvider: providers.tracerProvider,
        meterProvider: providers.meterProvider
      },
      []
    )

    await expect(server.start(ctx)).rejects.toBe(canceled)
    expect(providers.calls).toEqual({ trace: 0, metric: 0 })
    await expect(server.start(background())).rejects.toMatchObject({ status: "failed" })
  })

  test("caller cancellation abandons only that stop wait", async () => {
    const providers = providerControl()
    const server = newOtelServerWithProviders(
      {
        tracerProvider: providers.tracerProvider,
        meterProvider: providers.meterProvider
      },
      []
    )
    const running = server.start(background())
    await nextTurn()
    const [caller, cancelCaller] = withCancelCause(background())
    const callerFailure = new Error("caller stopped waiting")
    const first = server.stop(caller)
    const second = server.stop(background())
    cancelCaller(callerFailure)

    await expect(first).rejects.toBe(callerFailure)
    expect(providers.calls).toEqual({ trace: 1, metric: 1 })
    providers.traceShutdown.resolve()
    providers.metricShutdown.resolve()
    await second
    await running
  })

  test("owner timeout never fabricates native terminal", async () => {
    const providers = providerControl()
    const server = newOtelServerWithProviders(
      {
        tracerProvider: providers.tracerProvider,
        meterProvider: providers.meterProvider
      },
      [otelShutdownTimeout(10)]
    )
    const running = server.start(background())
    await nextTurn()

    const ownerFailure = await server.stop(background()).catch((error: unknown) => error)
    expect(ownerFailure).toMatchObject({
      name: "OtelShutdownTimeoutError",
      code: "LIKEGO_OTEL_SHUTDOWN_TIMEOUT",
      timeoutMs: 10
    })
    expect(await settlesWithin(running)).toBeFalse()

    providers.traceShutdown.resolve()
    expect(await settlesWithin(running)).toBeFalse()
    providers.metricShutdown.resolve()
    await expect(running).rejects.toBe(ownerFailure)
  })

  test("retains early and late native shutdown Error identities around timeout", async () => {
    const providers = providerControl()
    const traceFailure = new Error("trace failed before timeout")
    const metricFailure = new Error("metric failed after timeout")
    const server = newOtelServerWithProviders(
      {
        tracerProvider: providers.tracerProvider,
        meterProvider: providers.meterProvider
      },
      [otelShutdownTimeout(20)]
    )
    const running = server.start(background())
    await nextTurn()
    const stopping = server.stop(background())
    providers.traceShutdown.reject(traceFailure)

    const ownerFailure = await stopping.catch((error: unknown) => error)
    expect(ownerFailure).toBeInstanceOf(AggregateError)
    if (!(ownerFailure instanceof AggregateError)) throw new Error("expected owner aggregate")
    expect(ownerFailure.errors[0]).toBe(traceFailure)
    const timeoutFailure = ownerFailure.errors[1]
    expect(timeoutFailure).toMatchObject({ code: "LIKEGO_OTEL_SHUTDOWN_TIMEOUT" })
    expect(await settlesWithin(running)).toBeFalse()

    providers.metricShutdown.reject(metricFailure)
    const terminal = await running.catch((error: unknown) => error)
    expect(terminal).toBeInstanceOf(AggregateError)
    if (!(terminal instanceof AggregateError)) throw new Error("expected terminal aggregate")
    expect(terminal.errors).toEqual([traceFailure, metricFailure, timeoutFailure])
  })

  test("normalizes non-Error and synchronous shutdown failures while calling both providers", async () => {
    const traceProvider: OtelProviderLike = {
      /** Throws one non-Error native rejection synchronously. */
      shutdown(): Promise<void> {
        throw "trace value"
      }
    }
    const metricFailure = new Error("metric failed")
    let metricCalls = 0
    const meterProvider: OtelProviderLike = {
      /** Rejects with one identity-bearing native Error. */
      shutdown(): Promise<void> {
        metricCalls += 1
        return Promise.reject(metricFailure)
      }
    }
    const server = newOtelServerWithProviders({ tracerProvider: traceProvider, meterProvider }, [])
    const running = server.start(background())
    await nextTurn()

    const failure = await server.stop(background()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("expected shutdown aggregate")
    expect(failure.errors[0]).toMatchObject({ cause: "trace value" })
    expect(failure.errors[1]).toBe(metricFailure)
    expect(metricCalls).toBe(1)
    expect(await running.catch((error: unknown) => error)).toBe(failure)
  })

  test("counts synchronous native work inside the owner boundary without faking terminal", async () => {
    let traceCalls = 0
    let metricCalls = 0
    const tracerProvider: OtelProviderLike = {
      /** Blocks synchronously before returning an already-terminal Promise. */
      shutdown(): Promise<void> {
        traceCalls += 1
        const blockedUntil = performance.now() + 30
        while (performance.now() < blockedUntil) {
          // Deliberately model an upstream synchronous shutdown defect.
        }
        return Promise.resolve()
      }
    }
    const meterProvider: OtelProviderLike = {
      /** Returns one clean native terminal Promise. */
      shutdown(): Promise<void> {
        metricCalls += 1
        return Promise.resolve()
      }
    }
    const server = newOtelServerWithProviders({ tracerProvider, meterProvider }, [
      otelShutdownTimeout(10)
    ])
    const running = server.start(background())
    await nextTurn()
    const started = performance.now()
    const ownerFailure = await server.stop(background()).catch((error: unknown) => error)

    expect(performance.now() - started).toBeGreaterThanOrEqual(30)
    expect(ownerFailure).toMatchObject({ code: "LIKEGO_OTEL_SHUTDOWN_TIMEOUT" })
    expect(traceCalls).toBe(1)
    expect(metricCalls).toBe(1)
    await expect(running).rejects.toBe(ownerFailure)
  })

  test("supports either official signal provider independently", async () => {
    const traceOnly = providerControl()
    const traceServer = newOtelServerWithProviders(
      {
        tracerProvider: traceOnly.tracerProvider
      },
      []
    )
    const traceRunning = traceServer.start(background())
    await nextTurn()
    const traceStopping = traceServer.stop(background())
    traceOnly.traceShutdown.resolve()
    await Promise.all([traceStopping, traceRunning])
    expect(traceOnly.calls).toEqual({ trace: 1, metric: 0 })

    const metricOnly = providerControl()
    const metricServer = newOtelServerWithProviders(
      {
        meterProvider: metricOnly.meterProvider
      },
      []
    )
    const metricRunning = metricServer.start(background())
    await nextTurn()
    const metricStopping = metricServer.stop(background())
    metricOnly.metricShutdown.resolve()
    await Promise.all([metricStopping, metricRunning])
    expect(metricOnly.calls).toEqual({ trace: 0, metric: 1 })
  })

  test("rejects malformed lifecycle inputs without configuring telemetry", () => {
    const providers = providerControl()
    expect(() => newOtelServerWithProviders(null as never, [])).toThrow(TypeError)
    expect(() => newOtelServerWithProviders({}, [])).toThrow("at least one")
    expect(() => newOtelServerWithProviders({ tracerProvider: {} as never }, [])).toThrow(
      "official"
    )
    expect(() =>
      newOtelServerWithProviders(
        {
          tracerProvider: providers.tracerProvider,
          meterProvider: providers.tracerProvider
        },
        []
      )
    ).toThrow("must not share")
    expect(() =>
      newOtelServerWithProviders(
        {
          tracerProvider: providers.tracerProvider
        },
        [null as never]
      )
    ).toThrow("option")
    expect(() => otelShutdownTimeout(-1)).toThrow(RangeError)
    expect(() => otelShutdownTimeout(Number.NaN)).toThrow(RangeError)
    expect(() => otelShutdownTimeout(1.5)).toThrow(RangeError)
    expect(() => otelShutdownTimeout(2_147_483_648)).toThrow(RangeError)
    expect(() => otelShutdownTimeout(0)).not.toThrow()
    expect(() => otelShutdownTimeout(2_147_483_647)).not.toThrow()
  })

  test("a zero owner boundary still calls shutdown and waits for true terminal", async () => {
    const providers = providerControl()
    const server = newOtelServerWithProviders(
      {
        tracerProvider: providers.tracerProvider,
        meterProvider: providers.meterProvider
      },
      [otelShutdownTimeout(0)]
    )
    const running = server.start(background())
    await nextTurn()
    const ownerFailure = await server.stop(background()).catch((error: unknown) => error)
    expect(ownerFailure).toMatchObject({ timeoutMs: 0 })
    expect(providers.calls).toEqual({ trace: 1, metric: 1 })
    expect(await settlesWithin(running)).toBeFalse()
    providers.traceShutdown.resolve()
    providers.metricShutdown.resolve()
    await nextTurn()
    await expect(running).rejects.toBe(ownerFailure)
  })
})
