import { describe, expect, test } from "bun:test"
import { parse } from "@babel/parser"
import { getBindingIdentifiers } from "@babel/types"
import type { Node } from "@babel/types"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { loadMigrationBaseline, loadSourcedCases } from "../e2e/inventory"
import { suiteDefinitions } from "../e2e/suites"
import { verifyExampleProgram } from "../scripts/verify-workspace"
import { discoverWorkspaces } from "../tools/workspaces/discovery"

interface PackageManifest {
  readonly name: string
  readonly version?: string
  readonly private?: boolean
  readonly module?: string
  readonly typings?: string
  readonly files?: readonly string[]
  readonly scripts?: Readonly<Record<string, string>>
  readonly exports?: Readonly<Record<string, unknown>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

type ExampleTier = "core" | "integration" | "production"

interface ExampleCatalogEntry {
  readonly id: string
  readonly industry: string
  readonly kind?: "framework"
  readonly requiresExternalServices?: true
  readonly invariant: string
  readonly capabilities: readonly string[]
  readonly tier: ExampleTier
}

interface ExampleCatalog {
  readonly schemaVersion: 1
  readonly examples: readonly ExampleCatalogEntry[]
}

interface CapabilityExportManifest {
  readonly kind: "portable" | "integration"
  readonly residency: "resident" | "non-resident"
  readonly ownerResources: readonly string[]
}

interface CapabilityManifest {
  readonly package: string
  readonly packageKind: "portable" | "integration" | "hybrid"
  readonly exports: Readonly<Record<string, CapabilityExportManifest>>
}

interface DependencyContract {
  readonly dependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
}

interface ExportContract {
  readonly kind: "portable" | "integration"
  readonly residency: "resident" | "non-resident"
  readonly ownerResources: readonly string[]
}

interface CapabilityContract {
  readonly packageKind: "portable" | "integration" | "hybrid"
  readonly exports: Readonly<Record<string, ExportContract>>
}

type RuntimeExportKind = "typeOnly" | "classValue" | "otherValue" | "unknown"

interface LocalRuntimeReference {
  readonly kind: "localReference"
  readonly name: string
}

interface RemoteRuntimeReference {
  readonly kind: "remoteReference"
  readonly name: string
  readonly source: string
}

type RuntimeBinding = RuntimeExportKind | LocalRuntimeReference | RemoteRuntimeReference
type RuntimeBindings = readonly RuntimeBinding[]

interface RuntimeModuleInfo {
  readonly bindings: ReadonlyMap<string, RuntimeBindings>
  readonly exports: ReadonlyMap<string, RuntimeBindings>
  readonly exportAll: boolean
  readonly typeExportAllSources: readonly string[]
}

interface RuntimeNamingFinding {
  readonly path: string
  readonly name: string
  readonly kind: RuntimeExportKind
}

const Root = join(import.meta.dir, "..")
const ExampleCatalogPath = join(Root, "examples", "catalog.json")
const ExactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FoundationalExampleCapabilities = new Set([
  "@likego/context",
  "@likego/web",
  "@likego/elysia",
  "@likego/h3",
  "@likego/hono"
])

const ReleaseRoots = Object.freeze({
  "@likego/broker": "packages/broker",
  "@likego/broker-memory": "packages/broker/memory",
  "@likego/broker-rabbitmq": "packages/broker/rabbitmq",
  "@likego/bullmq": "packages/bullmq",
  "@likego/cache": "packages/cache",
  "@likego/cache-memory": "packages/cache/memory",
  "@likego/cache-redis": "packages/cache/redis",
  "@likego/client": "packages/client",
  "@likego/config": "packages/config",
  "@likego/config-consul": "packages/config/consul",
  "@likego/config-etcd": "packages/config/etcd",
  "@likego/config-kubernetes": "packages/config/kubernetes",
  "@likego/config-vault": "packages/config/vault",
  "@likego/context": "packages/context",
  "@likego/core": "packages/core",
  "@likego/create": "packages/create",
  "@likego/croner": "packages/croner",
  "@likego/elysia": "packages/elysia",
  "@likego/event": "packages/event",
  "@likego/h3": "packages/h3",
  "@likego/health": "packages/health",
  "@likego/hono": "packages/hono",
  "@likego/metadata": "packages/metadata",
  "@likego/nats": "packages/nats",
  "@likego/otel": "packages/otel",
  "@likego/pino": "packages/pino",
  "@likego/prometheus": "packages/prometheus",
  "@likego/registry": "packages/registry",
  "@likego/registry-consul": "packages/registry/consul",
  "@likego/registry-etcd": "packages/registry/etcd",
  "@likego/registry-kubernetes": "packages/registry/kubernetes",
  "@likego/registry-mdns": "packages/registry/mdns",
  "@likego/registry-zookeeper": "packages/registry/zookeeper",
  "@likego/resilience": "packages/resilience",
  "@likego/server": "packages/server",
  "@likego/store": "packages/store",
  "@likego/store-consul": "packages/store/consul",
  "@likego/store-etcd": "packages/store/etcd",
  "@likego/store-file": "packages/store/file",
  "@likego/store-memory": "packages/store/memory",
  "@likego/store-vault": "packages/store/vault",
  "@likego/transport": "packages/transport",
  "@likego/transport-http": "packages/transport/http",
  "@likego/transport-memory": "packages/transport/memory",
  "@likego/web": "packages/web",
  "@likego/winston": "packages/winston"
})

const ExportKeys: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "@likego/broker": [".", "./provider"],
  "@likego/broker-memory": ["."],
  "@likego/broker-rabbitmq": ["."],
  "@likego/bullmq": ["."],
  "@likego/cache": [".", "./provider"],
  "@likego/cache-memory": ["."],
  "@likego/cache-redis": ["."],
  "@likego/client": ["."],
  "@likego/config": [".", "./env", "./file", "./node", "./yaml"],
  "@likego/config-consul": ["."],
  "@likego/config-etcd": ["."],
  "@likego/config-kubernetes": ["."],
  "@likego/config-vault": ["."],
  "@likego/context": ["."],
  "@likego/core": [".", "./lifecycle", "./node"],
  "@likego/create": ["."],
  "@likego/croner": ["."],
  "@likego/elysia": ["."],
  "@likego/event": ["."],
  "@likego/h3": ["."],
  "@likego/health": ["."],
  "@likego/hono": ["."],
  "@likego/metadata": ["."],
  "@likego/nats": [".", "./broker", "./jetstream", "./jetstream/broker"],
  "@likego/otel": ["."],
  "@likego/pino": ["."],
  "@likego/prometheus": ["."],
  "@likego/registry": [".", "./provider"],
  "@likego/registry-consul": ["."],
  "@likego/registry-etcd": ["."],
  "@likego/registry-kubernetes": ["."],
  "@likego/registry-mdns": [".", "./node"],
  "@likego/registry-zookeeper": ["."],
  "@likego/resilience": ["."],
  "@likego/server": ["."],
  "@likego/store": [".", "./provider"],
  "@likego/store-consul": ["."],
  "@likego/store-etcd": ["."],
  "@likego/store-file": [".", "./node"],
  "@likego/store-memory": ["."],
  "@likego/store-vault": ["."],
  "@likego/transport": [".", "./headers", "./json", "./provider"],
  "@likego/transport-http": [".", "./node"],
  "@likego/transport-memory": ["."],
  "@likego/web": [".", "./health", "./node"],
  "@likego/winston": ["."]
})

