import { expect, test } from "bun:test"

import {
  defaultOtelShutdownTimeoutMs,
  newOtelLogHandler,
  newOtelMeterProvider,
  newOtelPropagator,
  newOtelTracerProvider
} from "../src/index"
import * as Otel from "../src/index"

test("root exports the provider adapters and the shutdown budget", () => {
  expect(Object.keys(Otel).sort()).toEqual([
    "defaultOtelShutdownTimeoutMs",
    "newOtelLogHandler",
    "newOtelMeterProvider",
    "newOtelPropagator",
    "newOtelTracerProvider"
  ])
  expect(defaultOtelShutdownTimeoutMs).toBe(25_000)
  expect(typeof newOtelTracerProvider).toBe("function")
  expect(typeof newOtelMeterProvider).toBe("function")
  expect(typeof newOtelLogHandler).toBe("function")
  expect(typeof newOtelPropagator).toBe("function")
})
