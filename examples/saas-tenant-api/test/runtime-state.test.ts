import { expect, test } from "bun:test"

import { background } from "@go-like/context"

import { newTenantRuntimeState } from "../src/runtime-state"

const originalFetch = globalThis.fetch
const key = "go-like/examples/saas-tenant-api/runtime/instances/tenant-test"

function consulRecord(payload: string, revision: number): Response {
  return Response.json([
    {
      Key: key,
      ModifyIndex: revision,
      Value: Buffer.from(payload).toString("base64"),
      Session: null
    }
  ])
}

function existingPayload(): string {
  return JSON.stringify({
    version: 1,
    operation: "test-operation",
    value: "",
    metadata: { service: "saas-tenant-api" },
    expiresAt: null
  })
}

function installFetch(fetch: (request: Request) => Promise<Response>): typeof globalThis.fetch {
  function captured(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetch(new Request(input, init))
  }
  captured.preconnect = function preconnect(): void {}
  return captured
}

test("rejects a Consul publish whose fresh readback does not match", async () => {
  const actions: string[] = []
  let payload = ""
  let reads = 0
  globalThis.fetch = installFetch(async (request) => {
    actions.push(`${request.method}:${new URL(request.url).pathname}`)
    if (request.method === "PUT") {
      payload = await request.text()
      return new Response("true")
    }
    reads += 1
    if (reads === 1) return new Response(null, { status: 404 })
    return consulRecord(payload, reads === 2 ? 1 : 2)
  })
  try {
    const state = newTenantRuntimeState("http://consul.test", "tenant-test")

    await expect(state.publish(background())).rejects.toThrow(
      "Consul runtime-state readback failed"
    )
    expect(actions).toEqual([
      `GET:/v1/kv/${key}`,
      `PUT:/v1/kv/${key}`,
      `GET:/v1/kv/${key}`,
      `GET:/v1/kv/${key}`
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("rejects a Consul cleanup whose record remains visible", async () => {
  const actions: string[] = []
  globalThis.fetch = installFetch(async (request) => {
    actions.push(`${request.method}:${new URL(request.url).pathname}`)
    if (request.method === "DELETE") return new Response("true")
    return consulRecord(existingPayload(), 1)
  })
  try {
    const state = newTenantRuntimeState("http://consul.test", "tenant-test")

    await expect(state.remove(background())).rejects.toThrow("Consul runtime-state cleanup failed")
    expect(actions).toEqual([`GET:/v1/kv/${key}`, `DELETE:/v1/kv/${key}`, `GET:/v1/kv/${key}`])
  } finally {
    globalThis.fetch = originalFetch
  }
})