const Dependencies: Readonly<Record<string, DependencyContract>> = Object.freeze({
  "@likego/broker": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/broker-memory": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/broker-rabbitmq": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      amqplib: "2.0.1"
    },
    peerDependencies: {}
  },
  "@likego/bullmq": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      bullmq: "5.81.2"
    },
    peerDependencies: {}
  },
  "@likego/cache": {
    dependencies: { "@likego/context": "workspace:*" },
    peerDependencies: {}
  },
  "@likego/cache-memory": {
    dependencies: {
      "@likego/cache": "workspace:*",
      "@likego/context": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/cache-redis": {
    dependencies: {
      "@likego/cache": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@redis/client": "6.1.0"
    },
    peerDependencies: {}
  },
  "@likego/client": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/metadata": "workspace:*",
      "@likego/registry": "workspace:*",
      "@likego/resilience": "workspace:*",
      "@likego/transport": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/config": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@standard-schema/spec": "1.1.0",
      "js-yaml": "5.2.2"
    },
    peerDependencies: {}
  },
  "@likego/config-consul": {
    dependencies: {
      "@likego/config": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/config-etcd": {
    dependencies: {
      "@likego/config": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/config-kubernetes": {
    dependencies: {
      "@likego/config": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/config-vault": {
    dependencies: {
      "@likego/config": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/context": { dependencies: {}, peerDependencies: {} },
  "@likego/core": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/registry": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/create": {
    dependencies: {
      "@likego/core": "workspace:*",
      "@likego/server": "workspace:*",
      "@likego/transport": "workspace:*",
      "@likego/transport-http": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/croner": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      croner: "10.0.1"
    },
    peerDependencies: {}
  },
  "@likego/elysia": {
    dependencies: { "@likego/web": "workspace:*" },
    peerDependencies: { elysia: "1.4.29" }
  },
  "@likego/event": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/context": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/h3": {
    dependencies: { "@likego/web": "workspace:*" },
    peerDependencies: { h3: "1.15.11" }
  },
  "@likego/health": {
    dependencies: { "@likego/context": "workspace:*" },
    peerDependencies: {}
  },
  "@likego/hono": {
    dependencies: { "@likego/web": "workspace:*" },
    peerDependencies: { hono: "4.12.32" }
  },
  "@likego/metadata": {
    dependencies: { "@likego/context": "workspace:*" },
    peerDependencies: {}
  },
  "@likego/nats": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@nats-io/jetstream": "3.4.0",
      "@nats-io/transport-node": "3.4.0"
    },
    peerDependencies: {}
  },
  "@likego/otel": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/client": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/metadata": "workspace:*",
      "@likego/server": "workspace:*",
      "@likego/transport": "workspace:*",
      "@opentelemetry/api": "1.9.1",
      "@opentelemetry/sdk-metrics": "2.10.0",
      "@opentelemetry/sdk-trace": "2.10.0"
    },
    peerDependencies: {}
  },
  "@likego/pino": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/client": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/server": "workspace:*",
      "@likego/transport": "workspace:*",
      pino: "10.3.1"
    },
    peerDependencies: {}
  },
  "@likego/prometheus": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/client": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/server": "workspace:*",
      "@likego/transport": "workspace:*",
      "@likego/web": "workspace:*",
      "prom-client": "15.1.3"
    },
    peerDependencies: {}
  },
  "@likego/registry": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/metadata": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/registry-consul": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/registry": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/registry-etcd": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/registry": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/registry-kubernetes": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/registry": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/registry-mdns": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/registry": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/registry-zookeeper": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/registry": "workspace:*",
      "node-zookeeper-client": "1.1.3"
    },
    peerDependencies: {}
  },
  "@likego/resilience": {
    dependencies: { "@likego/context": "workspace:*" },
    peerDependencies: {}
  },
  "@likego/server": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/metadata": "workspace:*",
      "@likego/resilience": "workspace:*",
      "@likego/transport": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/store": {
    dependencies: { "@likego/context": "workspace:*" },
    peerDependencies: {}
  },
  "@likego/store-consul": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/store": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/store-etcd": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/store": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/store-file": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/store": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/store-memory": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/store": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/store-vault": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/store": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/transport": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/metadata": "workspace:*",
      "@standard-schema/spec": "1.1.0"
    },
    peerDependencies: {}
  },
  "@likego/transport-http": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/metadata": "workspace:*",
      "@likego/transport": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/transport-memory": {
    dependencies: {
      "@likego/context": "workspace:*",
      "@likego/metadata": "workspace:*",
      "@likego/transport": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/web": {
    dependencies: {
      "@hono/node-server": "2.0.11",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/health": "workspace:*"
    },
    peerDependencies: {}
  },
  "@likego/winston": {
    dependencies: {
      "@likego/broker": "workspace:*",
      "@likego/client": "workspace:*",
      "@likego/context": "workspace:*",
      "@likego/core": "workspace:*",
      "@likego/server": "workspace:*",
      "@likego/transport": "workspace:*",
      "@likego/web": "workspace:*",
      winston: "3.19.0"
    },
    peerDependencies: {}
  }
})

function portable(
  residency: "resident" | "non-resident",
  ...ownerResources: readonly string[]
): ExportContract {
  return Object.freeze({
    kind: "portable",
    residency,
    ownerResources: Object.freeze(ownerResources)
  })
}

function integration(
  residency: "resident" | "non-resident",
  ...ownerResources: readonly string[]
): ExportContract {
  return Object.freeze({
    kind: "integration",
    residency,
    ownerResources: Object.freeze(ownerResources)
  })
}

