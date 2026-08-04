import type { ConfigSource } from "@go-like/config"
import { background } from "@go-like/context"

import * as KubernetesConfig from "../src/index"
import {
  kubernetesSource,
  type KubernetesConfigHttpError,
  type KubernetesConfigProtocolError,
  type KubernetesConfigTransportError,
  type KubernetesFetch,
  type KubernetesSourceOptions
} from "../src/index"

const fetch: KubernetesFetch = async function fetchKubernetes(request: Request): Promise<Response> {
  return new Response(request.url)
}
const options: KubernetesSourceOptions = {
  fetch,
  address: "https://kubernetes.example",
  namespace: "orders",
  kind: "ConfigMap",
  name: "orders-config",
  key: "config.json"
}
const source: ConfigSource = kubernetesSource(options)
const loaded = source.load(background())
const httpError: KubernetesConfigHttpError | null = null
const protocolError: KubernetesConfigProtocolError | null = null
const transportError: KubernetesConfigTransportError | null = null
void [loaded, httpError, protocolError, transportError]

// @ts-expect-error Standard Fetch injection is required.
kubernetesSource({ address: "https://kubernetes.example", namespace: "orders" })
// @ts-expect-error Fetch accepts one standard Request rather than a URL string.
fetch("https://kubernetes.example")
// @ts-expect-error The package has no PascalCase factory alias.
KubernetesConfig.KubernetesSource
