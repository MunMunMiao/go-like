import { expect, test } from "bun:test"

import { currentToken, currentTokenExcept, removeToken } from "../src/token-stack"

interface FixtureToken {
  readonly identity: string
  readonly value: string
  active: boolean
}

/** Creates one mutable exact-generation token fixture. */
function token(value: string): FixtureToken {
  return { identity: "orders-v1-node-1", value, active: true }
}

test("exact token removal compacts generations while retaining live restore order", () => {
  const first = token("first")
  const second = token("second")
  const third = token("third")
  const stack = [first, second, third]
  const stacks = new Map([[first.identity, stack]])

  expect(currentToken(stack)).toBe(third)
  expect(currentTokenExcept(stack, new Set([third]))).toBe(second)
  removeToken(stacks, second)
  expect(second.active).toBe(false)
  expect(stacks.get(first.identity)).toEqual([first, third])
  expect(currentToken(stacks.get(first.identity))).toBe(third)

  removeToken(stacks, third)
  expect(stacks.get(first.identity)).toEqual([first])
  expect(currentToken(stacks.get(first.identity))).toBe(first)
  removeToken(stacks, first)
  expect(stacks.has(first.identity)).toBe(false)

  removeToken(stacks, first)
  expect(stacks.has(first.identity)).toBe(false)
})

test("token selection ignores inactive and staged excluded generations", () => {
  const first = token("first")
  const second = token("second")
  const third = token("third")
  second.active = false
  const stack = [first, second, third]

  expect(currentToken(stack)).toBe(third)
  expect(currentTokenExcept(stack, new Set([third]))).toBe(first)
  first.active = false
  expect(currentTokenExcept(stack, new Set([third]))).toBeNull()
  expect(currentToken(undefined)).toBeNull()
})
