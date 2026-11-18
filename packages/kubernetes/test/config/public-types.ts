import type { ConfigSource } from "@go-like/core/config"
import { background } from "@go-like/core/context"

import type { Fetch } from "@go-like/core/fetch"
import {
  newKubernetesClient,
  type KubernetesHttpError,
  type KubernetesProtocolError,
  type KubernetesTransportError
} from "../../src/index"
import * as KubernetesConfig from "../../src/config/index"
import { kubernetesSource, type KubernetesSourceOptions } from "../../src/config/index"

const fetchKubernetes: Fetch = async function fetchKubernetes(request: Request): Promise<Response> {
  return new Response(request.url)
}
const legacyFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch
/** Accepts a function only when its parameter list is exactly one Request. */
type RequestOnly<T extends (...args: never[]) => Promise<Response>> =
  Parameters<T> extends [Request] ? T : never
const acceptedFetch: RequestOnly<typeof fetchKubernetes> = fetchKubernetes
void acceptedFetch
const client = newKubernetesClient({
  fetch: fetchKubernetes,
  address: "https://kubernetes.example"
})
const options: KubernetesSourceOptions = {
  namespace: "orders",
  configMap: "orders-config",
  key: "config.json"
}
const source: ConfigSource = kubernetesSource(client, options)
const loaded = source.load(background())
const httpError: KubernetesHttpError | null = null
const protocolError: KubernetesProtocolError | null = null
const transportError: KubernetesTransportError | null = null
void [loaded, httpError, protocolError, transportError]

// @ts-expect-error (input, init) is not assignable to a one-Request Fetch.
const rejectedFetch: RequestOnly<typeof legacyFetch> = legacyFetch
void rejectedFetch
// @ts-expect-error A source requires a client created by newKubernetesClient.
kubernetesSource({ namespace: "orders", configMap: "orders-config", key: "config.json" })
// @ts-expect-error Fetch accepts one standard Request rather than a URL string.
fetchKubernetes("https://kubernetes.example")
// @ts-expect-error Exactly one of configMap or secret.
kubernetesSource(client, {
  namespace: "orders",
  configMap: "orders-config",
  secret: "orders-secret",
  key: "config.json"
})
// @ts-expect-error The package has no PascalCase factory alias.
void KubernetesConfig.KubernetesSource
// @ts-expect-error jsonKubernetesDecoder is no longer a public decoder.
void KubernetesConfig.jsonKubernetesDecoder
