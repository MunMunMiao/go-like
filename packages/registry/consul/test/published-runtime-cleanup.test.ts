import { expect, test } from "bun:test"

import { dockerObjectExists } from "./integration/docker-cleanup"

test("Docker inspect 的空数组输出不代表对象仍然存在", () => {
  expect(dockerObjectExists({ exitCode: 1, stdout: "[]\n" })).toBeFalse()
})

test("Docker inspect 成功时对象仍然存在", () => {
  expect(dockerObjectExists({ exitCode: 0, stdout: '[{"Id":"container"}]\n' })).toBeTrue()
})
