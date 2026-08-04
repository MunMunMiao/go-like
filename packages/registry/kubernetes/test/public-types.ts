import { background } from "@go-like/context"
import type { Registry, ServiceInstance, Watcher } from "@go-like/registry"
import type { RegistrationErrorHandler } from "@go-like/registry/provider"

import * as KubernetesPackage from "../src/index"
import {
  newKubernetesRegistry,
  type KubernetesFetch,
  type KubernetesPodOwner,
  type KubernetesRegistry,
  type KubernetesRegistryOptions
} from "../src/index"

const fetchCapability: KubernetesFetch = async function fetchCapability(
  _input: RequestInfo | URL,
  _init?: RequestInit
): Promise<Response> {
  return Response.json({})
}
const owner: KubernetesPodOwner = {
  name: "orders-pod",
  uid: "11111111-2222-3333-4444-555555555555"
}
const onRegistrationError: RegistrationErrorHandler = () => {}
const options: KubernetesRegistryOptions = {
  fetch: fetchCapability,
  address: "https://kubernetes.example",
  namespace: "default",
  owner,
  onRegistrationError
}
const registry: Registry = newKubernetesRegistry(options)
const concrete: KubernetesRegistry = newKubernetesRegistry(options)
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

// @ts-expect-error RegistrationHandle is not part of the Kubernetes provider API.
KubernetesPackage.RegistrationHandle
// @ts-expect-error Kubernetes cleanup is governed by Context and AbortSignal, not a drain error.
KubernetesPackage.KubernetesDrainTimeoutError
// @ts-expect-error hardDrainTimeoutMs is not a Kubernetes constructor option.
const legacyOptions: KubernetesRegistryOptions = { ...options, hardDrainTimeoutMs: 1_000 }
void legacyOptions
