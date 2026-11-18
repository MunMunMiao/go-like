import type { ZookeeperClientFactory } from "../types"

import { newNativeZookeeperClient } from "./native"

/** Returns the Node.js ZooKeeper client factory. */
export function newNodeZookeeperClientFactory(): ZookeeperClientFactory {
  return newNativeZookeeperClient
}
