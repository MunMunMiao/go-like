import { background } from "@go-like/core/context"
import type { Registry, ServiceInstance, Watcher } from "@go-like/core/registry"
import type { RegistrationErrorHandler } from "@go-like/core/registry"

import type { Fetch } from "@go-like/core/fetch"
import { newKubernetesClient } from "../../src/index"
import * as KubernetesPackage from "../../src/registry/index"
import {
  newKubernetesRegistry,
  type KubernetesPodOwner,
  type KubernetesRegistry,
  type KubernetesRegistryOptions
} from "../../src/registry/index"

const fetchCapability: Fetch = async function fetchCapability(request: Request): Promise<Response> {
  return fetch(request)
}
const legacyFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch
/** Accepts a function only when its parameter list is exactly one Request. */
type RequestOnly<T extends (...args: never[]) => Promise<Response>> =
  Parameters<T> extends [Request] ? T : never
const acceptedFetch: RequestOnly<typeof fetchCapability> = fetchCapability
void acceptedFetch
const owner: KubernetesPodOwner = {
  name: "orders-pod",
  uid: "11111111-2222-3333-4444-555555555555"
}
const onRegistrationError: RegistrationErrorHandler = () => {}
const client = newKubernetesClient({
  fetch: fetchCapability,
  address: "https://kubernetes.example"
})
const options: KubernetesRegistryOptions = {
  namespace: "default",
  owner,
  onRegistrationError
}
const registry: Registry = newKubernetesRegistry(client, options)
const concrete: KubernetesRegistry = newKubernetesRegistry(client, options)
const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: {},
  endpoints: ["https://orders.example/"]
}
const registered: Promise<void> = registry.register(background(), instance)
const deregistered: Promise<void> = registry.deregister(background(), instance)
const discovered: Promise<readonly ServiceInstance[]> = registry.getService(
  background(),
  instance.name
)
const watcher: Promise<Watcher> = registry.watch(background(), instance.name)
void [concrete, registered, deregistered, discovered, watcher]

// @ts-expect-error (input, init) is not assignable to a one-Request Fetch.
const rejectedFetch: RequestOnly<typeof legacyFetch> = legacyFetch
void rejectedFetch
// @ts-expect-error RegistrationHandle is not part of the Kubernetes provider API.
void KubernetesPackage.RegistrationHandle
// @ts-expect-error Kubernetes cleanup is governed by Context and AbortSignal, not a drain error.
void KubernetesPackage.KubernetesDrainTimeoutError
// @ts-expect-error hardDrainTimeoutMs is not a Kubernetes constructor option.
const legacyOptions: KubernetesRegistryOptions = { ...options, hardDrainTimeoutMs: 1_000 }
void legacyOptions
// @ts-expect-error logger is not a Kubernetes registry option.
const loggedOptions: KubernetesRegistryOptions = { ...options, logger: null }
void loggedOptions
