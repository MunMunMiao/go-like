import { expect, test } from "bun:test"

import { canceled, type Context } from "@go-like/context"

import { contextHandler } from "../src/index"

test("returns the exact synchronous Response, headers, body, and stream", async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
    }
  })
  const headers = new Headers({ "x-go-like": "identity" })
  const expectedResponse = new Response(stream, { headers })
  const expectedHeaders = expectedResponse.headers
  const expectedBody = expectedResponse.body
  let observedContext: Context | null = null
  const fetchHandler = contextHandler((ctx) => {
    observedContext = ctx
    return expectedResponse
  })

  const response = fetchHandler(new Request("https://example.test/"))

  expect(response).toBe(expectedResponse)
  expect(response).toBeInstanceOf(Response)
  const exactResponse = response as Response
  expect(exactResponse.headers).toBe(expectedHeaders)
  expect(exactResponse.body).toBe(expectedBody)
  expect((observedContext as Context | null)?.err()).toBe(canceled)

  const bytes = new TextEncoder().encode("after return")
  ;(streamController as ReadableStreamDefaultController<Uint8Array> | null)?.enqueue(bytes)
  ;(streamController as ReadableStreamDefaultController<Uint8Array> | null)?.close()
  const chunk = await exactResponse.body?.getReader().read()
  expect(chunk?.value).toEqual(bytes)
  expect(chunk?.done).toBe(false)
})

test("preserves Response identity through an asynchronous handler", async () => {
  const expectedResponse = new Response("async")
  const fetchHandler = contextHandler(async () => expectedResponse)

  await expect(fetchHandler(new Request("https://example.test/"))).resolves.toBe(expectedResponse)
})

test("keeps a synchronous Response synchronous without relying on the local realm constructor", () => {
  const foreignRealmResponse = new Response("foreign realm")
  Object.setPrototypeOf(foreignRealmResponse, null)
  expect(foreignRealmResponse instanceof Response).toBe(false)
  const fetchHandler = contextHandler(() => foreignRealmResponse)

  const response = fetchHandler(new Request("https://example.test/"))

  expect(response).toBe(foreignRealmResponse)
  expect(response).not.toBeInstanceOf(Promise)
})

test("does not mutate, decorate, or consume the Request", async () => {
  const request = new Request("https://example.test/", {
    method: "POST",
    body: "payload"
  })
  const keysBefore = Reflect.ownKeys(request)
  const descriptorsBefore = Object.getOwnPropertyDescriptors(request)
  let observedRequest: Request | null = null
  const fetchHandler = contextHandler((_ctx, nextRequest) => {
    observedRequest = nextRequest
    return new Response("ok")
  })

  await fetchHandler(request)

  expect(observedRequest as Request | null).toBe(request)
  expect(Reflect.ownKeys(request)).toEqual(keysBefore)
  expect(Object.getOwnPropertyDescriptors(request)).toEqual(descriptorsBefore)
  expect(request.bodyUsed).toBe(false)
})
