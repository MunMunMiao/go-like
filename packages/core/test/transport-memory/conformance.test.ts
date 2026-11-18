import { test } from "bun:test"

import type { Context } from "../../src/context"
import type { Listener } from "../../src/transport"
import {
  transportConformanceCases,
  type TransportConformanceFaultHarness
} from "../support/transport-conformance"

import { newMemoryTransport } from "../../src/transport/memory/index"
import { failMemoryListener } from "../../src/transport/memory/testing"

const faultHarness: TransportConformanceFaultHarness = Object.freeze({
  /** Injects one real listener terminal without reaching into its state machine. */
  failListener(ctx: Context, listener: Listener, cause: Error): void {
    failMemoryListener(ctx, listener, cause)
  }
})

const cases = transportConformanceCases(newMemoryTransport, {
  listenAddress: "memory://conformance",
  faultHarness,
  operationTimeoutMs: 2_000
})

for (const entry of cases) {
  test(`conformance: ${entry.name}`, entry.run)
}
