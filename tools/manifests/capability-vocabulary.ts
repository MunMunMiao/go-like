export interface CapabilityEvidenceContract {
  readonly code: readonly string[]
  readonly tests: readonly string[]
}

export type ExportCapabilityContracts = Readonly<Record<string, CapabilityEvidenceContract>>
export type PackageCapabilityContracts = Readonly<Record<string, ExportCapabilityContracts>>

/**
 * Binds every admitted `(package, export, capability)` claim to reviewed implementation and behavioral-test files.
 * Evidence paths are relative to the owning workspace and are hashed by the manifest gate.
 */
export const officialCapabilityVocabulary: Readonly<Record<string, PackageCapabilityContracts>> =
  Object.freeze({
    "@likego/broker": {
      ".": {
        broker: { code: ["src/index.ts"], tests: ["test/broker.test.ts"] },
        server: { code: ["src/index.ts"], tests: ["test/broker.test.ts"] }
      },
      "./provider": {
        broker: {
          code: ["src/provider.ts"],
          tests: ["test/public-api.test.ts", "test/broker.test.ts"]
        }
      }
    },
    "@likego/broker-memory": {
      ".": {
        broker: { code: ["src/index.ts"], tests: ["test/broker.test.ts"] },
        "broker-memory": { code: ["src/index.ts"], tests: ["test/broker.test.ts"] },
        server: { code: ["src/index.ts"], tests: ["test/broker.test.ts"] }
      }
    },
    "@likego/broker-rabbitmq": {
      ".": {
        broker: { code: ["src/index.ts"], tests: ["test/broker.test.ts"] },
        "broker-rabbitmq": {
          code: ["src/index.ts"],
          tests: ["test/broker.test.ts", "test/e2e/rabbitmq-docker-e2e.ts"]
        },
        server: { code: ["src/index.ts"], tests: ["test/broker.test.ts"] }
      }
    },
    "@likego/bullmq": {
      ".": {
        bullmq: { code: ["src/server.ts"], tests: ["test/e2e/docker-e2e.ts"] },
        jobs: { code: ["src/server.ts", "src/types.ts"], tests: ["test/processor.test.ts"] },
        server: { code: ["src/server.ts"], tests: ["test/lifecycle.test.ts"] }
      }
    },
    "@likego/cache": {
      ".": {
        cache: {
          code: ["src/types.ts", "src/options.ts"],
          tests: ["test/conformance.test.ts", "test/options-errors.test.ts"]
        }
      },
      "./provider": {
        cache: {
          code: ["src/provider.ts", "src/options.ts"],
          tests: ["test/options-errors.test.ts", "test/public-api.test.ts"]
        }
      }
    },
    "@likego/cache-memory": {
      ".": {
        cache: {
          code: ["src/cache.ts"],
          tests: ["test/cache.test.ts", "test/conformance.test.ts"]
        },
        "cache-memory": {
          code: ["src/cache.ts", "src/options.ts"],
          tests: ["test/cache.test.ts"]
        }
      }
    },
    "@likego/cache-redis": {
      ".": {
        cache: {
          code: ["src/cache.ts", "src/connection.ts"],
          tests: ["test/cache.test.ts", "test/integration/redis-docker.ts"]
        },
        "cache-redis": {
          code: ["src/cache.ts", "src/codec.ts", "src/connection.ts"],
          tests: ["test/cache.test.ts", "test/integration/redis-docker.ts"]
        }
      }
    },
    "@likego/client": {
      ".": {
        client: {
          code: ["src/index.ts", "src/resolver.ts"],
          tests: ["test/client.test.ts"]
        }
      }
    },
    "@likego/config": {
      ".": {
        config: {
          code: ["src/config.ts", "src/source.ts"],
          tests: ["test/load.test.ts", "test/lifecycle.test.ts"]
        }
      },
      "./env": {
        config: { code: ["src/env.ts"], tests: ["test/env.test.ts"] },
        "config-env": { code: ["src/env.ts"], tests: ["test/env.test.ts"] }
      },
      "./file": {
        config: { code: ["src/file.ts"], tests: ["test/file.test.ts"] },
        "config-file": { code: ["src/file.ts"], tests: ["test/file.test.ts"] }
      },
      "./node": {
        "config-file": {
          code: ["src/node.ts", "src/node-host.ts"],
          tests: ["test/node-file.test.ts", "test/node-public-api.test.ts"]
        },
        "node-filesystem": {
          code: ["src/node.ts", "src/node-host.ts"],
          tests: ["test/node-file.test.ts", "test/node-public-api.test.ts"]
        }
      },
      "./yaml": {
        config: { code: ["src/yaml.ts"], tests: ["test/yaml.test.ts"] },
        "config-yaml": { code: ["src/yaml.ts"], tests: ["test/yaml.test.ts"] }
      }
    },
    "@likego/config-consul": {
      ".": {
        config: { code: ["src/index.ts"], tests: ["test/consul.test.ts"] },
        "config-consul": { code: ["src/index.ts"], tests: ["test/integration/consul-docker.ts"] }
      }
    },
    "@likego/config-etcd": {
      ".": {
        config: { code: ["src/index.ts"], tests: ["test/etcd.test.ts"] },
        "config-etcd": {
          code: ["src/index.ts"],
          tests: ["test/integration/etcd-docker.ts"]
        }
      }
    },
    "@likego/config-kubernetes": {
      ".": {
        config: { code: ["src/index.ts"], tests: ["test/kubernetes.test.ts"] },
        "config-kubernetes": {
          code: ["src/index.ts"],
          tests: ["test/kubernetes.test.ts", "test/integration/k3s-docker.ts"]
        }
      }
    },
    "@likego/config-vault": {
      ".": {
        config: { code: ["src/index.ts"], tests: ["test/vault.test.ts"] },
        "config-vault": {
          code: ["src/index.ts"],
          tests: ["test/vault.test.ts", "test/integration/vault-docker.ts"]
        }
      }
    },
    "@likego/context": {
      ".": {
        context: {
          code: ["src/cancel.ts", "src/deadline.ts"],
          tests: ["test/cancel-value.test.ts", "test/deadline.test.ts"]
        }
      }
    },
    "@likego/core": {
      ".": {
        lifecycle: {
          code: ["src/app.ts"],
          tests: ["test/app.test.ts"]
        }
      },
      "./lifecycle": {
        lifecycle: {
          code: ["src/lifecycle.ts"],
          tests: ["test/lifecycle.test.ts", "test/public-api.test.ts"]
        }
      },
      "./node": {
        lifecycle: {
          code: ["src/node.ts"],
          tests: ["test/node.test.ts", "test/node-process.test.ts"]
        }
      }
    },
    "@likego/create": {
      ".": {
        "node-filesystem": {
          code: ["src/project.ts"],
          tests: ["test/create.test.ts"]
        },
        scaffold: {
          code: ["src/cli-run.ts", "src/project.ts", "src/templates.ts"],
          tests: ["test/cli.test.ts", "test/create.test.ts"]
        }
      }
    },
    "@likego/croner": {
      ".": {
        cron: { code: ["src/server.ts"], tests: ["test/e2e/native-e2e.ts"] },
        server: { code: ["src/server.ts"], tests: ["test/lifecycle.test.ts"] }
      }
    },
    "@likego/elysia": {
      ".": {
        web: { code: ["src/index.ts"], tests: ["test/handler.test.ts"] }
      }
    },
    "@likego/event": {
      ".": {
        broker: { code: ["src/index.ts"], tests: ["test/event.test.ts"] },
        event: { code: ["src/index.ts"], tests: ["test/event.test.ts"] }
      }
    },
    "@likego/h3": {
      ".": {
        web: { code: ["src/index.ts"], tests: ["test/handler.test.ts"] }
      }
    },
    "@likego/health": {
      ".": {
        health: { code: ["src/registry.ts"], tests: ["test/registry.test.ts"] }
      }
    },
    "@likego/hono": {
      ".": {
        web: { code: ["src/index.ts"], tests: ["test/handler.test.ts"] }
      }
    },
    "@likego/metadata": {
      ".": {
        metadata: {
          code: ["src/index.ts"],
          tests: ["test/metadata.test.ts", "test/context.test.ts"]
        }
      }
    },
    "@likego/nats": {
      ".": {
        broker: { code: ["src/server.ts"], tests: ["test/e2e/core-docker-e2e.ts"] },
        "nats-core": { code: ["src/server.ts"], tests: ["test/e2e/core-docker-e2e.ts"] },
        server: { code: ["src/server.ts"], tests: ["test/core-lifecycle.test.ts"] }
      },
      "./broker": {
        broker: { code: ["src/broker.ts"], tests: ["test/broker.test.ts"] },
        "nats-core": { code: ["src/broker.ts"], tests: ["test/broker.test.ts"] },
        server: { code: ["src/broker-runtime.ts"], tests: ["test/broker.test.ts"] }
      },
      "./jetstream": {
        broker: { code: ["src/jetstream.ts"], tests: ["test/e2e/jetstream-docker-e2e.ts"] },
        "nats-jetstream": {
          code: ["src/jetstream.ts"],
          tests: ["test/e2e/jetstream-docker-e2e.ts"]
        },
        server: { code: ["src/jetstream.ts"], tests: ["test/jetstream-lifecycle.test.ts"] }
      },
      "./jetstream/broker": {
        broker: {
          code: ["src/jetstream-broker.ts"],
          tests: ["test/jetstream-broker.test.ts"]
        },
        "nats-jetstream": {
          code: ["src/jetstream-broker.ts"],
          tests: ["test/jetstream-broker.test.ts"]
        },
        server: {
          code: ["src/broker-runtime.ts"],
          tests: ["test/jetstream-broker.test.ts"]
        }
      }
    },
    "@likego/otel": {
      ".": {
        broker: { code: ["src/broker.ts"], tests: ["test/instrumentation.test.ts"] },
        client: { code: ["src/client.ts"], tests: ["test/instrumentation.test.ts"] },
        metrics: {
          code: ["src/client.ts", "src/instrumentation.ts", "src/server.ts"],
          tests: ["test/e2e/docker-e2e.ts", "test/metrics.test.ts"]
        },
        observability: {
          code: ["src/broker.ts", "src/client.ts", "src/runtime.ts", "src/server.ts"],
          tests: [
            "test/e2e/docker-e2e.ts",
            "test/e2e/instrumentation-docker.ts",
            "test/instrumentation.test.ts"
          ]
        },
        opentelemetry: {
          code: ["src/index.ts", "src/instrumentation.ts", "src/runtime.ts"],
          tests: ["test/instrumentation.test.ts", "test/official.test.ts"]
        },
        server: {
          code: ["src/runtime.ts", "src/server.ts"],
          tests: ["test/instrumentation.test.ts", "test/runtime.test.ts"]
        },
        web: {
          code: ["src/server.ts"],
          tests: ["test/instrumentation.test.ts"]
        }
      }
    },
    "@likego/pino": {
      ".": {
        broker: { code: ["src/logging.ts"], tests: ["test/logging.test.ts"] },
        client: { code: ["src/logging.ts"], tests: ["test/logging.test.ts"] },
        logging: {
          code: ["src/logging.ts", "src/runtime.ts"],
          tests: ["test/logging.test.ts", "test/runtime.test.ts", "test/smoke/runtime-smoke.ts"]
        },
        server: {
          code: ["src/logging.ts", "src/runtime.ts"],
          tests: ["test/logging.test.ts", "test/runtime.test.ts"]
        },
        web: { code: ["src/logging.ts"], tests: ["test/logging.test.ts"] }
      }
    },
    "@likego/prometheus": {
      ".": {
        broker: { code: ["src/index.ts"], tests: ["test/request-metrics.test.ts"] },
        client: { code: ["src/index.ts"], tests: ["test/request-metrics.test.ts"] },
        metrics: {
          code: ["src/index.ts"],
          tests: ["test/registry-handler.test.ts", "test/request-metrics.test.ts"]
        },
        prometheus: { code: ["src/index.ts"], tests: ["test/smoke/runtime-smoke.ts"] },
        server: { code: ["src/index.ts"], tests: ["test/request-metrics.test.ts"] },
        web: {
          code: ["src/index.ts"],
          tests: ["test/registry-handler.test.ts", "test/request-metrics.test.ts"]
        }
      }
    },
    "@likego/registry": {
      ".": {
        discovery: {
          code: ["src/types.ts", "src/snapshot.ts"],
          tests: ["test/snapshot.test.ts"]
        },
        registry: {
          code: ["src/types.ts", "src/index.ts"],
          tests: ["test/conformance.test.ts"]
        },
        selector: { code: ["src/selector.ts"], tests: ["test/selector.test.ts"] }
      },
      "./provider": {
        registry: {
          code: ["src/provider.ts", "src/options.ts", "src/snapshot.ts", "src/errors.ts"],
          tests: [
            "test/public-api.test.ts",
            "test/options.test.ts",
            "test/snapshot.test.ts",
            "test/errors.test.ts"
          ]
        }
      }
    },
    "@likego/registry-consul": {
      ".": {
        registry: { code: ["src/registration.ts"], tests: ["test/registration.test.ts"] },
        "registry-consul": {
          code: ["src/discovery.ts", "src/registration.ts"],
          tests: ["test/integration/consul-docker.ts"]
        },
        "service-discovery": { code: ["src/discovery.ts"], tests: ["test/discovery.test.ts"] }
      }
    },
    "@likego/registry-etcd": {
      ".": {
        registry: { code: ["src/registration.ts"], tests: ["test/conformance.test.ts"] },
        "registry-etcd": {
          code: ["src/discovery.ts", "src/registration.ts"],
          tests: ["test/integration/etcd-docker.ts"]
        },
        "service-discovery": {
          code: ["src/discovery.ts"],
          tests: ["test/conformance.test.ts"]
        }
      }
    },
    "@likego/registry-kubernetes": {
      ".": {
        registry: {
          code: ["src/registration.ts", "src/discovery.ts"],
          tests: ["test/conformance.test.ts"]
        },
        "registry-kubernetes": {
          code: ["src/records.ts", "src/protocol.ts"],
          tests: ["test/records.test.ts", "test/integration/k3s-docker.ts"]
        },
        "service-discovery": {
          code: ["src/discovery.ts"],
          tests: ["test/conformance.test.ts"]
        }
      }
    },
    "@likego/registry-mdns": {
      ".": {
        registry: { code: ["src/registry.ts"], tests: ["test/conformance.test.ts"] },
        "registry-mdns": { code: ["src/codec.ts"], tests: ["test/codec.test.ts"] },
        "service-discovery": {
          code: ["src/registry.ts", "src/watcher.ts"],
          tests: ["test/watcher.test.ts"]
        }
      },
      "./node": {
        "registry-mdns": { code: ["src/node-host.ts"], tests: ["test/node-host.test.ts"] },
        server: {
          code: ["src/node-host.ts"],
          tests: ["test/node-host.test.ts", "test/e2e/docker-e2e.ts"]
        }
      }
    },
    "@likego/registry-zookeeper": {
      ".": {
        registry: {
          code: ["src/registration.ts", "src/discovery.ts"],
          tests: ["test/conformance.test.ts"]
        },
        "registry-zookeeper": {
          code: ["src/native.ts", "src/tree.ts"],
          tests: ["test/conformance.test.ts"]
        },
        "service-discovery": {
          code: ["src/discovery.ts"],
          tests: ["test/conformance.test.ts"]
        }
      }
    },
    "@likego/resilience": {
      ".": {
        resilience: {
          code: ["src/circuit.ts", "src/retry.ts"],
          tests: ["test/circuit.test.ts", "test/retry.test.ts"]
        }
      }
    },
    "@likego/server": {
      ".": {
        server: { code: ["src/index.ts"], tests: ["test/server.test.ts"] }
      }
    },
    "@likego/store": {
      ".": {
        store: {
          code: ["src/types.ts", "src/options.ts", "src/snapshot.ts"],
          tests: ["test/conformance.test.ts", "test/snapshot.test.ts"]
        }
      },
      "./provider": {
        store: {
          code: ["src/provider.ts", "src/snapshot.ts"],
          tests: ["test/public-api.test.ts", "test/snapshot.test.ts"]
        }
      }
    },
    "@likego/store-memory": {
      ".": {
        store: { code: ["src/store.ts"], tests: ["test/conformance.test.ts"] },
        "store-memory": { code: ["src/store.ts"], tests: ["test/store.test.ts"] }
      }
    },
    "@likego/store-file": {
      ".": {
        store: { code: ["src/store.ts"], tests: ["test/conformance.test.ts"] },
        "store-file": { code: ["src/store.ts"], tests: ["test/file-store.test.ts"] }
      },
      "./node": {
        "node-filesystem": { code: ["src/node-host.ts"], tests: ["test/node-host.test.ts"] },
        "store-file": { code: ["src/node.ts"], tests: ["test/node-host.test.ts"] }
      }
    },
    "@likego/store-consul": {
      ".": {
        store: { code: ["src/store.ts"], tests: ["test/conformance.test.ts"] },
        "store-consul": {
          code: ["src/store.ts"],
          tests: ["test/integration/consul-docker.ts"]
        }
      }
    },
    "@likego/store-etcd": {
      ".": {
        store: { code: ["src/store.ts"], tests: ["test/conformance.test.ts"] },
        "store-etcd": {
          code: ["src/store.ts", "src/protocol.ts"],
          tests: ["test/store.test.ts", "test/integration/etcd-docker.ts"]
        },
        "etcd-json-gateway": {
          code: ["src/http.ts", "src/protocol.ts"],
          tests: ["test/http.test.ts", "test/protocol.test.ts"]
        }
      }
    },
    "@likego/store-vault": {
      ".": {
        store: { code: ["src/store.ts"], tests: ["test/conformance.test.ts"] },
        "store-vault": {
          code: ["src/store.ts", "src/http.ts", "src/codec.ts"],
          tests: ["test/store.test.ts", "test/boundary.test.ts", "test/integration/vault-docker.ts"]
        }
      }
    },
    "@likego/transport": {
      ".": {
        transport: {
          code: ["src/endpoint.ts", "src/index.ts", "src/types.ts", "src/transport-info.ts"],
          tests: [
            "test/conformance.test.ts",
            "test/endpoint.test.ts",
            "test/transport-info.test.ts"
          ]
        }
      },
      "./headers": {
        headers: { code: ["src/headers.ts"], tests: ["test/public-api.test.ts"] },
        transport: { code: ["src/headers.ts"], tests: ["test/public-api.test.ts"] }
      },
      "./json": {
        transport: { code: ["src/json.ts"], tests: ["test/endpoint.test.ts"] }
      },
      "./provider": {
        transport: {
          code: ["src/provider.ts", "src/errors.ts", "src/message.ts", "src/metadata.ts"],
          tests: [
            "test/errors.test.ts",
            "test/message.test.ts",
            "test/metadata-wire.test.ts",
            "test/public-api.test.ts"
          ]
        }
      }
    },
    "@likego/transport-http": {
      ".": {
        http: {
          code: ["src/client.ts", "src/listener.ts"],
          tests: ["test/client.test.ts", "test/listener.test.ts"]
        },
        transport: {
          code: ["src/transport.ts"],
          tests: ["test/client.test.ts", "test/listener.test.ts"]
        }
      },
      "./node": {
        http: { code: ["src/node.ts", "src/node-host.ts"], tests: ["test/node-host.test.ts"] },
        transport: {
          code: ["src/node.ts", "src/node-host.ts"],
          tests: ["test/node-transport.test.ts"]
        }
      }
    },
    "@likego/transport-memory": {
      ".": {
        transport: {
          code: ["src/transport.ts", "src/types.ts"],
          tests: ["test/conformance.test.ts", "test/transport.test.ts"]
        }
      }
    },
    "@likego/web": {
      ".": {
        web: {
          code: ["src/index.ts"],
          tests: [
            "test/context-handler-passthrough.test.ts",
            "test/context-handler-request-abort.test.ts"
          ]
        }
      },
      "./health": {
        health: { code: ["src/health.ts"], tests: ["test/health.test.ts"] },
        web: { code: ["src/health.ts"], tests: ["test/health.test.ts"] }
      },
      "./node": {
        server: {
          code: ["src/node-server.ts"],
          tests: ["test/node/lifecycle.test.ts", "test/e2e/native-e2e.ts"]
        },
        web: { code: ["src/node-server.ts"], tests: ["test/node/host.test.ts"] }
      }
    },
    "@likego/winston": {
      ".": {
        broker: { code: ["src/logging.ts"], tests: ["test/logging.test.ts"] },
        client: { code: ["src/logging.ts"], tests: ["test/logging.test.ts"] },
        logging: {
          code: ["src/logging.ts", "src/server.ts"],
          tests: ["test/logging.test.ts", "test/runtime.test.ts", "test/smoke/runtime-smoke.ts"]
        },
        server: {
          code: ["src/logging.ts", "src/server.ts"],
          tests: ["test/logging.test.ts", "test/runtime.test.ts"]
        },
        web: { code: ["src/logging.ts"], tests: ["test/logging.test.ts"] }
      }
    }
  })