const Capabilities: Readonly<Record<string, CapabilityContract>> = Object.freeze({
  "@likego/broker": {
    packageKind: "portable",
    exports: {
      ".": portable("resident", "broker-subscription"),
      "./provider": portable("non-resident")
    }
  },
  "@likego/broker-memory": {
    packageKind: "portable",
    exports: { ".": portable("resident", "memory-broker-subscription") }
  },
  "@likego/broker-rabbitmq": {
    packageKind: "integration",
    exports: { ".": integration("resident", "rabbitmq-consumer") }
  },
  "@likego/bullmq": {
    packageKind: "integration",
    exports: {
      ".": integration("resident", "queue", "worker", "redis-connections")
    }
  },
  "@likego/cache": {
    packageKind: "portable",
    exports: {
      ".": portable("non-resident"),
      "./provider": portable("non-resident")
    }
  },
  "@likego/cache-memory": {
    packageKind: "portable",
    exports: { ".": portable("non-resident") }
  },
  "@likego/cache-redis": {
    packageKind: "integration",
    exports: { ".": integration("resident", "redis-client") }
  },
  "@likego/client": {
    packageKind: "portable",
    exports: { ".": portable("resident", "watcher", "transport-client") }
  },
  "@likego/config": {
    packageKind: "hybrid",
    exports: {
      ".": portable("resident", "source-watcher"),
      "./env": portable("non-resident"),
      "./file": portable("resident", "watch-subscription"),
      "./node": integration("resident", "node-file-watcher"),
      "./yaml": portable("non-resident")
    }
  },
  "@likego/config-consul": {
    packageKind: "portable",
    exports: { ".": portable("resident", "blocking-query") }
  },
  "@likego/config-etcd": {
    packageKind: "portable",
    exports: { ".": portable("resident", "watch-stream") }
  },
  "@likego/config-kubernetes": {
    packageKind: "portable",
    exports: { ".": portable("resident", "watch-stream") }
  },
  "@likego/config-vault": {
    packageKind: "portable",
    exports: { ".": portable("resident", "kv-v2-poller") }
  },
  "@likego/context": { packageKind: "portable", exports: { ".": portable("non-resident") } },
  "@likego/core": {
    packageKind: "hybrid",
    exports: {
      ".": portable("non-resident"),
      "./lifecycle": portable("non-resident"),
      "./node": integration("resident", "runtime-signal-listener")
    }
  },
  "@likego/create": {
    packageKind: "integration",
    exports: { ".": integration("non-resident") }
  },
  "@likego/croner": {
    packageKind: "integration",
    exports: { ".": integration("resident", "scheduler") }
  },
  "@likego/elysia": { packageKind: "integration", exports: { ".": integration("non-resident") } },
  "@likego/event": {
    packageKind: "portable",
    exports: { ".": portable("non-resident") }
  },
  "@likego/h3": { packageKind: "integration", exports: { ".": integration("non-resident") } },
  "@likego/health": { packageKind: "portable", exports: { ".": portable("non-resident") } },
  "@likego/hono": { packageKind: "integration", exports: { ".": integration("non-resident") } },
  "@likego/metadata": { packageKind: "portable", exports: { ".": portable("non-resident") } },
  "@likego/nats": {
    packageKind: "integration",
    exports: {
      ".": integration("resident", "subscription"),
      "./broker": integration("resident", "broker-subscription"),
      "./jetstream": integration("resident", "consumer-messages"),
      "./jetstream/broker": integration("resident", "jetstream-broker-subscription")
    }
  },
  "@likego/otel": {
    packageKind: "integration",
    exports: {
      ".": integration("resident", "tracer-provider", "meter-provider")
    }
  },
  "@likego/pino": {
    packageKind: "integration",
    exports: { ".": integration("resident", "logger", "destination") }
  },
  "@likego/prometheus": {
    packageKind: "integration",
    exports: { ".": integration("non-resident") }
  },
  "@likego/registry": {
    packageKind: "portable",
    exports: {
      ".": portable("non-resident"),
      "./provider": portable("non-resident")
    }
  },
  "@likego/registry-consul": {
    packageKind: "portable",
    exports: { ".": portable("resident", "consul-registration", "consul-watcher") }
  },
  "@likego/registry-etcd": {
    packageKind: "portable",
    exports: { ".": portable("resident", "etcd-registration", "etcd-watcher") }
  },
  "@likego/registry-kubernetes": {
    packageKind: "portable",
    exports: { ".": portable("resident", "kubernetes-watcher") }
  },
  "@likego/registry-mdns": {
    packageKind: "hybrid",
    exports: {
      ".": portable("resident", "mdns-registration", "mdns-watcher"),
      "./node": integration("resident", "node-mdns-datagram")
    }
  },
  "@likego/registry-zookeeper": {
    packageKind: "integration",
    exports: {
      ".": integration("resident", "zookeeper-registration-session", "zookeeper-watcher-session")
    }
  },
  "@likego/resilience": { packageKind: "portable", exports: { ".": portable("non-resident") } },
  "@likego/server": {
    packageKind: "portable",
    exports: { ".": portable("resident", "transport-listener") }
  },
  "@likego/store": {
    packageKind: "portable",
    exports: {
      ".": portable("non-resident"),
      "./provider": portable("non-resident")
    }
  },
  "@likego/store-consul": {
    packageKind: "portable",
    exports: { ".": portable("non-resident") }
  },
  "@likego/store-etcd": {
    packageKind: "portable",
    exports: { ".": portable("non-resident") }
  },
  "@likego/store-file": {
    packageKind: "hybrid",
    exports: {
      ".": portable("resident", "file-store-directory"),
      "./node": integration("resident", "node-file-lock")
    }
  },
  "@likego/store-memory": {
    packageKind: "portable",
    exports: { ".": portable("non-resident") }
  },
  "@likego/store-vault": {
    packageKind: "portable",
    exports: { ".": portable("non-resident") }
  },
  "@likego/transport": {
    packageKind: "portable",
    exports: {
      ".": portable("non-resident"),
      "./headers": portable("non-resident"),
      "./json": portable("non-resident"),
      "./provider": portable("non-resident")
    }
  },
  "@likego/transport-http": {
    packageKind: "hybrid",
    exports: {
      ".": portable("non-resident"),
      "./node": integration("resident", "http-listener")
    }
  },
  "@likego/transport-memory": {
    packageKind: "portable",
    exports: { ".": portable("resident", "memory-client", "memory-listener") }
  },
  "@likego/web": {
    packageKind: "hybrid",
    exports: {
      ".": portable("non-resident"),
      "./health": portable("non-resident"),
      "./node": integration("resident", "node-server")
    }
  },
  "@likego/winston": {
    packageKind: "integration",
    exports: { ".": integration("resident", "logger") }
  }
})

