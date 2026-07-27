import type { FileStoreHost } from "./types"
import { newNodeFileStoreHost as newHost } from "./node-host"

/** Creates the Node.js filesystem host without performing I/O. */
export function newNodeFileStoreHost(): FileStoreHost {
  return newHost()
}
