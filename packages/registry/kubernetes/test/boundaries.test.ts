import { expect, test } from "bun:test"

import { managedByLabel } from "../src/codec"
import { boundaryError, newHttpError, newTransportError } from "../src/errors"
import { conflict, gone, json, notFound, response, retryable } from "../src/http"
import {
  captureOptions,
  kubernetesNamespace,
  kubernetesOrigin,
  operationOptions
} from "../src/options"
import { createSlice, updateSlice } from "../src/protocol"

test("constructor options are captured, canonicalized, and validated without I/O", () => {
  let calls = 0
  const onRegistrationError = (): void => {}
  const captured = captureOptions({
    async fetch(): Promise<Response> {
      calls += 1
      return Response.json({})
    },
    address: "https://kubernetes.example",
    namespace: "likego-test",
    owner: { name: "orders.pod", uid: "pod-uid" },
    token: "secret",
    retryInitialMs: 2,
    retryMaximumMs: 4,
    watchTimeoutSeconds: 5,
    watchBufferSize: 16,
    onRegistrationError
  })
  expect(calls).toBe(0)
  expect(captured).toMatchObject({
    namespace: "likego-test",
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

  for (const address of [
    "ftp://kubernetes.example",
    "https://user@kubernetes.example",
    "https://kubernetes.example/path",
    "https://kubernetes.example?query",
    "not a URL"
  ]) {
    expect(() => kubernetesOrigin(address)).toThrow(TypeError)
  }
  for (const namespace of ["", "UPPER", "-leading", "x".repeat(64)]) {
    expect(() => kubernetesNamespace(namespace)).toThrow(TypeError)
  }
  for (const owner of [
    null,
    { name: "", uid: "uid" },
    { name: "UPPER", uid: "uid" },
    { name: "pod", uid: "" }
  ]) {
    expect(() =>
      captureOptions({
        fetch: async () => Response.json({}),
        address: "https://kubernetes.example",
        namespace: "default",
        owner: owner as never
      })
    ).toThrow(TypeError)
  }
  expect(() => captureOptions(null as never)).toThrow(TypeError)
  expect(() =>
    captureOptions({
      fetch: null as never,
      address: "https://kubernetes.example",
      namespace: "default"
    })
  ).toThrow(TypeError)
  expect(() =>
    captureOptions({
      fetch: async () => Response.json({}),
      address: "https://kubernetes.example",
      namespace: "default",
      token: "bad\nsecret"
    })
  ).toThrow(TypeError)
  expect(() =>
    captureOptions({
      fetch: async () => Response.json({}),
      address: "https://kubernetes.example",
      namespace: "default",
      token: "bad\u0000secret"
    })
  ).toThrow(TypeError)
  expect(() =>
    captureOptions({
      fetch: async () => Response.json({}),
      address: "https://kubernetes.example",
      namespace: "default",
      retryInitialMs: 0
    })
  ).toThrow(RangeError)
  for (const watchBufferSize of [0, 4_097]) {
    expect(() =>
      captureOptions({
        fetch: async () => Response.json({}),
        address: "https://kubernetes.example",
        namespace: "default",
        watchBufferSize
      })
    ).toThrow(RangeError)
  }
})

test("HTTP boundary uses standard Request and keeps errors status-only and secret-safe", async () => {
  const requests: Request[] = []
  const provider = captureOptions({
    async fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json({ ok: true })
    },
    address: "https://kubernetes.example",
    namespace: "default",
    token: "secret"
  })
  const options = operationOptions(provider, provider.common)
  const signal = new AbortController().signal
  expect(await json(options, "list", "/version", "GET", null, signal)).toEqual({ ok: true })
  expect(requests[0]?.headers.get("Authorization")).toBe("Bearer secret")
  expect(requests[0]?.redirect).toBe("error")

  const denied = operationOptions(
    captureOptions({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel(): void {
              throw new Error("cancel failed")
            }
          }),
          { status: 503 }
        ),
      address: "https://kubernetes.example",
      namespace: "default"
    }),
    options.common
  )
  await expect(response(denied, "get", "/denied", "GET", null, signal)).rejects.toMatchObject({
    name: "KubernetesHttpError",
    status: 503
  })

  const transportFailure = new Error("socket included secret")
  const secret = operationOptions(
    captureOptions({
      fetch: async () => {
        throw transportFailure
      },
      address: "https://kubernetes.example",
      namespace: "default",
      token: "secret"
    }),
    options.common
  )
  const secretError = await response(secret, "list", "/list", "GET", null, signal).catch(
    (value: unknown) => value
  )
  expect(secretError).toMatchObject({
    code: "LIKEGO_KUBERNETES_TRANSPORT",
    operation: "list"
  })
  expect((secretError as Error).cause).not.toBe(transportFailure)

  const malformed = operationOptions(
    captureOptions({
      fetch: async () => new Response("{", { status: 200 }),
      address: "https://kubernetes.example",
      namespace: "default"
    }),
    options.common
  )
  await expect(json(malformed, "get", "/bad", "GET", null, signal)).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })
})

test("Kubernetes error classifiers remain structural and minimal", () => {
  const conflictError = newHttpError("update", 409)
  const missingError = newHttpError("get", 404)
  const goneError = newHttpError("watch", 410)
  expect(conflict(conflictError)).toBe(true)
  expect(notFound(missingError)).toBe(true)
  expect(gone(goneError)).toBe(true)
  expect(retryable(newHttpError("list", 429))).toBe(true)
  expect(retryable(newHttpError("list", 500))).toBe(true)
  expect(retryable(newHttpError("list", 400))).toBe(false)
  expect(retryable(newTransportError("list", "offline", false))).toBe(true)
  expect(retryable(null)).toBe(false)
  const exact = new Error("exact")
  expect(boundaryError(exact, "fallback")).toBe(exact)
  expect(boundaryError("invalid", "fallback").message).toBe("fallback")
})

test("mutation protocol rejects a foreign create or update readback", async () => {
  const provider = captureOptions({
    fetch: async () =>
      Response.json({
        metadata: {
          labels: { [managedByLabel]: "foreign-controller" }
        }
      }),
    address: "https://kubernetes.example",
    namespace: "default"
  })
  const options = operationOptions(provider, provider.common)
  const signal = new AbortController().signal
  await expect(createSlice(options, "{}", signal)).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })
  await expect(updateSlice(options, "exact", "{}", signal)).rejects.toMatchObject({
    code: "LIKEGO_REGISTRY_PROTOCOL"
  })
})