const LegacyIdentity =
  /Micro-|@likego\/(?:fetch|fetch-node|http|config-env|config-file|cron-croner|job-bullmq-node|nats-core-node|nats-jetstream-node|log-pino-node|log-winston-node|metrics-prom-client-node|otel-node)|adapters\//g
const IgnoredDirectories = new Set([
  "dist",
  "node_modules",
  "test",
  "fixtures",
  ".artifacts",
  ".omo"
])
const RuntimeNamingIgnoredDirectories = new Set([
  "dist",
  "node_modules",
  "fixtures",
  ".artifacts",
  ".omo"
])
const RuntimeNamingRoots = Object.freeze(["packages", "examples", "e2e", "scripts", "tools"])
const LegacyRoots = Object.freeze([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "tsconfig.test.json",
  "tsconfig.tsdown.json",
  "packages",
  "examples",
  "e2e",
  "scripts",
  "README.md",
  "docs/adr",
  "docs/capability-comparison.md"
])

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

async function exampleCatalog(): Promise<ExampleCatalog> {
  return json<ExampleCatalog>(ExampleCatalogPath)
}

function allCatalogExamples(catalog: ExampleCatalog): readonly ExampleCatalogEntry[] {
  return catalog.examples
}

function examplePackageName(id: string): string {
  return `@likego/example-${id}`
}

function exampleRoot(id: string): string {
  return `examples/${id}`
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  )
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

async function isNonemptyFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    return (await readFile(path, "utf8")).trim().length > 0
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

async function hasExampleTest(root: string): Promise<boolean> {
  const testRoot = join(root, "test")
  if (!(await isDirectory(testRoot))) return false
  for (const path of await runtimeTypeScriptFilesBelow(testRoot)) {
    if (path.endsWith(".test.ts") && (await isNonemptyFile(path))) return true
  }
  return false
}

async function valueLikegoImportsBelow(root: string): Promise<ReadonlySet<string>> {
  const values = new Set<string>()
  if (!(await isDirectory(root))) return values

  for (const path of await runtimeTypeScriptFilesBelow(root)) {
    const program = parse(await readFile(path, "utf8"), {
      sourceType: "module",
      plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"]
    }).program
    for (const statement of program.body) {
      if (statement.type !== "ImportDeclaration") continue
      const match = /^(@likego\/[^/]+)(?:\/|$)/.exec(statement.source.value)
      const packageName = match?.[1]
      if (packageName === undefined) continue
      const hasRuntimeValue =
        statement.importKind !== "type" &&
        (statement.specifiers.length === 0 ||
          statement.specifiers.some(
            (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type"
          ))
      if (hasRuntimeValue) values.add(packageName)
    }
  }
  return values
}

function withoutTypes(
  values: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values ?? {})
      .filter(([name]) => !name.startsWith("@types/"))
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function resolvedWorkspaceDependencies(
  contract: DependencyContract,
  versions: ReadonlyMap<string, string>
): DependencyContract {
  const resolve = (
    dependencies: Readonly<Record<string, string>>
  ): Readonly<Record<string, string>> =>
    Object.fromEntries(
      Object.entries(dependencies).map(([name, specifier]) => {
        if (specifier !== "workspace:*") return [name, specifier]
        const version = versions.get(name)
        if (version === undefined) throw new Error(`missing release version for ${name}`)
        return [name, version]
      })
    )
  return {
    dependencies: resolve(contract.dependencies),
    peerDependencies: resolve(contract.peerDependencies)
  }
}

function requiredContract<T>(values: Readonly<Record<string, T>>, name: string): T {
  const value = values[name]
  if (value === undefined) throw new Error(`missing repository contract for ${name}`)
  return value
}

function capabilitySnapshot(manifest: CapabilityManifest): CapabilityContract {
  const exports: Record<string, ExportContract> = {}
  for (const name of Object.keys(manifest.exports).sort()) {
    const value = manifest.exports[name]
    if (value === undefined) throw new Error(`missing capability export ${name}`)
    exports[name] = {
      kind: value.kind,
      residency: value.residency,
      ownerResources: [...value.ownerResources]
    }
  }
  return { packageKind: manifest.packageKind, exports }
}

async function filesBelow(path: string): Promise<readonly string[]> {
  const result: string[] = []

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!IgnoredDirectories.has(entry.name)) await visit(absolute)
        continue
      }
      if (!entry.isFile() || entry.name.endsWith(".test.ts")) continue
      result.push(absolute)
    }
  }

  const rootStat = await stat(path)
  if (rootStat.isDirectory()) await visit(path)
  else if (rootStat.isFile()) result.push(path)
  return result.sort()
}

async function runtimeTypeScriptFilesBelow(path: string): Promise<readonly string[]> {
  const result: string[] = []

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!RuntimeNamingIgnoredDirectories.has(entry.name)) await visit(absolute)
        continue
      }
      if (
        !entry.isFile() ||
        ![".ts", ".tsx", ".mts", ".cts"].some((extension) => entry.name.endsWith(extension))
      )
        continue
      if (/\.d\.(?:ts|mts|cts)$/.test(entry.name)) continue
      result.push(absolute)
    }
  }

  await visit(path)
  return result.sort()
}

function nodeName(node: Node | null | undefined): string | null {
  if (node?.type === "Identifier") return node.name
  if (node?.type === "StringLiteral") return node.value
  return null
}

function declarationBindings(declaration: Node): readonly (readonly [string, RuntimeExportKind])[] {
  if (declaration.type === "ClassDeclaration") {
    return declaration.id == null ? [] : [[declaration.id.name, "classValue"]]
  }
  if (declaration.type === "FunctionDeclaration" || declaration.type === "TSDeclareFunction") {
    return declaration.id == null ? [] : [[declaration.id.name, "otherValue"]]
  }
  if (declaration.type === "VariableDeclaration") {
    const bindings: Array<readonly [string, RuntimeExportKind]> = []
    for (const item of declaration.declarations) {
      const kind: RuntimeExportKind =
        declaration.kind === "const" &&
        item.id.type === "Identifier" &&
        item.init?.type === "ClassExpression"
          ? "classValue"
          : "otherValue"
      for (const name of Object.keys(getBindingIdentifiers(item.id))) bindings.push([name, kind])
    }
    return bindings
  }
  if (
    declaration.type === "TSTypeAliasDeclaration" ||
    declaration.type === "TSInterfaceDeclaration"
  ) {
    return [[declaration.id.name, "typeOnly"]]
  }
  if (declaration.type === "TSEnumDeclaration") {
    return [[declaration.id.name, "otherValue"]]
  }
  if (declaration.type === "TSModuleDeclaration") {
    const name = nodeName(declaration.id)
    return name === null ? [] : [[name, "otherValue"]]
  }
  if (declaration.type === "TSImportEqualsDeclaration") {
    return [[declaration.id.name, "otherValue"]]
  }
  return []
}

