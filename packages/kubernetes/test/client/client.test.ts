import { expect, test } from "bun:test"

import { background } from "@go-like/core/context"

import { openKubernetesClient } from "../../src/client/client"
import {
  boundaryError,
  configOperation,
  newKubernetesHttpError,
  newKubernetesProtocolError,
  newKubernetesTransportError,
  registryOperation
} from "../../src/client/errors"
import {
  configWatchExpired,
  kubernetesHeaders,
  retryableConfigFailure
} from "../../src/client/http"
import {
  kubernetesKey,
  kubernetesNamespace,
  kubernetesPodOwner,
  kubernetesResourceName
} from "../../src/client/names"
import { captureConnection, kubernetesOrigin } from "../../src/client/options"
import { kubernetesSource } from "../../src/config/index"
import { newKubernetesClient } from "../../src/index"
import * as root from "../../src/index"
import * as registry from "../../src/registry/index"
import { newKubernetesRegistry } from "../../src/registry/index"
import { captureOptions } from "../../src/registry/options"
import * as config from "../../src/config/index"

const address = "https://kubernetes.example"

/** Returns one idle Fetch capability. */
const idle = async function idle(): Promise<Response> {
  return new Response(null, { status: 204 })
}

/** Returns one valid ConfigMap for the shared source. */
function configMap(revision = "1"): Response {
  return Response.json({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { namespace: "orders", name: "orders-config", resourceVersion: revision },
    data: { "config.json": "{}" }
  })
}

const sourceOptions = {
  namespace: "orders",
  configMap: "orders-config",
  key: "config.json"
} as const

test("one client is accepted by registry and config and a foreign object is rejected", () => {
  const client = newKubernetesClient({ fetch: idle, address })
  expect(Object.keys(client)).toEqual([])
  expect(Object.getOwnPropertySymbols(client)).toEqual([])
  expect(Object.isFrozen(client)).toBe(true)
  expect(Object.keys(newKubernetesRegistry(client, { namespace: "default" })).sort()).toEqual([
    "deregister",
    "getService",
    "register",
    "watch"
  ])
  expect(kubernetesSource(client, sourceOptions).name).toBe("kubernetes")
  expect(openKubernetesClient(client).origin).toBe(address)
  expect(openKubernetesClient(client).token).toBeUndefined()
  expect(() => newKubernetesClient(null as never)).toThrow(
    "Kubernetes client options must be an object"
  )
  expect(() => newKubernetesRegistry({} as never, { namespace: "default" })).toThrow(
    "Kubernetes client must be created by newKubernetesClient"
  )
  expect(() => newKubernetesRegistry(client, null as never)).toThrow(
    "Kubernetes Registry options must be an object"
  )
  expect(() => kubernetesSource({} as never, sourceOptions)).toThrow(
    "Kubernetes client must be created by newKubernetesClient"
  )
  expect(() => kubernetesSource(null as never, sourceOptions)).toThrow(
    "Kubernetes client must be created by newKubernetesClient"
  )
  expect(() => kubernetesSource(client, null as never)).toThrow(
    "Kubernetes options must be an object"
  )
  expect(() => captureOptions({} as never, { namespace: "default" })).toThrow(
    "Kubernetes client must be created by newKubernetesClient"
  )
  expect(Object.keys(root).sort()).toEqual(["newKubernetesClient"])
  expect(Object.keys(registry).sort()).toEqual(["newKubernetesRegistry"])
  expect(Object.keys(config).sort()).toEqual(["kubernetesSource"])
})

