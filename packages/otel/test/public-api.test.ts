import { expect, test } from "bun:test"

import * as Otel from "../src/index"

test("root exports lifecycle adaptation and explicit instrumentation", () => {
  expect(Object.keys(Otel).sort()).toEqual([
    "defaultOtelShutdownTimeoutMs",
    "measureClient",
    "measureClientMiddleware",
    "measureUnaryMiddleware",
    "newOtelServer",
    "newRequestMetrics",
    "otelShutdownTimeout",
    "traceBroker",
    "traceClient",
    "traceUnaryMiddleware",
    "traceWebHandler"
  ])
})
