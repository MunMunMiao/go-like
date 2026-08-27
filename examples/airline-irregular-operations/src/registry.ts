import type { Registry } from "@go-like/registry"
import { newZookeeperRegistry } from "@go-like/registry-zookeeper"

export type AirlineRegistryEnvironment = Readonly<Record<string, string | undefined>>

/** Creates real ZooKeeper registration only when an ensemble address is supplied. */
export function airlineRegistryFromEnvironment(
  environment: AirlineRegistryEnvironment
): Registry | null {
  const address = environment.ZOOKEEPER_ADDRESS
  if (address === undefined) return null
  if (address === "") throw new TypeError("ZOOKEEPER_ADDRESS must not be empty")
  const root = environment.ZOOKEEPER_ROOT
  if (root === undefined) return newZookeeperRegistry({ address })
  if (root === "") throw new TypeError("ZOOKEEPER_ROOT must not be empty")
  return newZookeeperRegistry({ address, root })
}
