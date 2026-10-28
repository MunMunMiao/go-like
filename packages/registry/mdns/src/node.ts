import type { MDNSHost } from "./types"
import { newNodeMDNSHost as newHost } from "./node-host"

/** Creates the Node.js UDP multicast host without allocating a socket. */
export function newNodeMDNSHost(): MDNSHost {
  return newHost()
}
