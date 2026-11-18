import { expect, test } from "bun:test"

import * as Metrics from "@go-like/prometheus/metric"

test("exports the meter provider and scrape handler", () => {
  expect(Object.keys(Metrics).sort()).toEqual([
    "createPrometheusHandler",
    "newPrometheusMeterProvider"
  ])
})
