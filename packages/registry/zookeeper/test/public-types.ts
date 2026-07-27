import type { Registry } from "@likego/registry"

import {
  newZookeeperRegistry,
  type ZookeeperAuthenticationError,
  type ZookeeperClientFactoryOptions,
  type ZookeeperOperationError,
  type ZookeeperRegistry,
  type ZookeeperRegistryOptions
} from "../src/index"

const options: ZookeeperRegistryOptions = {
  address: "zookeeper.example:2181",
  auth: { scheme: "digest", credential: "application:secret" },
  acl: "creator",
  onRegistrationError(_error, _service): void {}
}
const factoryOptions: ZookeeperClientFactoryOptions = {
  connectionString: "zookeeper.example:2181",
  sessionTimeoutMs: 30_000,
  spinDelayMs: 1_000,
  retries: 0,
  auth: null,
  acl: "open"
}
const registry: Registry = newZookeeperRegistry(options)
const concrete: ZookeeperRegistry = newZookeeperRegistry(options)
declare const operationError: ZookeeperOperationError
declare const authenticationError: ZookeeperAuthenticationError
void registry
void concrete
void factoryOptions
void operationError
void authenticationError

// @ts-expect-error split registrar constructors are intentionally absent.
import("../src/index").then((module) => module.newZookeeperRegistrar(options))
// @ts-expect-error split discovery constructors are intentionally absent.
import("../src/index").then((module) => module.newZookeeperDiscovery(options))
