import { newZookeeperRegistry, type ZookeeperClientFactory } from "@likego/registry-zookeeper"

const marker = "LIKEGO_REGISTRY_ZOOKEEPER_PUBLISHED_RUNTIME="

const unusedFactory: ZookeeperClientFactory = function unused(): never {
  throw new Error("published constructor unexpectedly performed network I/O")
}

const registry = newZookeeperRegistry({
  address: "127.0.0.1:2181",
  clientFactory: unusedFactory
})
const methods = Object.keys(registry).sort()
const expected = ["deregister", "getService", "register", "watch"]
if (JSON.stringify(methods) !== JSON.stringify(expected)) {
  throw new Error(`published Registry surface differs: ${methods.join(",")}`)
}
if ("capabilities" in registry) throw new Error("published Registry leaked capabilities()")

console.log(
  `${marker}${JSON.stringify({
    valid: true,
    methods,
    constructionNetworkIO: false
  })}`
)
