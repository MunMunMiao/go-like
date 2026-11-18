import * as broker from "@go-like/core/broker"
import * as brokerProvider from "@go-like/core/broker/provider"
import * as brokerMemory from "@go-like/core/broker/memory"
import * as job from "@go-like/core/job"
import * as jobProvider from "@go-like/core/job/provider"
import * as cache from "@go-like/core/cache"
import * as cacheMemory from "@go-like/core/cache/memory"
import * as client from "@go-like/core/client"
import * as config from "@go-like/core/config"
import * as configProvider from "@go-like/core/config/provider"
import * as configYaml from "@go-like/yaml/config"
import * as consul from "@go-like/consul"
import * as configConsul from "@go-like/consul/config"
import * as etcd from "@go-like/etcd"
import * as configEtcd from "@go-like/etcd/config"
import * as kubernetes from "@go-like/kubernetes"
import * as configKubernetes from "@go-like/kubernetes/config"
import * as vault from "@go-like/vault"
import * as configVault from "@go-like/vault/config"
import * as context from "@go-like/core/context"
import * as fetchClient from "@go-like/core/fetch"
import * as core from "@go-like/core"
import * as coreLifecycle from "@go-like/core/lifecycle"
import * as coreLog from "@go-like/core/log"
import * as coreMetric from "@go-like/core/metric"
import * as coreTelemetry from "@go-like/core/telemetry"
import * as coreTelemetryProvider from "@go-like/core/telemetry/provider"
import * as coreTesting from "@go-like/core/testing"
import * as coreTrace from "@go-like/core/trace"
import * as croner from "@go-like/croner/job"
import * as grpcBuf from "@go-like/connectrpc"
import * as health from "@go-like/core/health"
import * as metadata from "@go-like/core/metadata"
import * as registry from "@go-like/core/registry"
import * as registryMemory from "@go-like/core/registry/memory"
import * as registryProvider from "@go-like/core/registry/provider"
import * as registryConsul from "@go-like/consul/registry"
import * as registryEtcd from "@go-like/etcd/registry"
import * as registryKubernetes from "@go-like/kubernetes/registry"
import * as registryMdns from "@go-like/mdns/registry"
import * as resilience from "@go-like/core/resilience"
import * as server from "@go-like/core/server"
import * as store from "@go-like/core/store"
import * as storeProvider from "@go-like/core/store/provider"
import * as storeConsul from "@go-like/consul/store"
import * as storeEtcd from "@go-like/etcd/store"
import * as storeFile from "@go-like/file/store"
import * as storeMemory from "@go-like/core/store/memory"
import * as storeVault from "@go-like/vault/store"
import * as struct from "@go-like/core/struct"
import * as transport from "@go-like/core/transport"
import * as transportProvider from "@go-like/core/transport/provider"
import * as transportHttp from "@go-like/core/transport/http"
import * as transportMemory from "@go-like/core/transport/memory"
import * as web from "@go-like/core/web"

import { runPublishedSmoke } from "./smoke.ts"

const modules = [
  broker,
  brokerProvider,
  brokerMemory,
  job,
  jobProvider,
  cache,
  cacheMemory,
  client,
  config,
  configProvider,
  configYaml,
  consul,
  configConsul,
  etcd,
  configEtcd,
  kubernetes,
  configKubernetes,
  vault,
  configVault,
  context,
  fetchClient,
  core,
  coreLifecycle,
  coreLog,
  coreMetric,
  coreTelemetry,
  coreTelemetryProvider,
  coreTesting,
  coreTrace,
  croner,
  health,
  metadata,
  registry,
  registryMemory,
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
  transport,
  transportProvider,
  transportHttp,
  transportMemory,
  web
]

export function runPortable(): void {
  if (!("newHandler" in grpcBuf) || typeof grpcBuf.newHandler !== "function") {
    throw new Error("published portable export did not load as a module")
  }
  const handler = grpcBuf.newHandler(() => {})
  if (
    typeof handler !== "function" ||
    modules.some((value) => typeof value !== "object" || value === null)
  ) {
    throw new Error("published portable export did not load as a module")
  }
}

await runPublishedSmoke()
