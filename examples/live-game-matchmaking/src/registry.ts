import type { Registry } from "@go-like/registry"
import { newKubernetesRegistry } from "@go-like/registry-kubernetes"

export type GameRegistryEnvironment = Readonly<Record<string, string | undefined>>

/** Creates real EndpointSlice registration only when a Kubernetes API address is supplied. */
export function gameRegistryFromEnvironment(environment: GameRegistryEnvironment): Registry | null {
  const address = environment.KUBERNETES_API_ADDRESS
  if (address === undefined) return null
  if (address === "") throw new TypeError("KUBERNETES_API_ADDRESS must not be empty")
  const namespace = environment.KUBERNETES_NAMESPACE ?? "default"
  const token = environment.KUBERNETES_TOKEN
  if (token === undefined) return newKubernetesRegistry({ fetch, address, namespace })
  if (token === "") throw new TypeError("KUBERNETES_TOKEN must not be empty")
  return newKubernetesRegistry({ fetch, address, namespace, token })
}
