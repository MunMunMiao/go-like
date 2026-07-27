import type { Registry } from "@likego/registry"
import { domain, interfaces, newMDNSRegistry, type MDNSOption } from "@likego/registry-mdns"
import { newNodeMDNSHost } from "@likego/registry-mdns/node"

export type KitchenRegistryEnvironment = Readonly<Record<string, string | undefined>>

/** Creates real LAN registration only when the operator explicitly enables mDNS. */
export function kitchenRegistryFromEnvironment(
  environment: KitchenRegistryEnvironment
): Registry | null {
  const enabled = environment.MDNS_REGISTRY
  if (enabled === undefined) return null
  if (enabled !== "1") throw new TypeError("MDNS_REGISTRY must be 1 when provided")
  const networkInterface = environment.MDNS_INTERFACE
  if (networkInterface === undefined || networkInterface === "") {
    throw new TypeError("MDNS_INTERFACE is required when MDNS_REGISTRY=1")
  }
  const options: MDNSOption[] = [interfaces(networkInterface)]
  const selectedDomain = environment.MDNS_DOMAIN
  if (selectedDomain !== undefined) options.push(domain(selectedDomain))
  return newMDNSRegistry(newNodeMDNSHost(), ...options)
}