const OfficialCapabilityDirectories: Readonly<Record<string, string>> = Object.freeze({
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
  "@likego/store-memory": "packages/store/memory",
  "@likego/store-consul": "packages/store/consul",
  "@likego/store-etcd": "packages/store/etcd",
  "@likego/store-file": "packages/store/file",
  "@likego/store-vault": "packages/store/vault",
  "@likego/transport": "packages/transport",
  "@likego/transport-http": "packages/transport/http",
  "@likego/transport-memory": "packages/transport/memory",
  "@likego/web": "packages/web",
  "@likego/winston": "packages/winston"
})

/** Returns the complete source/test evidence inventory required by the official vocabulary. */
export function officialCapabilityEvidencePaths(): readonly string[] {
  const paths = new Set<string>()
  for (const [packageName, exportContracts] of Object.entries(officialCapabilityVocabulary)) {
    const directory = OfficialCapabilityDirectories[packageName]
    if (directory === undefined)
      throw new Error(`official capability directory is missing: ${packageName}`)
    for (const contracts of Object.values(exportContracts)) {
      for (const contract of Object.values(contracts)) {
        for (const path of [...contract.code, ...contract.tests]) paths.add(`${directory}/${path}`)
      }
    }
  }
  return Object.freeze(Array.from(paths).sort())
}
