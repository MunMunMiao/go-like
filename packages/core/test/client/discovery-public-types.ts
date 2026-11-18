import { newDiscoveryResolver, type DiscoveryResolver } from "../../src/registry/resolver"
import type { Discovery } from "../../src/registry"

export function discoveryPublicTypes(discovery: Discovery): DiscoveryResolver {
  return newDiscoveryResolver(discovery)
}
