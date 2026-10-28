import { expect, test } from "bun:test"

import { newEtcdStore } from "../src/index"

test("construction captures borrowed Fetch without performing I/O", () => {
  let calls = 0
  const store = newEtcdStore({
    address: "http://127.0.0.1:2379",
    async fetch() {
      calls += 1
      return new Response()
    }
  })
  expect(calls).toBe(0)
  expect(store.string()).toBe("etcd")
})