test("validates address and token once and sends Bearer only when a token is set", async () => {
  expect(kubernetesOrigin("http://127.0.0.1:6443")).toBe("http://127.0.0.1:6443")
  expect(() => kubernetesOrigin(1 as never)).toThrow("Kubernetes address must be a string")
  expect(() => kubernetesOrigin("not a url?private-address")).toThrow(
    "Kubernetes address must be a valid HTTP or HTTPS origin"
  )
  expect(
    String(
      (() => {
        try {
          newKubernetesClient({ fetch: idle, address: "https://private.example/path" })
        } catch (error) {
          return error
        }
        return new Error("invalid address unexpectedly succeeded")
      })()
    )
  ).not.toContain("private")
  expect(() => newKubernetesClient({ fetch: idle, address, token: "private\r\ninjected" })).toThrow(
    "Kubernetes token must be a non-empty HTTP header value"
  )
  expect(() =>
    newKubernetesClient({ fetch: idle, address, token: "private\u0000injected" })
  ).toThrow("Kubernetes token must be a valid HTTP header value")
  expect(() => newKubernetesClient({ fetch: true as never, address })).toThrow(
    "Kubernetes Fetch capability must be callable"
  )
  const captured = captureConnection({ fetch: idle, address, token: "abc" })
  expect(captured.token).toBe("abc")
  expect(Object.isFrozen(captured)).toBe(true)

  let authorization: string | null = "unset"
  const authed = kubernetesSource(
    newKubernetesClient({
      address,
      token: "abc",
      async fetch(request) {
        authorization = request.headers.get("Authorization")
        return configMap()
      }
    }),
    sourceOptions
  )
  await expect(authed.load(background())).resolves.toEqual({ value: {}, revision: "1" })
  expect(authorization).toBe("Bearer abc")

  let sawAuthorization = false
  const anonymous = kubernetesSource(
    newKubernetesClient({
      address,
      async fetch(request) {
        sawAuthorization = request.headers.has("Authorization")
        return configMap()
      }
    }),
    sourceOptions
  )
  await anonymous.load(background())
  expect(sawAuthorization).toBe(false)
  expect(kubernetesHeaders("abc", true).get("Authorization")).toBe("Bearer abc")
  expect(kubernetesHeaders("abc", true).get("Content-Type")).toBe("application/json")
  expect(kubernetesHeaders(undefined, false).has("Authorization")).toBe(false)
  expect(kubernetesHeaders(undefined, false).has("Content-Type")).toBe(false)
})

test("shared errors are frozen, prefixed, and secret-safe at a token boundary", async () => {
  for (const operation of ["create", "delete", "get", "list", "update", "watch"] as const) {
    expect(registryOperation(operation)).toBe(`registry.${operation}`)
  }
  for (const operation of ["get", "list", "watch"] as const) {
    expect(configOperation(operation)).toBe(`config.${operation}`)
  }
  const httpError = newKubernetesHttpError("config.get", 403)
  const protocolError = newKubernetesProtocolError("registry.watch")
  expect(Object.isFrozen(httpError)).toBe(true)
  expect(Object.isFrozen(protocolError)).toBe(true)
  expect(httpError.message).toBe("Kubernetes config.get request failed with HTTP 403")
  expect(protocolError.message).toBe("Kubernetes registry.watch response violated the protocol")
  expect(Object.keys(httpError).sort()).toEqual(["code", "name", "operation", "status"])

  const exact = new Error("exact cause")
  expect(boundaryError(exact, "fallback")).toBe(exact)
  const narrowed = boundaryError("invalid", "fallback")
  expect(narrowed).toBeInstanceOf(Error)
  expect(narrowed.message).toBe("fallback")

  const plain = new Error("visible transport")
  const open = newKubernetesTransportError("config.list", plain, false)
  expect(open.cause).toBe(plain)
  expect(open.message).toBe("Kubernetes config.list transport failed")
  const redacted = newKubernetesTransportError("config.list", new Error("token=secret"), true)
  expect(redacted.cause).not.toBeInstanceOf(TypeError)
  expect(redacted.cause.message).toBe(
    "Kubernetes config.list transport rejected at a secret-bearing boundary"
  )
  expect(String(redacted.cause)).not.toContain("token=secret")
  expect(Object.isFrozen(redacted)).toBe(true)

  const leaked = new Error("token=secret-value")
  const secretSource = kubernetesSource(
    newKubernetesClient({
      address,
      token: "secret-value",
      fetch() {
        throw leaked
      }
    }),
    sourceOptions
  )
  const secretFailure = await secretSource.load(background()).catch((error: unknown) => error)
  expect(secretFailure).toMatchObject({
    name: "KubernetesTransportError",
    code: "GO_LIKE_KUBERNETES_TRANSPORT",
    operation: "config.get"
  })
  expect((secretFailure as Error).cause).not.toBe(leaked)
  expect(String((secretFailure as Error).cause)).not.toContain("secret-value")

  const visible = new Error("visible")
  const plainSource = kubernetesSource(
    newKubernetesClient({
      address,
      fetch() {
        throw visible
      }
    }),
    sourceOptions
  )
  const plainFailure = await plainSource.load(background()).catch((error: unknown) => error)
  expect((plainFailure as Error).cause).toBe(visible)

  const nonError = kubernetesSource(
    newKubernetesClient({
      address,
      fetch() {
        throw "not-an-error"
      }
    }),
    sourceOptions
  )
  const nonErrorFailure = await nonError.load(background()).catch((error: unknown) => error)
  expect((nonErrorFailure as { cause: Error }).cause.message).toBe(
    "Kubernetes config.get transport rejected with a non-Error value"
  )
})

