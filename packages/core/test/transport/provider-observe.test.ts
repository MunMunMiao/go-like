import { expect, test } from "bun:test"

import { observeResponseBody } from "../../src/transport/provider"

test("the public body observer reports a null body and a canceled stream", async () => {
  const ends: string[] = []
  const empty = observeResponseBody(new Response(null, { status: 204 }), (end) => {
    ends.push(end.reason)
  })
  expect(empty.status).toBe(204)
  expect(ends).toEqual(["end"])

  const controller = new AbortController()
  const body = observeResponseBody(
    new Response(new ReadableStream()),
    (end) => {
      ends.push(end.reason)
    },
    { signal: controller.signal }
  )
  controller.abort(new Error("stop"))
  await expect(body.text()).rejects.toThrow()
  expect(ends).toContain("cancel")
})
