import { expect, test } from "bun:test"

import {
  boundaryError,
  newKubernetesHttpError,
  newKubernetesTransportError
} from "../../src/client/errors"
import type { Fetch } from "@go-like/core/fetch"
import { kubernetesNamespace } from "../../src/client/names"
import { kubernetesOrigin } from "../../src/client/options"
import { newKubernetesClient } from "../../src/index"
import { managedByLabel } from "../../src/registry/codec"
import { conflict, gone, json, notFound, response, retryable } from "../../src/registry/http"
import { captureOptions, operationOptions } from "../../src/registry/options"
import { createSlice, updateSlice } from "../../src/registry/protocol"

const address = "https://kubernetes.example"

/** Creates one client. Token is omitted entirely when absent. */
function client(fetch: Fetch, token?: string) {
  if (token === undefined) return newKubernetesClient({ fetch, address })
  return newKubernetesClient({ fetch, address, token })
}

test("constructor options are captured, canonicalized, and validated without I/O", () => {
  let calls = 0
  const onRegistrationError = (): void => {}
  const captured = captureOptions(
    client(async function fetchKubernetes(): Promise<Response> {
      calls += 1
      return Response.json({})
    }, "secret"),
    {
      namespace: "go-like-test",
      owner: { name: "orders.pod", uid: "pod-uid" },
      retryInitialMs: 2,
      retryMaximumMs: 4,
      watchTimeoutSeconds: 5,
      watchBufferSize: 16,
      onRegistrationError
    }
  )
  expect(calls).toBe(0)
  expect(captured).toMatchObject({
    namespace: "go-like-test",
    owner: { name: "orders.pod", uid: "pod-uid" },
    token: "secret",
    retryInitialMs: 2,
    retryMaximumMs: 4,
    watchTimeoutSeconds: 5,
    watchBufferSize: 16,
    origin: "https://kubernetes.example"
  })
  expect(captured.owner).toEqual({ name: "orders.pod", uid: "pod-uid" })
  expect(Object.isFrozen(captured.owner)).toBe(true)
  expect(captured.common.onRegistrationError).toBe(onRegistrationError)
  expect(operationOptions(captured, captured.common, 7).timeoutMs).toBe(7)
  expect(kubernetesOrigin("http://127.0.0.1:6443")).toBe("http://127.0.0.1:6443")
  expect(kubernetesNamespace("default")).toBe("default")

  for (const value of [
    "ftp://kubernetes.example",
    "https://user@kubernetes.example",
    "https://kubernetes.example/path",
    "https://kubernetes.example?query",
    "https://kubernetes.example#",
    "not a URL"
  ]) {
    expect(() => kubernetesOrigin(value)).toThrow(TypeError)
  }
  for (const namespace of ["", "UPPER", "-leading", "x".repeat(64)]) {
    expect(() => kubernetesNamespace(namespace)).toThrow(TypeError)
  }
  const fetch = async (): Promise<Response> => Response.json({})
  for (const owner of [
    null,
    { name: "", uid: "uid" },
    { name: "UPPER", uid: "uid" },
    { name: "pod", uid: "" }
  ]) {
    expect(() =>
      captureOptions(client(fetch), {
        namespace: "default",
        owner: owner as never
      })
    ).toThrow(TypeError)
  }
  expect(() => captureOptions(client(fetch), null as never)).toThrow(TypeError)
  expect(() => newKubernetesClient({ fetch: null as never, address })).toThrow(TypeError)
  expect(() => client(fetch, "bad\nsecret")).toThrow(TypeError)
  expect(() => client(fetch, "bad\u0000secret")).toThrow(TypeError)
  expect(() =>
    captureOptions(client(fetch), {
      namespace: "default",
      retryInitialMs: 0
    })
  ).toThrow(RangeError)
  for (const watchBufferSize of [0, 4_097]) {
    expect(() =>
      captureOptions(client(fetch), {
        namespace: "default",
        watchBufferSize
      })
    ).toThrow(RangeError)
  }
})

test("HTTP boundary uses standard Request and keeps errors status-only and secret-safe", async () => {
  const requests: Request[] = []
  const provider = captureOptions(
    client(async function fetchKubernetes(request): Promise<Response> {
      requests.push(request)
      return Response.json({ ok: true })
    }, "secret"),
    { namespace: "default" }
  )
  const options = operationOptions(provider, provider.common)
  const signal = new AbortController().signal
  expect(await json(options, "list", "/version", "GET", null, signal)).toEqual({ ok: true })
  expect(requests[0]?.headers.get("Authorization")).toBe("Bearer secret")
  expect(requests[0]?.redirect).toBe("error")

  const denied = operationOptions(
    captureOptions(
      client(
        async () =>
          new Response(
            new ReadableStream({
              cancel(): void {
                throw new Error("cancel failed")
              }
            }),
            { status: 503 }
          )
      ),
      { namespace: "default" }
    ),
    options.common
  )
  await expect(response(denied, "get", "/denied", "GET", null, signal)).rejects.toMatchObject({
    name: "KubernetesHttpError",
    status: 503,
    operation: "registry.get"
  })

  const transportFailure = new Error("socket included secret")
  const secret = operationOptions(
    captureOptions(
      client(async () => {
        throw transportFailure
      }, "secret"),
      { namespace: "default" }
    ),
    options.common
  )
  const secretError = await response(secret, "list", "/list", "GET", null, signal).catch(
    (value: unknown) => value
  )
  expect(secretError).toMatchObject({
    code: "GO_LIKE_KUBERNETES_TRANSPORT",
    operation: "registry.list"
  })
  expect((secretError as Error).cause).not.toBe(transportFailure)

  const malformed = operationOptions(
    captureOptions(
      client(async () => new Response("{", { status: 200 })),
      { namespace: "default" }
    ),
    options.common
  )
  await expect(json(malformed, "get", "/bad", "GET", null, signal)).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
})

test("Kubernetes error classifiers remain structural and minimal", () => {
  const conflictError = newKubernetesHttpError("registry.update", 409)
  const missingError = newKubernetesHttpError("registry.get", 404)
  const goneError = newKubernetesHttpError("registry.watch", 410)
  expect(conflict(conflictError)).toBe(true)
  expect(notFound(missingError)).toBe(true)
  expect(gone(goneError)).toBe(true)
  expect(retryable(newKubernetesHttpError("registry.list", 429))).toBe(true)
  expect(retryable(newKubernetesHttpError("registry.list", 500))).toBe(true)
  expect(retryable(newKubernetesHttpError("registry.list", 400))).toBe(false)
  expect(retryable(newKubernetesHttpError("registry.list", 425))).toBe(false)
  expect(retryable(newKubernetesTransportError("registry.list", "offline", false))).toBe(true)
  expect(retryable({ code: "GO_LIKE_KUBERNETES_CONFIG_HTTP", status: 503 })).toBe(false)
  expect(retryable(null)).toBe(false)
  const exact = new Error("exact")
  expect(boundaryError(exact, "fallback")).toBe(exact)
  expect(boundaryError("invalid", "fallback").message).toBe("fallback")
})

test("mutation protocol rejects a foreign create or update readback", async () => {
  const provider = captureOptions(
    client(async () =>
      Response.json({
        metadata: {
          labels: { [managedByLabel]: "foreign-controller" }
        }
      })
    ),
    { namespace: "default" }
  )
  const options = operationOptions(provider, provider.common)
  const signal = new AbortController().signal
  await expect(createSlice(options, "{}", signal)).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
  await expect(updateSlice(options, "exact", "{}", signal)).rejects.toMatchObject({
    code: "GO_LIKE_REGISTRY_PROTOCOL"
  })
})
