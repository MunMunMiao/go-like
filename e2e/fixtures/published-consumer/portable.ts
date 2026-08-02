import * as broker from "@likego/broker"
import * as brokerProvider from "@likego/broker/provider"
import * as brokerMemory from "@likego/broker-memory"
import * as cache from "@likego/cache"
import * as cacheProvider from "@likego/cache/provider"
import * as cacheMemory from "@likego/cache-memory"
import * as client from "@likego/client"
import * as config from "@likego/config"
import * as configEnv from "@likego/config/env"
import * as configFile from "@likego/config/file"
import * as configYaml from "@likego/config/yaml"
import * as configConsul from "@likego/config-consul"
import * as configEtcd from "@likego/config-etcd"
import * as configKubernetes from "@likego/config-kubernetes"
import * as configVault from "@likego/config-vault"
import * as context from "@likego/context"
import * as core from "@likego/core"
import * as coreLifecycle from "@likego/core/lifecycle"
import * as croner from "@likego/croner"
import * as event from "@likego/event"
import * as health from "@likego/health"
import * as metadata from "@likego/metadata"
import * as registry from "@likego/registry"
import * as registryProvider from "@likego/registry/provider"
import * as registryConsul from "@likego/registry-consul"
import * as registryEtcd from "@likego/registry-etcd"
import * as registryKubernetes from "@likego/registry-kubernetes"
import * as registryMdns from "@likego/registry-mdns"
import * as resilience from "@likego/resilience"
import * as server from "@likego/server"
import * as store from "@likego/store"
import * as storeProvider from "@likego/store/provider"
import * as storeConsul from "@likego/store-consul"
import * as storeEtcd from "@likego/store-etcd"
import * as storeFile from "@likego/store-file"
import * as storeMemory from "@likego/store-memory"
import * as storeVault from "@likego/store-vault"
import * as transport from "@likego/transport"
import * as transportHeaders from "@likego/transport/headers"
import * as transportJson from "@likego/transport/json"
import * as transportProvider from "@likego/transport/provider"
import * as transportHttp from "@likego/transport-http"
import * as transportMemory from "@likego/transport-memory"
import * as web from "@likego/web"
import * as webHealth from "@likego/web/health"

const modules = [
  broker,
  brokerProvider,
  brokerMemory,
  cache,
  cacheProvider,
  cacheMemory,
  client,
  config,
  configEnv,
  configFile,
  configYaml,
  configConsul,
  configEtcd,
  configKubernetes,
  configVault,
  context,
  core,
  coreLifecycle,
  croner,
  event,
  health,
  metadata,
  registry,
  registryProvider,
  registryConsul,
  registryEtcd,
  registryKubernetes,
  registryMdns,
  resilience,
  server,
  store,
  storeProvider,
  storeConsul,
  storeEtcd,
  storeFile,
  storeMemory,
  storeVault,
  transport,
  transportHeaders,
  transportJson,
  transportProvider,
  transportHttp,
  transportMemory,
  web,
  webHealth
]

export function runPortable(): void {
  if (modules.some((value) => typeof value !== "object" || value === null)) {
    throw new Error("published portable export did not load as a module")
  }
}
