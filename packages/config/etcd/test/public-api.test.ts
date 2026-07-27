import { expect, test } from "bun:test"

import * as EtcdConfig from "../src/index"

test("public API exposes only lower-camel runtime factories", () => {
  expect(Object.keys(EtcdConfig).sort()).toEqual(["etcdSource", "jsonEtcdDecoder"])
})
