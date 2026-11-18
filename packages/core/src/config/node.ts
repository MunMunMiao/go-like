import type { FileCapability } from "./file"
import { newNodeFileCapability as createNodeFileCapability } from "./node-host"

/** Creates a Node filesystem capability for portable @go-like/core/config file sources. */
export function newNodeFileCapability(): FileCapability {
  return createNodeFileCapability()
}