function runtimeModuleInfo(path: string, content: string): RuntimeModuleInfo {
  const bindings = new Map<string, RuntimeBinding[]>()
  const exports = new Map<string, RuntimeBinding[]>()
  let exportAll = false
  const typeExportAllSources: string[] = []
  const program = parse(content, {
    sourceType: "module",
    plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"]
  }).program

  function addBinding(
    target: Map<string, RuntimeBinding[]>,
    name: string,
    binding: RuntimeBinding
  ): void {
    const current = target.get(name)
    if (current === undefined) target.set(name, [binding])
    else current.push(binding)
  }

  function registerDeclaration(declaration: Node, exported: boolean): void {
    for (const [name, kind] of declarationBindings(declaration)) {
      addBinding(bindings, name, kind)
      if (exported) addBinding(exports, name, kind)
    }
  }

  for (const statement of program.body) {
    if (statement.type === "TSImportEqualsDeclaration") {
      registerDeclaration(statement, Reflect.get(statement, "isExport") === true)
      continue
    }
    registerDeclaration(statement, false)
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          const imported = nodeName(specifier.imported)
          if (imported === null) continue
          const typeOnly = statement.importKind === "type" || specifier.importKind === "type"
          addBinding(
            bindings,
            specifier.local.name,
            typeOnly
              ? "typeOnly"
              : { kind: "remoteReference", name: imported, source: statement.source.value }
          )
          continue
        }
        if (specifier.type === "ImportDefaultSpecifier") {
          addBinding(
            bindings,
            specifier.local.name,
            statement.importKind === "type"
              ? "typeOnly"
              : { kind: "remoteReference", name: "default", source: statement.source.value }
          )
          continue
        }
        addBinding(
          bindings,
          specifier.local.name,
          statement.importKind === "type" ? "typeOnly" : "otherValue"
        )
      }
      continue
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration != null) registerDeclaration(statement.declaration, true)
      for (const specifier of statement.specifiers) {
        const exported = nodeName(specifier.exported)
        if (exported === null) continue
        if (
          statement.exportKind === "type" ||
          ("exportKind" in specifier && specifier.exportKind === "type")
        ) {
          addBinding(exports, exported, "typeOnly")
          continue
        }
        if (specifier.type === "ExportNamespaceSpecifier") {
          addBinding(exports, exported, "otherValue")
          continue
        }
        if (specifier.type !== "ExportSpecifier") {
          addBinding(exports, exported, "unknown")
          continue
        }
        const local = nodeName(specifier.local)
        if (local === null) {
          addBinding(exports, exported, "unknown")
          continue
        }
        addBinding(
          exports,
          exported,
          statement.source == null
            ? { kind: "localReference", name: local }
            : { kind: "remoteReference", name: local, source: statement.source.value }
        )
      }
      continue
    }
    if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") typeExportAllSources.push(statement.source.value)
      else exportAll = true
      continue
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration
      if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
        if (declaration.type === "ClassDeclaration") registerDeclaration(declaration, false)
        addBinding(exports, "default", "classValue")
      } else if (declaration.type === "Identifier") {
        addBinding(exports, "default", { kind: "localReference", name: declaration.name })
      } else {
        addBinding(exports, "default", "otherValue")
      }
    }
  }
  return { bindings, exports, exportAll, typeExportAllSources: Object.freeze(typeExportAllSources) }
}

function runtimeModuleCandidates(base: string): readonly string[] {
  if (base.endsWith(".mjs")) return [`${base.slice(0, -4)}.mts`, base]
  if (base.endsWith(".cjs")) return [`${base.slice(0, -4)}.cts`, base]
  if (base.endsWith(".jsx")) return [`${base.slice(0, -4)}.tsx`, base]
  if (base.endsWith(".js")) return [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base]
  if (/\.(?:ts|tsx|mts|cts)$/.test(base)) return [base]
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.mts"),
    join(base, "index.cts")
  ]
}

function runtimeTargetModule(
  sourcePath: string,
  specifier: string,
  modules: ReadonlyMap<string, RuntimeModuleInfo>
): string | null {
  let base: string | null = null
  if (specifier.startsWith(".")) {
    base = resolve(dirname(sourcePath), specifier)
  } else {
    for (const [packageName, root] of Object.entries(ReleaseRoots)) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue
      const subpath = specifier.slice(packageName.length)
      base =
        subpath === ""
          ? join(Root, root, "src", "index")
          : join(Root, root, "src", subpath.slice(1))
      break
    }
  }
  if (base === null) return null
  const candidates = runtimeModuleCandidates(base)
  return candidates.find((candidate) => modules.has(candidate)) ?? null
}

function isRuntimeBindings(binding: RuntimeBinding | RuntimeBindings): binding is RuntimeBindings {
  return Array.isArray(binding)
}

function resolvedRuntimeKind(
  sourcePath: string,
  binding: RuntimeBinding | RuntimeBindings,
  modules: ReadonlyMap<string, RuntimeModuleInfo>,
  seen: Set<string>
): RuntimeExportKind {
  if (isRuntimeBindings(binding)) {
    const runtimeKinds = binding
      .map((candidate) => resolvedRuntimeKind(sourcePath, candidate, modules, seen))
      .filter((kind) => kind !== "typeOnly")
    if (runtimeKinds.length === 0) return "typeOnly"
    if (runtimeKinds.every((kind) => kind === "classValue")) return "classValue"
    if (runtimeKinds.some((kind) => kind === "otherValue")) return "otherValue"
    return "unknown"
  }
  if (typeof binding === "string") return binding
  if (binding.kind === "localReference") {
    const key = `${sourcePath}:local:${binding.name}`
    if (seen.has(key)) return "unknown"
    seen.add(key)
    const local = modules.get(sourcePath)?.bindings.get(binding.name)
    const result =
      local === undefined ? "unknown" : resolvedRuntimeKind(sourcePath, local, modules, seen)
    seen.delete(key)
    return result
  }
  const target = runtimeTargetModule(sourcePath, binding.source, modules)
  if (target === null) return "unknown"
  const key = `${target}:export:${binding.name}`
  if (seen.has(key)) return "unknown"
  seen.add(key)
  const remote = modules.get(target)?.exports.get(binding.name)
  const result =
    remote === undefined ? "unknown" : resolvedRuntimeKind(target, remote, modules, seen)
  seen.delete(key)
  return result
}