test("config retry classification keeps 425 and drops the retired HTTP code", () => {
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_TRANSPORT" })).toBe(true)
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 408 })).toBe(true)
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 425 })).toBe(true)
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 429 })).toBe(true)
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 500 })).toBe(true)
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: 200 })).toBe(false)
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_HTTP", status: "503" })).toBe(false)
  expect(retryableConfigFailure({ code: "GO_LIKE_KUBERNETES_CONFIG_HTTP", status: 503 })).toBe(
    false
  )
  expect(retryableConfigFailure(null)).toBe(false)
  expect(configWatchExpired({ code: "GO_LIKE_KUBERNETES_HTTP", status: 410 })).toBe(true)
  expect(configWatchExpired({ code: "GO_LIKE_KUBERNETES_HTTP", status: 404 })).toBe(false)
  expect(configWatchExpired({ code: "GO_LIKE_KUBERNETES_CONFIG_HTTP", status: 410 })).toBe(false)
})

test("name and owner validators keep the stricter acceptance set", () => {
  expect(kubernetesNamespace("a")).toBe("a")
  expect(() => kubernetesNamespace("A")).toThrow("DNS-1123 label")
  expect(kubernetesResourceName("orders.config")).toBe("orders.config")
  expect(() => kubernetesResourceName("")).toThrow("DNS subdomain")
  expect(kubernetesKey("config.json")).toBe("config.json")
  expect(() => kubernetesKey("bad/key")).toThrow("letters, digits")
  expect(kubernetesPodOwner(undefined)).toBeNull()
  expect(() => kubernetesPodOwner(null as never)).toThrow("must identify one Pod")
  expect(() => kubernetesPodOwner([] as never)).toThrow("must identify one Pod")
  expect(() => kubernetesPodOwner({ name: "Bad", uid: "uid" })).toThrow("DNS-1123 subdomain")
  expect(() => kubernetesPodOwner({ name: "pod", uid: "" })).toThrow("non-empty string")
  expect(kubernetesPodOwner({ name: "orders.pod", uid: "uid" })).toEqual({
    name: "orders.pod",
    uid: "uid"
  })
})

test("registry option forwarding drops logger and covers each provider input shape", () => {
  const client = newKubernetesClient({ fetch: idle, address })
  const onRegistrationError = (): void => {}
  const both = captureOptions(client, {
    namespace: "default",
    onRegistrationError,
    timeoutMs: 5
  })
  expect(both.common.onRegistrationError).toBe(onRegistrationError)
  expect(both.common.timeoutMs).toBe(5)
  const handlerOnly = captureOptions(client, { namespace: "default", onRegistrationError })
  expect(handlerOnly.common.onRegistrationError).toBe(onRegistrationError)
  const timeoutOnly = captureOptions(client, { namespace: "default", timeoutMs: 9 })
  expect(timeoutOnly.common.timeoutMs).toBe(9)
  expect(timeoutOnly.token).toBeUndefined()
  const bare = captureOptions(client, { namespace: "default" })
  expect(bare.owner).toBeNull()
})
