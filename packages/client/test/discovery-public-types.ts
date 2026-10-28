import { newDiscoveryResolver, type DiscoveryResolver } from "@go-like/client/discovery"
import type { Discovery } from "@go-like/registry"

export function discoveryPublicTypes(discovery: Discovery): DiscoveryResolver {
  return newDiscoveryResolver(discovery)
}
