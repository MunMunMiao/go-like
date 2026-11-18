import { expect, test } from "bun:test"

import { background } from "@go-like/core/context"
import { newVaultClient } from "@go-like/vault"

import { newPlatformRuntimeState } from "../../src/runtime-state"

const keyPath = "/go-like/examples/enterprise-platform/runtime/aW5zdGFuY2VzL3BsYXRmb3JtLXRlc3Q"

function vaultRecord(revision: number, service = "enterprise-platform-runtime"): Response {
  return Response.json({
    data: {
      data: {
        version: 1,
        operation: "test-operation",
        value: "",
        metadata: { service }
      },
      metadata: { version: revision }
    }
  })
}

function state(fetch: (request: Request) => Promise<Response>) {
  return newPlatformRuntimeState(
    newVaultClient({
      fetch,
      address: "http://vault.test",
      token: "token"
    }),
    "platform-test"
  )
}

for (const mismatch of ["revision", "service"] as const) {
  test(`rejects a Vault publish with mismatched ${mismatch} readback`, async () => {
    const actions: string[] = []
    const runtime = state(async (request) => {
      actions.push(`${request.method}:${new URL(request.url).pathname}`)
      if (request.method === "POST") return Response.json({ data: { version: 1 } })
      return vaultRecord(
        mismatch === "revision" ? 2 : 1,
        mismatch === "service" ? "other-service" : "enterprise-platform-runtime"
      )
    })

    await expect(runtime.publish(background())).rejects.toThrow(
      "Vault runtime-state readback failed"
    )
    expect(actions).toEqual([`POST:/v1/secret/data${keyPath}`, `GET:/v1/secret/data${keyPath}`])
  })
}

test("rejects a Vault cleanup whose record remains visible", async () => {
  const actions: string[] = []
  const runtime = state(async (request) => {
    actions.push(`${request.method}:${new URL(request.url).pathname}`)
    if (request.method === "POST") return new Response(null, { status: 204 })
    return vaultRecord(1)
  })

  await expect(runtime.remove(background())).rejects.toThrow("Vault runtime-state cleanup failed")
  expect(actions).toEqual([
    `GET:/v1/secret/data${keyPath}`,
    `POST:/v1/secret/delete${keyPath}`,
    `GET:/v1/secret/data${keyPath}`
  ])
})
