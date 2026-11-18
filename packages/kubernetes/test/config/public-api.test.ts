import { expect, test } from "bun:test"

import * as KubernetesConfig from "../../src/config/index"

test("public API exposes only lower-camel runtime factories", () => {
  expect(Object.keys(KubernetesConfig).sort()).toEqual(["kubernetesSource"])
})