function runtimeNamingFindings(
  sources: ReadonlyMap<string, string>
): readonly RuntimeNamingFinding[] {
  const modules = new Map<string, RuntimeModuleInfo>()
  for (const [path, content] of sources) modules.set(path, runtimeModuleInfo(path, content))
  const findings: RuntimeNamingFinding[] = []
  for (const [path, module] of modules) {
    if (module.exportAll) findings.push({ path, name: "*", kind: "unknown" })
    for (const source of module.typeExportAllSources) {
      if (runtimeTargetModule(path, source, modules) === null) {
        findings.push({ path, name: "type *", kind: "unknown" })
      }
    }
    for (const [name, binding] of module.exports) {
      if (name === "default") continue
      const kind = resolvedRuntimeKind(path, binding, modules, new Set())
      const valid =
        kind === "typeOnly" || kind === "classValue"
          ? /^[A-Z][A-Za-z0-9]*$/.test(name)
          : kind === "otherValue" && /^[a-z][A-Za-z0-9]*$/.test(name)
      if (!valid) findings.push({ path, name, kind })
    }
  }
  return findings.sort(
    (left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name)
  )
}

describe("final repository contract", () => {
  test("locks the exact 46 release packages and every private workspace", async () => {
    const catalog = await exampleCatalog()
    const catalogWorkspaces = allCatalogExamples(catalog).map((entry) => ({
      name: examplePackageName(entry.id),
      root: exampleRoot(entry.id)
    }))
    const expected = [
      ...Object.entries(ReleaseRoots).map(([name, root]) => ({ name, root, private: false })),
      { name: "@likego/testing", root: "packages/testing", private: true },
      ...catalogWorkspaces.map(({ name, root }) => ({ name, root, private: true }))
    ].sort((left, right) => left.name.localeCompare(right.name))
    const actual = (await discoverWorkspaces(Root))
      .map((workspace) => ({
        name: workspace.name,
        root: workspace.root,
        private: workspace.private
      }))
      .sort((left, right) => left.name.localeCompare(right.name))

    expect(actual).toEqual(expected)
    expect(actual.filter((workspace) => !workspace.private)).toHaveLength(46)
    expect(actual.filter((workspace) => workspace.private)).toHaveLength(
      catalogWorkspaces.length + 1
    )
  })

  test("keeps one open catalogue of at least 40 unique examples", async () => {
    const catalog = await exampleCatalog()
    const entries = allCatalogExamples(catalog)

    expect(catalog.schemaVersion).toBe(1)
    expect(entries.length).toBeGreaterThanOrEqual(40)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
    expect(new Set(entries.map((entry) => entry.invariant)).size).toBe(entries.length)

    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(entry.industry.trim().length).toBeGreaterThan(0)
      expect([undefined, "framework"]).toContain(entry.kind)
      expect([undefined, true]).toContain(entry.requiresExternalServices)
      expect(entry.invariant.trim().length).toBeGreaterThan(0)
      expect(entry.capabilities.length).toBeGreaterThan(0)
      expect(new Set(entry.capabilities).size).toBe(entry.capabilities.length)
      expect(
        entry.capabilities.every((capability) =>
          Object.prototype.hasOwnProperty.call(ReleaseRoots, capability)
        )
      ).toBe(true)
    }
    const frameworkIds = new Set(
      entries.filter((entry) => entry.kind === "framework").map((entry) => entry.id)
    )
    expect(frameworkIds.size).toBeGreaterThanOrEqual(4)
    for (const id of ["elysia", "h3", "hono", "vanilla-web"] as const) {
      expect(frameworkIds.has(id)).toBe(true)
    }
    expect(
      entries.filter((entry) => entry.requiresExternalServices === true).map((entry) => entry.id)
    ).toEqual([
      "commerce-catalog",
      "saas-tenant-api",
      "payments-ledger",
      "iot-telemetry",
      "batch-reporting",
      "enterprise-platform-runtime"
    ])
    const cybersecurity = entries.find((entry) => entry.id === "cybersecurity-alert-triage")
    expect(cybersecurity?.tier).toBe("production")
    expect(cybersecurity?.requiresExternalServices).toBeUndefined()
  })

  test("backs every catalogued capability with direct production or executed provider evidence", async () => {
    const catalog = await exampleCatalog()
    const findings: string[] = []
    const dockerScripts: Record<string, string> = {}

    for (const entry of allCatalogExamples(catalog)) {
      const root = join(Root, exampleRoot(entry.id))
      const manifest = await json<PackageManifest>(join(root, "package.json"))
      const sourceValues = await valueLikegoImportsBelow(join(root, "src"))
      const testValues = await valueLikegoImportsBelow(join(root, "test"))
      const e2eValues = await valueLikegoImportsBelow(join(root, "e2e"))
      const executedValues = new Set([...sourceValues, ...testValues, ...e2eValues])
      for (const capability of entry.capabilities) {
        if (manifest.dependencies?.[capability] !== "workspace:*") {
          findings.push(`${entry.id}: ${capability} is not a direct production dependency`)
        }
        if (!executedValues.has(capability)) {
          findings.push(`${entry.id}: ${capability} has no value-imported execution evidence`)
        }
      }
      if (
        entry.kind !== "framework" &&
        !entry.capabilities.some((capability) => !FoundationalExampleCapabilities.has(capability))
      ) {
        findings.push(`${entry.id}: no non-foundational LikeGo capability`)
      }
      const hasDockerTest = typeof manifest.scripts?.["test:docker"] === "string"
      if ((entry.tier === "production") !== hasDockerTest) {
        findings.push(`${entry.id}: production tier and test:docker disagree`)
      }
      if (hasDockerTest) dockerScripts[entry.id] = manifest.scripts?.["test:docker"] ?? ""
    }

    expect(findings).toEqual([])
    expect(dockerScripts).toEqual({
      "batch-reporting": "bun test/e2e/docker-e2e.ts",
      "commerce-catalog": "bun e2e/docker.ts",
      "cybersecurity-alert-triage": "bun e2e/docker.ts",
      "enterprise-platform-runtime": "tsx test/e2e/docker-e2e.ts",
      "iot-telemetry": "bun e2e/docker.ts",
      "payments-ledger": "bun e2e/docker.ts",
      "saas-tenant-api": "bun e2e/docker.ts"
    })
  })

  test("keeps the examples entry index synchronized with every catalogued README", async () => {
    const catalog = await exampleCatalog()
    const index = await readFile(join(Root, "examples", "README.md"), "utf8")
    const actual = [...index.matchAll(/\]\(\.\/([a-z0-9]+(?:-[a-z0-9]+)*)\/README\.md\)/g)]
      .map((match) => match[1])
      .sort()
    const expected = allCatalogExamples(catalog)
      .map((entry) => entry.id)
      .sort()

    expect(actual).toEqual(expected)
  })

  test("locks every public export and direct production or peer dependency", async () => {
    const versions = new Map<string, string>()
    for (const [name, root] of Object.entries(ReleaseRoots)) {
      const manifest = await json<PackageManifest>(join(Root, root, "package.json"))
      if (typeof manifest.version !== "string") {
        throw new TypeError(`${name} must declare a release version`)
      }
      expect(manifest.version).toMatch(ExactSemver)
      versions.set(name, manifest.version)
    }
    for (const [name, root] of Object.entries(ReleaseRoots)) {
      const manifest = await json<PackageManifest>(join(Root, root, "package.json"))
      expect(manifest.name).toBe(name)
      expect(manifest.module).toBe("src/index.ts")
      expect(manifest.typings).toBe("src/index.ts")
      expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(
        [...requiredContract(ExportKeys, name)].sort()
      )
      const exportTargets = Object.values(manifest.exports ?? {})
      expect(exportTargets.every((target) => typeof target === "string")).toBe(true)
      for (const target of exportTargets) {
        if (typeof target !== "string") continue
        expect(target).toMatch(/^\.\/src\/[a-z0-9-]+\.ts$/)
        expect(await isNonemptyFile(resolve(Root, root, target))).toBe(true)
      }
      expect({
        dependencies: withoutTypes(manifest.dependencies),
        peerDependencies: withoutTypes(manifest.peerDependencies)
      }).toEqual(resolvedWorkspaceDependencies(requiredContract(Dependencies, name), versions))
    }
  })

  test("locks package kind and ownership for all 67 public exports", async () => {
    let exportCount = 0
    for (const [name, root] of Object.entries(ReleaseRoots)) {
      const manifest = await json<CapabilityManifest>(join(Root, root, "capability.json"))
      expect(manifest.package).toBe(name)
      expect(capabilitySnapshot(manifest)).toEqual(requiredContract(Capabilities, name))
      exportCount += Object.keys(manifest.exports).length
    }
    expect(exportCount).toBe(67)
  })

  test("keeps workspace-only test authorities out of production dependencies", async () => {
    const actual: Record<string, readonly string[]> = {}
    for (const [name, root] of Object.entries(ReleaseRoots)) {
      const manifest = await json<PackageManifest>(join(Root, root, "package.json"))
      const workspaceDevDependencies = Object.keys(manifest.devDependencies ?? {})
        .filter((dependency) => dependency.startsWith("@likego/"))
        .sort()
      if (workspaceDevDependencies.length > 0) actual[name] = workspaceDevDependencies
    }
    expect(actual).toEqual({
      "@likego/cache": ["@likego/core"],
      "@likego/otel": ["@likego/registry", "@likego/transport-http"],
      "@likego/server": ["@likego/transport-memory"],
      "@likego/web": ["@likego/testing"]
    })
  })

  test("keeps all catalogued examples private, source-only, documented and tested", async () => {
    const catalog = await exampleCatalog()
    for (const entry of allCatalogExamples(catalog)) {
      const name = examplePackageName(entry.id)
      const root = join(Root, exampleRoot(entry.id))
      const manifest = await json<PackageManifest>(join(root, "package.json"))
      expect(manifest.name).toBe(name)
      expect(manifest.version).toBeUndefined()
      expect(manifest.private).toBe(true)
      expect(manifest.files).toBeUndefined()
      expect(manifest.scripts?.build).toBeUndefined()
      expect(JSON.stringify(manifest.exports ?? {})).not.toContain("dist")
      expect(await readFile(join(root, "tsconfig.json"), "utf8")).not.toMatch(/"paths"\s*:/)
      expect(await isDirectory(join(root, "dist"))).toBe(false)
      expect(await isNonemptyFile(join(root, "README.md"))).toBe(true)
      expect(manifest.scripts?.start).toBe(
        "bun run --cwd ../.. build:packages && bun run start:prepared"
      )
      expect(typeof manifest.scripts?.["start:prepared"]).toBe("string")
      expect(await verifyExampleProgram(Root, exampleRoot(entry.id))).toEqual([])

      const localDependencies = Object.entries({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.devDependencies
      }).filter(([dependency]) => dependency.startsWith("@likego/"))
      for (const [dependency, specifier] of localDependencies) {
        expect(Object.prototype.hasOwnProperty.call(ReleaseRoots, dependency)).toBe(true)
        expect(specifier).toBe("workspace:*")
      }
    }
  })

  test("keeps every framework example on the exact routes, app, and main seam", async () => {
    const catalog = await exampleCatalog()
    for (const entry of catalog.examples) {
      if (entry.kind !== "framework") continue
      const root = join(Root, exampleRoot(entry.id))
      const sources = await runtimeTypeScriptFilesBelow(join(root, "src"))
      expect(sources.map((path) => relative(join(root, "src"), path))).toEqual([
        "app.ts",
        "main.ts",
        "routes.ts"
      ])
      expect(await hasExampleTest(root)).toBe(true)
      expect(await isNonemptyFile(join(root, "test", "node-e2e.ts"))).toBe(true)
      const manifest = await json<PackageManifest>(join(root, "package.json"))
      expect(manifest.scripts?.["e2e:node"]).toBe(
        "bun run --cwd ../.. build:packages && bun run e2e:node:prepared"
      )
      expect(manifest.scripts?.["e2e:node:prepared"]).toBe("tsx test/node-e2e.ts")
    }
  })

  test("preserves the 53-case and six-Docker-suite migration floor", async () => {
    const baseline = await loadMigrationBaseline(Root)
    const currentCases = new Set((await loadSourcedCases(Root)).map((entry) => entry.id))
    const currentDockerSuites = new Set(
      suiteDefinitions()
        .filter((entry) => entry.docker)
        .map((entry) => entry.id)
    )

    expect(baseline.businessE2eCaseIds).toHaveLength(53)
    expect(baseline.dockerSuiteIds).toHaveLength(6)
    expect(baseline.businessE2eCaseIds.every((id) => currentCases.has(id))).toBe(true)
    expect(baseline.dockerSuiteIds.every((id) => currentDockerSuites.has(id))).toBe(true)
  })

  test("contains no legacy package or adapter identity in product sources and current documentation", async () => {
    const findings: string[] = []
    for (const root of LegacyRoots) {
      for (const path of await filesBelow(join(Root, root))) {
        const content = await readFile(path, "utf8")
        for (const match of content.matchAll(LegacyIdentity)) {
          findings.push(`${relative(Root, path)}:${match[0]}`)
        }
      }
    }
    expect(findings).toEqual([])
  })

  test("uses export rather than Go capitalization for runtime value visibility", async () => {
    const sources = new Map<string, string>()
    for (const root of RuntimeNamingRoots) {
      for (const path of await runtimeTypeScriptFilesBelow(join(Root, root))) {
        sources.set(path, await readFile(path, "utf8"))
      }
    }
    expect(runtimeNamingFindings(sources)).toEqual([])
  })

  test("allows PascalCase classes while rejecting other PascalCase runtime exports", () => {
    const allowed = new Map<string, string>([
      [
        "/virtual/classes.ts",
        `
export class Client {}
class ServiceError extends Error {}
const LocalClass = class {}
export interface ClientOptions {}
export type ClientShape = { readonly ready: boolean }
export { ServiceError, LocalClass }
`
      ],
      [
        "/virtual/index.ts",
        `
export { Client, ServiceError, LocalClass, type ClientOptions, type ClientShape } from "./classes"
`
      ]
    ])
    expect(runtimeNamingFindings(allowed)).toEqual([])

    const rejected = new Map<string, string>([
      [
        "/virtual/index.ts",
        `
export { Factory, localFactory as PascalFactory } from "./values"
export { ExternalClass } from "external-package"
export * from "./values"
`
      ],
      [
        "/virtual/values.ts",
        `
export declare function DeclaredFactory(): void
export function Factory() {}
export function localFactory() {}
export const Value = 1
export enum State { Ready }
export namespace Tools {}
`
      ]
    ])
    expect(
      runtimeNamingFindings(rejected)
        .map((finding) => finding.name)
        .sort()
    ).toEqual([
      "*",
      "DeclaredFactory",
      "ExternalClass",
      "Factory",
      "Factory",
      "PascalFactory",
      "State",
      "Tools",
      "Value"
    ])
  })

  test("keeps TypeScript type and value namespaces distinct when classifying runtime exports", () => {
    const allowed = new Map<string, string>([
      [
        "/virtual/named-default.ts",
        `
export default class Client {}
export { Client }
`
      ]
    ])
    expect(runtimeNamingFindings(allowed)).toEqual([])

    const rejected = new Map<string, string>([
      [
        "/virtual/merged.ts",
        `
export function Factory() {}
export interface Factory {}
export const Value = 1
export type Value = { readonly value: number }
export let MutableClass: unknown = class {}
MutableClass = () => undefined
export import Legacy = require("./legacy")
`
      ]
    ])
    expect(
      runtimeNamingFindings(rejected)
        .map((finding) => finding.name)
        .sort()
    ).toEqual(["Factory", "Legacy", "MutableClass", "Value"])
  })

  test("resolves emitted JavaScript specifiers and fails closed only for real export cycles", () => {
    const acyclic = new Map<string, string>([
      ["/virtual/graph/base.ts", "export class Client {}"],
      ["/virtual/graph/types.ts", "export interface ClientOptions {}"],
      ["/virtual/graph/type-barrel.ts", 'export type * from "./types.js"'],
      ["/virtual/graph/left.ts", 'export { Client } from "./base.js"'],
      ["/virtual/graph/right.ts", 'export { Client } from "./base.js"'],
      [
        "/virtual/graph/view.tsx",
        `
export class View {}
export const view = <View />
`
      ],
      [
        "/virtual/graph/index.ts",
        `
export { Client as LeftClient } from "./left.js"
export { Client as RightClient } from "./right.js"
`
      ]
    ])
    expect(runtimeNamingFindings(acyclic)).toEqual([])

    const cyclic = new Map<string, string>([
      ["/virtual/two/a.ts", 'export { Loop } from "./b.js"'],
      ["/virtual/two/b.ts", 'export { Loop } from "./a.js"'],
      ["/virtual/three/a.ts", 'export { Cycle } from "./b.js"'],
      ["/virtual/three/b.ts", 'export { Cycle } from "./c.js"'],
      ["/virtual/three/c.ts", 'export { Cycle } from "./a.js"']
    ])
    expect(runtimeNamingFindings(cyclic)).toEqual([
      { path: "/virtual/three/a.ts", name: "Cycle", kind: "unknown" },
      { path: "/virtual/three/b.ts", name: "Cycle", kind: "unknown" },
      { path: "/virtual/three/c.ts", name: "Cycle", kind: "unknown" },
      { path: "/virtual/two/a.ts", name: "Loop", kind: "unknown" },
      { path: "/virtual/two/b.ts", name: "Loop", kind: "unknown" }
    ])

    const substitution = new Map<string, string>([
      ["/virtual/substitution/base.ts", "export function Factory() {}"],
      ["/virtual/substitution/base.js.ts", "export class Factory {}"],
      ["/virtual/substitution/index.ts", 'export { Factory } from "./base.js"']
    ])
    expect(runtimeNamingFindings(substitution).map(({ path, name }) => ({ path, name }))).toEqual([
      { path: "/virtual/substitution/base.ts", name: "Factory" },
      { path: "/virtual/substitution/index.ts", name: "Factory" }
    ])
  })

  test("requires lowerCamelCase values and PascalCase types or classes", () => {
    const rejected = new Map<string, string>([
      [
        "/virtual/names.ts",
        `
const local = 1
export const snake_case = 1
export const _Factory = 1
export { local as "Pascal-Factory" }
export class lowerClass {}
export interface lower_options {}
export { externalFactory } from "external-package"
export type * from "external-types"
`
      ]
    ])
    expect(
      runtimeNamingFindings(rejected)
        .map((finding) => finding.name)
        .sort()
    ).toEqual(
      [
        "Pascal-Factory",
        "_Factory",
        "externalFactory",
        "lowerClass",
        "lower_options",
        "snake_case",
        "type *"
      ].sort()
    )
  })
})
