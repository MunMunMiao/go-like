import { expect, test } from "bun:test"

import * as Testing from "../src/index"
import * as ListenerTesting from "../src/listener"
import * as ServerTesting from "../src/server"

test("root has no runtime exports", () => {
  expect(Object.keys(Testing)).toEqual([])
})

test("server subpath exports only the conformance case factory", () => {
  expect(Object.keys(ServerTesting)).toEqual(["serverConformanceCases"])
})

test("listener subpath exports only the conformance case factory", () => {
  expect(Object.keys(ListenerTesting)).toEqual(["listenerConformanceCases"])
})
