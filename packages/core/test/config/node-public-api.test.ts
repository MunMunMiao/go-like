import { expect, test } from "bun:test"

import * as NodeConfig from "../../src/config/node"

test("Node subpath exports only its explicit filesystem capability", () => {
  expect(Object.keys(NodeConfig)).toEqual(["newNodeFileCapability"])
})
