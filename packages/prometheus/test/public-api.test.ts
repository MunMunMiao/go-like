import { expect, test } from "bun:test"

import * as Metrics from "../src/index"

test("exports the Web scrape handler and explicit request instrumentation", () => {
  expect(Object.keys(Metrics).sort()).toEqual([
    "createPrometheusHandler",
    "measureBroker",
    "measureClient",
    "measureUnaryMiddleware",
    "measureWebHandler",
    "newRequestMetrics"
  ])
})
