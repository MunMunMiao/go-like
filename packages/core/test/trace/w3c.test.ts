import { expect, test } from "bun:test"

import { background } from "../../src/context/index"
import {
  newTraceContextPropagator,
  spanFromContext,
  type CarrierReader
} from "../../src/trace/index"

const first = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
const second = "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01"

/** Reads one Fetch `Headers` object the way core's carriers do. */
function headersReader(headers: Headers): CarrierReader {
  return {
    get: (key) => headers.get(key),
    keys: () => [...headers.keys()]
  }
}

// Known upstream bug: `@opentelemetry/instrumentation-undici` appends a second `traceparent` to a Node
// `fetch` request that already carries one, and the receiver folds the two fields into one value.
// go-like keeps strict W3C parsing and does not work around it.
// https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2796
// https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3711
// https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3713
test("extract rejects a traceparent folded from two header fields", () => {
  const headers = new Headers()
  headers.append("traceparent", first)
  headers.append("traceparent", second)
  expect(headers.get("traceparent")).toBe(`${first}, ${second}`)

  const ctx = background()
  expect(newTraceContextPropagator().extract(ctx, headersReader(headers))).toBe(ctx)
})

test("extract accepts the same traceparent sent as one field", () => {
  const headers = new Headers({ traceparent: first })
  const ctx = background()
  const extracted = newTraceContextPropagator().extract(ctx, headersReader(headers))
  expect(extracted).not.toBe(ctx)
  const remote = spanFromContext(extracted).spanContext()
  expect(remote.traceId).toBe("0af7651916cd43dd8448eb211c80319c")
  expect(remote.spanId).toBe("b7ad6b7169203331")
  expect(remote.isRemote).toBe(true)
})
