import * as broker from "@go-like/broker"
import * as brokerProvider from "@go-like/broker/provider"
import * as brokerMemory from "@go-like/broker-memory"
import * as cache from "@go-like/cache"
import * as cacheProvider from "@go-like/cache/provider"
import * as cacheMemory from "@go-like/cache-memory"
import * as client from "@go-like/client"
import * as config from "@go-like/config"
import * as configEnv from "@go-like/config/env"
import * as configFile from "@go-like/config/file"
import * as configYaml from "@go-like/config/yaml"
import * as configConsul from "@go-like/config-consul"
import * as configEtcd from "@go-like/config-etcd"
import * as configKubernetes from "@go-like/config-kubernetes"
import * as configVault from "@go-like/config-vault"
import * as context from "@go-like/context"
import * as core from "@go-like/core"
import * as coreLifecycle from "@go-like/core/lifecycle"
import * as croner from "@go-like/croner"
import * as event from "@go-like/event"
import * as health from "@go-like/health"
import * as metadata from "@go-like/metadata"
import * as registry from "@go-like/registry"
import * as registryProvider from "@go-like/registry/provider"
import * as registryConsul from "@go-like/registry-consul"
import * as registryEtcd from "@go-like/registry-etcd"
import * as registryKubernetes from "@go-like/registry-kubernetes"
import * as registryMdns from "@go-like/registry-mdns"
import * as resilience from "@go-like/resilience"
import * as server from "@go-like/server"
import * as store from "@go-like/store"
import * as storeProvider from "@go-like/store/provider"
import * as storeConsul from "@go-like/store-consul"
import * as storeEtcd from "@go-like/store-etcd"
import * as storeFile from "@go-like/store-file"
import * as storeMemory from "@go-like/store-memory"
import * as storeVault from "@go-like/store-vault"
import * as struct from "@go-like/struct"
import * as structCodec from "@go-like/struct/codec"
import * as structRuntime from "@go-like/struct/runtime"
import * as transport from "@go-like/transport"
import * as transportHeaders from "@go-like/transport/headers"
import * as transportJson from "@go-like/transport/json"
import * as transportProvider from "@go-like/transport/provider"
import * as transportHttp from "@go-like/transport-http"
import * as transportMemory from "@go-like/transport-memory"
import * as web from "@go-like/web"
import * as webHealth from "@go-like/web/health"

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
  struct,
  structCodec,
  structRuntime,
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
