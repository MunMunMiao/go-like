import { expect, test } from "bun:test"

import { background } from "@go-like/context"

import { newPlatformRuntimeState } from "../../src/runtime-state"

const originalFetch = globalThis.fetch
const keyPath = "/go-like/examples/enterprise-platform/runtime/aW5zdGFuY2VzL3BsYXRmb3JtLXRlc3Q"

function vaultRecord(revision: number): Response {
  return Response.json({
    data: {
      data: {
        version: 1,
        operation: "test-operation",
        value: "",
        metadata: { service: "enterprise-platform-runtime" }
      },
      metadata: { version: revision }
    }
  })
}

function installFetch(fetch: (request: Request) => Promise<Response>): typeof globalThis.fetch {
  function captured(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetch(new Request(input, init))
  }
  captured.preconnect = function preconnect(): void {}
  return captured
}

test("rejects a Vault publish whose fresh readback does not match", async () => {
  const actions: string[] = []
  globalThis.fetch = installFetch(async (request) => {
    actions.push(`${request.method}:${new URL(request.url).pathname}`)
    if (request.method === "POST") return Response.json({ data: { version: 1 } })
    return vaultRecord(2)
  })
  try {
    const state = newPlatformRuntimeState("http://vault.test", "token", "platform-test")

    await expect(state.publish(background())).rejects.toThrow("Vault runtime-state readback failed")
    expect(actions).toEqual([`POST:/v1/secret/data${keyPath}`, `GET:/v1/secret/data${keyPath}`])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("rejects a Vault cleanup whose record remains visible", async () => {
  const actions: string[] = []
  globalThis.fetch = installFetch(async (request) => {
    actions.push(`${request.method}:${new URL(request.url).pathname}`)
    if (request.method === "POST") return new Response(null, { status: 204 })
    return vaultRecord(1)
  })
  try {
    const state = newPlatformRuntimeState("http://vault.test", "token", "platform-test")

    await expect(state.remove(background())).rejects.toThrow("Vault runtime-state cleanup failed")
    expect(actions).toEqual([
      `GET:/v1/secret/data${keyPath}`,
      `POST:/v1/secret/delete${keyPath}`,
      `GET:/v1/secret/data${keyPath}`
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
