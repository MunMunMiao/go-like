import { test } from "bun:test"

import { transportConformanceCases } from "../../src/testing"

import { newNodeHTTPTransport } from "../src/node"

const cases = transportConformanceCases(() => newNodeHTTPTransport(), {
  listenAddress: "127.0.0.1:0",
  faultHarness: null,
  operationTimeoutMs: 2_000,
  dialBeforeListen: false,
  preservesRequestIdentity: false,
  unsupportedSecurity: false,
  connectionCloseEndsClient: false,
  handlerFailuresReject: false,
  boundAddressIncludes: "",
  observeOpenBody: false,
  preservesClientAbortCause: false,
  serveCancelRejectsFetch: false
})

for (const entry of cases) {
  test(`conformance: ${entry.name}`, entry.run)
}
