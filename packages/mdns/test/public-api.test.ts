import { expect, test } from "bun:test"

import * as api from "../src/registry/index"
import * as node from "../src/registry/node"
import * as testing from "./testing"

test("root runtime export surface contains only portable constructor and options", () => {
  expect(Object.keys(api).sort()).toEqual([
    "domain",
    "families",
    "interfaces",
    "maxDecodedPayloadBytes",
    "maxPacketBytes",
    "newMDNSRegistry",
    "onRegistrationError",
    "port",
    "queryTimeout",
    "ttl",
    "watchBufferSize"
  ])
})

test("package-private testing helper exports only the deterministic host", () => {
  expect(Object.keys(testing)).toEqual(["newMemoryMDNSNetwork"])
})

test("Node subpath exports only the native host constructor", () => {
  expect(Object.keys(node)).toEqual(["newNodeMDNSHost"])
})
