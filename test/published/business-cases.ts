import {
  newBusinessCaseRegistry,
  type PublishedBusinessCaseRegistry
} from "../../scripts/published/business-cases"

import { registerIntegrationCases } from "./cases/integrations"
import { registerNodeServiceCases } from "./cases/node-services"
import { registerPortableCases } from "./cases/portable"
import { registerCompletionCases } from "./cases/completion"

/**
 * Creates the complete fail-closed registry of published package behavior and type consumers.
 *
 * @returns A newly populated registry with one case per release-blocking package.
 */
export function publishedBusinessCases(): PublishedBusinessCaseRegistry {
  const registry = newBusinessCaseRegistry()
  registerPortableCases(registry)
  registerNodeServiceCases(registry)
  registerIntegrationCases(registry)
  registerCompletionCases(registry)
  return registry
}
