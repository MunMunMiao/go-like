import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

import type { CleanupProof, ScenarioProof, ServiceProof, SuiteEvidence } from "./case"
import { proofContract, type EvidenceExpectation, type SuiteProofContract } from "./contracts"
import { transportHTTPService } from "./package-identities"

interface FieldExpectation {
  readonly path: string
  readonly value: string | number | boolean | readonly string[]
  readonly mode?: "equal" | "includes"
}

interface SuiteDefinition {
  readonly id: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly marker: string | null
  readonly outputIncludes?: string
  readonly fallbackScenarios: readonly string[]
  readonly runtime: "bun" | "node"
  readonly services: readonly string[]
  readonly docker: boolean
  readonly releaseBlocking: boolean
  readonly timeoutMs: number
  readonly expectations: readonly FieldExpectation[]
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

interface CommandDefinition {
  readonly cwd: string
  readonly command: readonly string[]
  readonly timeoutMs: number
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly signal?: AbortSignal | undefined
}

interface StreamCapture {
  readonly done: Promise<void>
  readonly cancel: (reason: unknown) => Promise<void>
  readonly text: () => string
}

type TimedSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly reason: unknown }
  | { readonly kind: "aborted"; readonly reason: unknown }
  | { readonly kind: "timeout" }

export interface DockerSnapshot {
  readonly containers: ReadonlySet<string>
  readonly networks: ReadonlySet<string>
  readonly volumes: ReadonlySet<string>
}

interface RuntimeEvidence {
  readonly label: string
  readonly version: string
  readonly source: string
}

interface RunnerProofValues {
  readonly processTreeClean: boolean
  readonly dockerResourcesRestored: boolean
  readonly runtime: string
  readonly runtimeVersion: string
}

interface ProvenScenarios {
  readonly names: readonly string[]
  readonly proofs: readonly ScenarioProof[]
}

const ConsulImage =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const EtcdImage =
  "gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2"
const K3sImage =
  "rancher/k3s:v1.36.2-k3s1@sha256:6a47cea22c4b834d4ba72c89d291696b79ebe406251f90b446e4dff03513dd87"
const ZookeeperImage =
  "zookeeper:3.9.5@sha256:4c6f15fbd5491a3e01b0108c046891125553329a4956848ba3014cedff5386ee"
const NatsImage =
  "docker.io/library/nats:2.14.3-alpine@sha256:c11af972c99ae542de8925e6a7d9c533aa1eb039660420d2074beed6089b3bf0"
const RedisImage =
  "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb"
const CollectorImage =
  "otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6"
const MDNSNodeImage =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const MDNSNetshootImage =
  "docker.io/nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70"
const ProcessTerminationReserveMs = 7_000
const DockerCleanupReserveMs = 45_000
const DockerInventoryTimeoutMs = 10_000
// ponytail: 2s bounds Docker request visibility; increase it if slower daemon acceptance is observed.
const DockerCleanupQuietMs = 2_000
const DockerCleanupPollMs = 100
const DockerOwnerLabel = "io.likego.e2e.owner"
const DockerOwnerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/

const Definitions: readonly SuiteDefinition[] = Object.freeze([
  {
    id: "kernel-native",
    cwd: ".",
    command: ["bun", "e2e/scripts/kernel-native.ts"],
    marker: "LIKEGO_KERNEL_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: [
      "LikeGo App lifecycle",
      "microtask queue",
      "standard AbortSignal",
      "native timers",
      "standard Fetch",
      "LikeGo probe registry"
    ],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: [
      { path: "cleanup.pendingTimers", value: 0 },
      { path: "cleanup.appCompleted", value: true }
    ]
  },
  {
    id: "resilience-native",
    cwd: ".",
    command: ["bun", "e2e/scripts/resilience-native.ts"],
    marker: "LIKEGO_RESILIENCE_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["native timers", "standard Fetch", "standard monotonic clock"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: [
      { path: "retry.attempts", value: 3 },
      { path: "retry.requestInstances", value: 3 },
      { path: "circuit.invocations", value: 3 },
      { path: "circuit.finalState", value: "closed" },
      { path: "circuit.probeActive", value: false },
      { path: "limiter.initialAdmissions", value: 2 },
      { path: "limiter.rejectedExcess", value: true },
      { path: "cleanup.pendingTimers", value: 0 }
    ]
  },
  {
    id: "store-file-process",
    cwd: ".",
    command: ["bun", "e2e/scripts/store-file-process.ts"],
    marker: "LIKEGO_STORE_FILE_PROCESS_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["Node filesystem", "LikeGo File Store"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 60_000,
    expectations: [
      { path: "cleanup.directoryRemoved", value: true },
      { path: "cleanup.childTerminated", value: true },
      { path: "cleanup.lockRemoved", value: true },
      { path: "cleanup.tempRemoved", value: true }
    ]
  },
  {
    id: "vanilla-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "vanilla"],
    marker: "LIKEGO_WEB_FRAMEWORK_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: ["@hono/node-server 2.0.11", "Node HTTP listener", "standard Fetch"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: []
  },
  {
    id: "hono-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "hono"],
    marker: "LIKEGO_WEB_FRAMEWORK_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: ["Hono 4.12.32", "@hono/node-server 2.0.11", "Node HTTP listener"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: []
  },
  {
    id: "elysia-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "elysia"],
    marker: "LIKEGO_WEB_FRAMEWORK_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: ["Elysia 1.4.29", "@hono/node-server 2.0.11", "Node HTTP listener"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: []
  },
  {
    id: "h3-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "h3"],
    marker: "LIKEGO_WEB_FRAMEWORK_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: ["H3 1.15.11", "@hono/node-server 2.0.11", "Node HTTP listener"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: []
  },
  {
    id: "web-node-native",
    cwd: "packages/web",
    command: ["bun", "run", "e2e:node"],
    marker: "LIKEGO_WEB_NODE_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: [
      "@hono/node-server 2.0.11",
      "TCP client",
      "standard AbortSignal",
      "Node HTTP listener",
      "standard ReadableStream",
      "standard Fetch"
    ],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 60_000,
    expectations: [
      { path: "cleanup.acceptedServers", value: 3 },
      { path: "cleanup.terminalServers", value: 3 },
      { path: "cleanup.lateRejections", value: 0 },
      { path: "cleanup.portReleased", value: true },
      { path: "cleanup.pendingTimers", value: 0 },
      { path: "cleanup.unhandledListenerDelta", value: 0 }
    ]
  },
  {
    id: "transport-http-node",
    cwd: "packages/transport/http",
    command: ["bun", "run", "e2e:node"],
    marker: "LIKEGO_TRANSPORT_HTTP_NODE_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: [transportHTTPService, "Node HTTP 26.5.0", "standard Fetch on Node.js 26.5.0"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 60_000,
    expectations: [
      { path: "cleanup.acceptedServers", value: 6 },
      { path: "cleanup.terminalServers", value: 6 },
      { path: "cleanup.portReleased", value: true },
      { path: "cleanup.pendingTimers", value: 0 },
      { path: "cleanup.unhandledRejections", value: 0 },
      { path: "cleanup.unhandledListenerDelta", value: 0 }
    ]
  },
  {
    id: "cron-native",
    cwd: "packages/croner",
    command: ["bun", "run", "e2e:node"],
    marker: "LIKEGO_CRONER_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: ["Croner 10.0.1", "LikeGo Context", "native timers"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 60_000,
    expectations: [
      { path: "cleanup.unhandledRejections", value: 0 },
      { path: "cleanup.pendingTimers", value: 0 }
    ]
  },
  {
    id: "bullmq-docker",
    cwd: "packages/bullmq",
    command: ["bun", "run", "e2e:docker"],
    marker: "LIKEGO_BULLMQ_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["BullMQ 5.81.2", "Redis 8.8.1", "Redis 8.8.1 Docker"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "bullmqVersion", value: "5.81.2" },
      { path: "image", value: RedisImage },
      { path: "redisVersion", value: "8.8.1", mode: "includes" },
      { path: "lateRejections", value: 0 },
      { path: "remainingContainers", value: 0 },
      { path: "persistentConnections", value: 0 }
    ]
  },
  {
    id: "nats-core-docker",
    cwd: "packages/nats",
    command: ["bun", "run", "e2e:docker:core"],
    marker: "LIKEGO_NATS_CORE_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["NATS Server 2.14.3 Docker", "NATS JavaScript 3.4.0"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "image", value: NatsImage },
      { path: "serverVersion", value: "2.14.3", mode: "includes" },
      { path: "sdkVersion", value: "3.4.0" },
      { path: "lateRejections", value: 0 },
      { path: "remainingContainers", value: 0 }
    ]
  },
  {
    id: "nats-jetstream-docker",
    cwd: "packages/nats",
    command: ["bun", "run", "e2e:docker:jetstream"],
    marker: "LIKEGO_NATS_JETSTREAM_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["NATS Server 2.14.3 with JetStream", "NATS JavaScript 3.4.0"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "image", value: NatsImage },
      { path: "serverVersion", value: "2.14.3", mode: "includes" },
      { path: "sdkVersion", value: "3.4.0" },
      { path: "lateRejections", value: 0 },
      { path: "remainingContainers", value: 0 }
    ]
  },
  {
    id: "config-consul-docker",
    cwd: "packages/config/consul",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_CONFIG_CONSUL_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["Consul 2.0.2 Docker", "standard Fetch"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "image", value: ConsulImage },
      { path: "consulVersion", value: "2.0.2", mode: "includes" },
      { path: "cleanup.remainingContainers", value: 0 },
      { path: "cleanup.pendingTimers", value: 0 }
    ]
  },
  {
    id: "config-etcd-docker",
    cwd: "packages/config/etcd",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_CONFIG_ETCD_DOCKER=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "image", value: EtcdImage },
      { path: "resourcesClean", value: true },
      { path: "cleanup.remoteKeys", value: 0 },
      { path: "cleanup.watchersStopped", value: true }
    ]
  },
  {
    id: "store-consul-docker",
    cwd: "packages/store/consul",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_STORE_CONSUL_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["Consul 2.0.2 Docker", "Consul 2.0.2 Docker with ACLs", "standard Fetch"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 300_000,
    expectations: [
      { path: "image", value: ConsulImage },
      { path: "binaryVersion", value: "Consul v2.0.2", mode: "includes" },
      { path: "cleanup.remoteKv", value: 0 },
      { path: "cleanup.remoteSessions", value: 0 },
      { path: "cleanup.containers", value: 0 }
    ]
  },
  {
    id: "store-etcd-docker",
    cwd: "packages/store/etcd",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_STORE_ETCD_DOCKER_V1=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 240_000,
    expectations: [
      { path: "image", value: EtcdImage },
      { path: "etcd", value: "3.7.1" },
      { path: "containerRemoved", value: true },
      { path: "cleanup.remoteKeys", value: 0 },
      { path: "cleanup.remoteLeases", value: 0 }
    ]
  },
  {
    id: "registry-consul-docker",
    cwd: "packages/registry/consul",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_REGISTRY_CONSUL_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["Consul 2.0.2 Docker", "standard Fetch", "TTL health check"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 300_000,
    expectations: [
      { path: "image", value: ConsulImage },
      { path: "consulVersion", value: "2.0.2", mode: "includes" },
      { path: "scenarioEvidence.service-instance-roundtrip.valid", value: true },
      { path: "scenarioEvidence.service-instance-roundtrip.discoveredExact", value: true },
      { path: "scenarioEvidence.replacement-snapshot-watch.valid", value: true },
      { path: "scenarioEvidence.replacement-snapshot-watch.emptySnapshot", value: 0 },
      { path: "scenarioEvidence.private-ttl-heartbeat.valid", value: true },
      { path: "scenarioEvidence.private-ttl-heartbeat.publicHandleExposed", value: false },
      { path: "cleanup.watcherTerminal", value: true },
      { path: "cleanup.registrationRemoved", value: true },
      { path: "cleanup.residualContainers", value: 0 }
    ]
  },
  {
    id: "registry-etcd-docker",
    cwd: "packages/registry/etcd",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_ETCD_DOCKER_V2=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 300_000,
    expectations: [
      { path: "image", value: EtcdImage },
      { path: "status", value: "passed" },
      {
        path: "scenarioEvidence.service-instance-register-get-watch-update-deregister.registerGet",
        value: true
      },
      {
        path: "scenarioEvidence.lost-transaction-response-exact-readback.exactReadback",
        value: true
      },
      { path: "scenarioEvidence.sigkill-publisher-lease-expiry.expired", value: true },
      { path: "cleanup.remoteInstances", value: 0 },
      { path: "cleanup.watcherStopped", value: true }
    ]
  },
  {
    id: "registry-kubernetes-docker",
    cwd: "packages/registry/kubernetes",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_KUBERNETES_DOCKER_V2=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["K3s 1.36.2 Docker", "Kubernetes EndpointSlice API", "standard Fetch"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 420_000,
    expectations: [
      { path: "image", value: K3sImage },
      { path: "api", value: "discovery.k8s.io/v1 EndpointSlice" },
      { path: "resourceVersionCas", value: true },
      { path: "staleWatchRecovery", value: true },
      { path: "foreignIsolation", value: true },
      { path: "podOwnerGarbageCollected", value: true },
      { path: "cleanup.managedEndpointSlices", value: 0 },
      { path: "cleanup.namespaces", value: 0 },
      { path: "cleanup.containerRemoved", value: true },
      { path: "cleanup.volumesRemoved", value: 4 }
    ]
  },
  {
    id: "registry-zookeeper-docker",
    cwd: "packages/registry/zookeeper",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_ZOOKEEPER_DOCKER_EVIDENCE_V2=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["ZooKeeper 3.9.5 Docker", "node-zookeeper-client 1.1.3"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 420_000,
    expectations: [
      { path: "image", value: ZookeeperImage },
      { path: "valid", value: true },
      {
        path: "scenarios",
        value: [
          "service-instance-register-get-watch-update-deregister",
          "sigkill-publisher-ephemeral-expiry"
        ]
      },
      {
        path: "scenarioEvidence.service-instance-register-get-watch-update-deregister.registerGet",
        value: true
      },
      {
        path: "scenarioEvidence.sigkill-publisher-ephemeral-expiry.ephemeralRecordExpired",
        value: true
      },
      { path: "cleanup.remoteZnodes", value: 0 },
      { path: "cleanup.externalSessions", value: 0 },
      { path: "cleanup.containerRemaining", value: 0 }
    ]
  },
  {
    id: "registry-transport-consul-docker",
    cwd: ".",
    command: ["bun", "e2e/scripts/registry-transport-consul-docker.ts"],
    marker: "LIKEGO_REGISTRY_TRANSPORT_CONSUL_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["Consul 2.0.2 Docker", "LikeGo HTTP Transport", "LikeGo Server", "standard Fetch"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "valid", value: true },
      { path: "image", value: ConsulImage },
      {
        path: "scenarioEvidence.lifecycleOrder",
        value:
          "start:a,bind:a,register:a,start:b,bind:b,register:b,deregister:a,stop:a,deregister:b,stop:b"
      },
      { path: "scenarioEvidence.roundRobinSequence", value: "a,b,a,b" },
      { path: "scenarioEvidence.postDeregisterNode", value: "b" },
      { path: "cleanup.remainingContainers", value: 0 },
      { path: "cleanup.remainingNetworks", value: 0 },
      { path: "cleanup.remainingProviderRegistrations", value: 0 },
      { path: "cleanup.appsStopped", value: true },
      { path: "cleanup.appRunsSettled", value: true }
    ]
  },
  {
    id: "registry-mdns-docker",
    cwd: "packages/registry/mdns",
    command: ["bun", "run", "test:docker"],
    marker: "LIKEGO_REGISTRY_MDNS_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: [
      "Node.js 24.18.0 Docker",
      "Node dgram UDP multicast",
      "mDNS IPv4 multicast",
      "mDNS IPv6 multicast",
      "Docker packet capture"
    ],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 240_000,
    expectations: [
      { path: "nodeRuntime", value: "Node.js 24.18.0" },
      { path: "images.node", value: MDNSNodeImage },
      { path: "images.netshoot", value: MDNSNetshootImage },
      {
        path: "scenarios",
        value: [
          "register-discover",
          "watch-update-delete",
          "crash-expiry",
          "collision-rescue",
          "wire-cleanup"
        ]
      },
      { path: "scenarioEvidence.register-discover.ipv4Created", value: true },
      { path: "scenarioEvidence.register-discover.ipv6Created", value: true },
      { path: "scenarioEvidence.register-discover.ipv6AdvertisedULAObserved", value: true },
      { path: "scenarioEvidence.register-discover.ipv6PacketLinkLocalObserved", value: true },
      {
        path: "scenarioEvidence.register-discover.ipv6SingleIdentityLifecycleObserved",
        value: true
      },
      { path: "scenarioEvidence.register-discover.ipv6IdentityLifecycle.identityCount", value: 1 },
      { path: "scenarioEvidence.register-discover.ipv6IdentityLifecycle.createCount", value: 1 },
      { path: "scenarioEvidence.register-discover.ipv6IdentityLifecycle.updateCount", value: 2 },
      { path: "scenarioEvidence.register-discover.ipv6IdentityLifecycle.deleteCount", value: 1 },
      { path: "scenarioEvidence.register-discover.ipv6ULAtoLinkLocalAliasObserved", value: true },
      { path: "scenarioEvidence.watch-update-delete.ipv4Deleted", value: true },
      { path: "scenarioEvidence.watch-update-delete.ipv6Deleted", value: true },
      { path: "scenarioEvidence.crash-expiry.publisherExitCode", value: 137 },
      { path: "scenarioEvidence.crash-expiry.expiryDeleteObserved", value: true },
      {
        path: "scenarioEvidence.collision-rescue.ipv4CollisionCode",
        value: "LIKEGO_REGISTRY_PROTOCOL"
      },
      {
        path: "scenarioEvidence.collision-rescue.ipv6CollisionCode",
        value: "LIKEGO_REGISTRY_PROTOCOL"
      },
      { path: "scenarioEvidence.wire-cleanup.ipv4IPTTL255", value: true },
      { path: "scenarioEvidence.wire-cleanup.ipv6IPTTL255", value: true },
      { path: "scenarioEvidence.wire-cleanup.ipv4RecordTTL120And0", value: true },
      { path: "scenarioEvidence.wire-cleanup.ipv6RecordTTL120And0", value: true },
      { path: "scenarioEvidence.wire-cleanup.ipv4CompleteRRGraph", value: true },
      { path: "scenarioEvidence.wire-cleanup.ipv6CompleteRRGraph", value: true },
      { path: "scenarioEvidence.wire-cleanup.ipv4CacheFlushClassificationValid", value: true },
      { path: "scenarioEvidence.wire-cleanup.ipv6CacheFlushClassificationValid", value: true },
      { path: "scenarioEvidence.crash-expiry.recordTTL2", value: true },
      { path: "cleanup.projectsRemoved", value: true },
      { path: "cleanup.containersRemoved", value: true },
      { path: "cleanup.networksRemoved", value: true },
      { path: "cleanup.processTreesRemoved", value: true },
      { path: "cleanup.protectedContainersUnchanged", value: true }
    ]
  },
  {
    id: "otel-docker",
    cwd: "packages/otel",
    command: ["bun", "test/e2e/docker-e2e.ts"],
    marker: "LIKEGO_OTEL_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: ["OpenTelemetry JavaScript 2.10.0", "Collector 0.157.0 Docker"],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "image", value: CollectorImage },
      { path: "collectorVersion", value: "0.157.0" },
      { path: "cleanup.remainingContainers", value: 0 },
      { path: "cleanup.duplicateShutdownSpans", value: 0 }
    ]
  },
  {
    id: "otel-instrumentation-docker",
    cwd: "packages/otel",
    command: ["bun", "test/e2e/instrumentation-docker.ts"],
    marker: "LIKEGO_OTEL_INSTRUMENTATION_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "bun",
    services: [
      "OpenTelemetry JavaScript 2.10.0",
      "Collector 0.157.0 Docker",
      "standard Web handler",
      "Node HTTP listener"
    ],
    docker: true,
    releaseBlocking: true,
    timeoutMs: 180_000,
    expectations: [
      { path: "collector.image", value: CollectorImage },
      { path: "collector.version", value: "0.157.0" },
      { path: "collectorSpanCount", value: 5 },
      { path: "cleanup.residualContainers", value: 0 }
    ]
  },
  {
    id: "pino-runtime",
    cwd: "packages/pino",
    command: ["bun", "x", "tsx", "test/e2e/native-e2e.ts"],
    marker: "LIKEGO_PINO_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: [
      "Pino 10.3.1",
      "Pino-owned SonicBoom 4.2.1",
      "thread-stream 4.2.0",
      "native filesystem",
      "native worker and filesystem"
    ],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: []
  },
  {
    id: "winston-runtime",
    cwd: "packages/winston",
    command: ["bun", "x", "tsx", "../../e2e/scripts/winston-native.ts"],
    marker: "LIKEGO_WINSTON_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: ["Winston 3.19.0", "Winston File transport", "native filesystem"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: [
      { path: "winstonVersion", value: "3.19.0" },
      { path: "assertions.nativeLoggerRecord", value: true },
      { path: "assertions.joinedStops", value: true },
      { path: "assertions.fileLanded", value: true },
      { path: "cleanup.terminalCompleted", value: true },
      { path: "cleanup.listenerDelta", value: 0 },
      { path: "cleanup.directoryRemoved", value: true }
    ]
  },
  {
    id: "prometheus-runtime",
    cwd: "packages/prometheus",
    command: ["node", "../../e2e/scripts/prometheus-native.ts"],
    marker: "LIKEGO_PROMETHEUS_E2E_RESULT=",
    fallbackScenarios: [],
    runtime: "node",
    services: ["prom-client 15.1.3", "standard Web Handler"],
    docker: false,
    releaseBlocking: true,
    timeoutMs: 30_000,
    expectations: [
      { path: "promClientVersion", value: "15.1.3" },
      { path: "scrape.status", value: 200 },
      { path: "scrape.samplePresent", value: true },
      { path: "cleanup.registryCleared", value: true }
    ]
  }
])

/** Narrows an unknown JSON value to an inspectable object. */
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one dotted object path without trusting prototype accessors. */
function field(value: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split(".")) {
    if (!record(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/** Formats one verified structured expectation as a stable proof source. */
function expectationSource(expectation: EvidenceExpectation): string {
  return `${expectation.path}:${expectation.mode}:${String(expectation.value)}`
}

/** Rejects slug-shaped and unconditional booleans that merely rename an assertion. */
function domainExpectation(expectation: EvidenceExpectation): boolean {
  return (
    expectation.path !== "details.valid" &&
    expectation.path !== "details.scenarios" &&
    !expectation.path.endsWith(".asserted")
  )
}

/** Verifies one structured details value or independently observed runner fact. */
function verifyEvidenceExpectation(
  suite: string,
  root: Readonly<Record<string, unknown>>,
  expectation: EvidenceExpectation
): void {
  const observed = field(root, expectation.path)
  if (expectation.mode === "includes") {
    if (typeof observed !== "string" || !observed.includes(String(expectation.value))) {
      throw new Error(`${suite} expected ${expectation.path} to include ${expectation.value}`)
    }
    return
  }
  if (expectation.mode === "array-includes") {
    if (!Array.isArray(observed) || !observed.includes(expectation.value)) {
      throw new Error(`${suite} expected ${expectation.path} to include ${expectation.value}`)
    }
    return
  }
  if (expectation.mode === "greater-than") {
    if (
      typeof observed !== "number" ||
      typeof expectation.value !== "number" ||
      observed <= expectation.value
    ) {
      throw new Error(
        `${suite} expected ${expectation.path} > ${expectation.value}, observed ${String(observed)}`
      )
    }
    return
  }
  if (expectation.mode === "less-than") {
    if (
      typeof observed !== "number" ||
      typeof expectation.value !== "number" ||
      observed >= expectation.value
    ) {
      throw new Error(
        `${suite} expected ${expectation.path} < ${expectation.value}, observed ${String(observed)}`
      )
    }
    return
  }
  if (expectation.mode === "non-empty") {
    const present = (typeof observed === "string" || Array.isArray(observed)) && observed.length > 0
    if (!present) throw new Error(`${suite} expected ${expectation.path} to be non-empty`)
    return
  }
  if (observed !== expectation.value) {
    throw new Error(
      `${suite} expected ${expectation.path}=${expectation.value}, observed ${String(observed)}`
    )
  }
}

/** Verifies a non-empty, claim-specific proof list and returns its structured sources. */
function verifyProofList(
  suite: string,
  root: Readonly<Record<string, unknown>>,
  expectations: readonly EvidenceExpectation[],
  label: string
): readonly string[] {
  if (expectations.length === 0 || !expectations.some(domainExpectation)) {
    throw new Error(`${suite} ${label} lacks structured domain evidence`)
  }
  for (const expectation of expectations) verifyEvidenceExpectation(suite, root, expectation)
  return Object.freeze(expectations.map(expectationSource))
}

/** Extracts string scenario names from either a string list or registry-style result objects. */
function scenarioNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      names.push(entry)
      continue
    }
    if (record(entry) && typeof entry.name === "string" && entry.valid === true) {
      names.push(entry.name)
    }
  }
  return Object.freeze(names)
}

/** Parses the final JSON value following one stable suite marker. */
function markerRecord(output: string, marker: string): Readonly<Record<string, unknown>> {
  const markerIndex = output.lastIndexOf(marker)
  if (markerIndex < 0) throw new Error(`missing machine-readable marker ${marker}`)
  const afterMarker = output.slice(markerIndex + marker.length)
  const line = afterMarker.split(/\r?\n/, 1)[0]?.trim() ?? ""
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(`marker ${marker} did not contain JSON`, { cause: error })
  }
  if (!record(parsed)) throw new Error(`marker ${marker} must contain an object`)
  return parsed
}

/** Settles one promise within a caller-owned deadline without leaving an unhandled rejection. */
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<TimedSettlement<T>> {
  return await new Promise<TimedSettlement<T>>(function settle(resolveSettlement) {
    let settled = false
    function finish(settlement: TimedSettlement<T>): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener("abort", aborted)
      resolveSettlement(Object.freeze(settlement))
    }
    function aborted(): void {
      finish({ kind: "aborted", reason: signal?.reason })
    }
    const timeout = setTimeout(function timedOut() {
      finish({ kind: "timeout" })
    }, timeoutMs)
    signal?.addEventListener("abort", aborted, { once: true })
    if (signal?.aborted === true) aborted()
    promise.then(
      function fulfilled(value) {
        finish({ kind: "fulfilled", value })
      },
      function rejected(reason: unknown) {
        finish({ kind: "rejected", reason })
      }
    )
  })
}

/** Captures a subprocess pipe while retaining a cancellation path for inherited descriptors. */
function captureStream(stream: ReadableStream<Uint8Array>): StreamCapture {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  const done = (async function read(): Promise<void> {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        output += decoder.decode(chunk.value, { stream: true })
      }
      output += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  })()
  return Object.freeze({
    done,
    async cancel(reason: unknown): Promise<void> {
      await reader.cancel(reason)
    },
    text(): string {
      return output
    }
  })
}

/** Returns whether a POSIX process group still owns at least one process. */
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

/** Sends one argv-safe signal to the complete detached child tree. */
function signalProcessTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    const force = signal === "SIGKILL" ? ["/F"] : []
    Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", ...force], {
      stdout: "ignore",
      stderr: "ignore"
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    child.kill(signal)
  }
}

/** Terminates an argv-spawned process tree, escalating after a bounded POSIX grace period. */
async function terminateProcessTree(child: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    signalProcessTree(child, "SIGKILL")
    return
  }
  signalProcessTree(child, "SIGTERM")
  const deadline = performance.now() + 2_000
  while (processGroupExists(child.pid) && performance.now() < deadline) {
    await Bun.sleep(25)
  }
  if (processGroupExists(child.pid)) signalProcessTree(child, "SIGKILL")
}

/** Cancels inherited output pipes without allowing cancellation itself to become unbounded. */
async function cancelCaptures(captures: readonly StreamCapture[], reason: unknown): Promise<void> {
  const cancellation = Promise.allSettled(
    captures.map(function cancel(capture) {
      return capture.cancel(reason)
    })
  )
  await settleWithin(cancellation, 1_000)
}

/** Runs one argv-safe detached child tree with a hard owner timeout. */
export async function runCommand(
  root: string,
  definition: CommandDefinition
): Promise<CommandResult> {
  if (definition.signal?.aborted === true) throw definition.signal.reason
  const child = Bun.spawn(definition.command.slice(), {
    cwd: resolve(root, definition.cwd),
    stdout: "pipe",
    stderr: "pipe",
    env: processEnv(definition.environment),
    detached: true
  })
  const stdout = captureStream(child.stdout)
  const stderr = captureStream(child.stderr)
  let exitCode: number | null = null
  const exited = child.exited.then(function observed(code) {
    exitCode = code
    return code
  })
  const complete = Promise.all([exited, stdout.done, stderr.done]).then(
    function commandComplete(values) {
      return values[0]
    }
  )
  const settlement = await settleWithin(complete, definition.timeoutMs, definition.signal)
  if (settlement.kind === "fulfilled") {
    if (process.platform !== "win32" && processGroupExists(child.pid)) {
      await terminateProcessTree(child)
      throw new Error("command exited while descendant processes remained")
    }
    return Object.freeze({
      exitCode: settlement.value,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut: false
    })
  }

  const reason =
    settlement.kind === "timeout"
      ? new Error(`command exceeded ${definition.timeoutMs}ms`)
      : settlement.kind === "aborted"
        ? settlement.reason
        : new Error("command output capture failed", { cause: settlement.reason })
  try {
    await terminateProcessTree(child)
  } catch (cleanupFailure) {
    try {
      signalProcessTree(child, "SIGKILL")
    } catch {
      // Direct termination remains available when group termination fails.
    }
    try {
      child.kill("SIGKILL")
    } catch {
      // The process may have exited between cleanup attempts.
    }
    try {
      process.stderr.write(
        `LikeGo runCommand process-tree cleanup failed: ${String(cleanupFailure)}\n`
      )
    } catch {
      // Cleanup diagnostics must not replace the settled command reason.
    }
  }
  const drained = await settleWithin(complete, 2_000)
  if (drained.kind !== "fulfilled") {
    await cancelCaptures([stdout, stderr], reason)
    await settleWithin(complete, 1_000)
  }
  if (settlement.kind === "rejected" || settlement.kind === "aborted") throw reason
  return Object.freeze({
    exitCode: exitCode ?? -1,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut: true
  })
}

/** Runs one command that must finish successfully inside its complete process-tree boundary. */
export async function runCheckedCommand(
  root: string,
  command: readonly string[],
  timeoutMs: number
): Promise<CommandResult> {
  const result = await runCommand(root, { cwd: ".", command, timeoutMs })
  if (result.timedOut) throw new Error(`command exceeded ${timeoutMs}ms`)
  if (result.exitCode !== 0) {
    throw new Error(
      `${command[0] ?? "command"} exited ${result.exitCode}: ${result.stderr.slice(-4_000)}`
    )
  }
  return result
}

/** Captures the current environment plus explicit child-only overrides. */
function processEnv(
  overrides: Readonly<Record<string, string | undefined>> = Object.freeze({})
): Readonly<Record<string, string | undefined>> {
  return Object.freeze(
    Object.fromEntries([...Object.entries(process.env), ...Object.entries(overrides)])
  )
}

/** Returns one timeout that fits before a shared suite deadline and its reserved cleanup window. */
function availableTimeout(
  deadline: number,
  reserveMs: number,
  maximumMs: number,
  label: string
): number {
  const available = Math.floor(deadline - performance.now()) - reserveMs
  if (available < 1)
    throw new Error(`${label} has no time remaining inside the suite owner deadline`)
  return Math.min(maximumMs, available)
}

/** Rejects missing or argv-unsafe Docker owner values before any resource can be created. */
function validDockerOwner(owner: string): string {
  if (!DockerOwnerPattern.test(owner)) throw new Error("invalid LIKEGO_E2E_OWNER")
  return owner
}

/** Creates one invocation-unique Docker owner value. */
export function newDockerOwner(suite: string): string {
  return validDockerOwner(`${suite}-${randomUUID()}`)
}

/** Returns exact-label Docker inventory commands for one invocation owner. */
export function dockerInventoryCommands(
  owner: string
): readonly [readonly string[], readonly string[], readonly string[]] {
  const filter = `label=${DockerOwnerLabel}=${validDockerOwner(owner)}`
  return [
    ["docker", "ps", "--all", "--filter", filter, "--format", "{{.Names}}"],
    ["docker", "network", "ls", "--filter", filter, "--format", "{{.Name}}"],
    ["docker", "volume", "ls", "--filter", filter, "--format", "{{.Name}}"]
  ]
}

/** Returns cleanup commands in dependency order: containers, networks, then volumes. */
export function dockerRemovalCommands(snapshot: DockerSnapshot): readonly (readonly string[])[] {
  const commands: string[][] = []
  const containers = Array.from(snapshot.containers).sort()
  const networks = Array.from(snapshot.networks).sort()
  const volumes = Array.from(snapshot.volumes).sort()
  if (containers.length > 0) commands.push(["docker", "rm", "--force", "--volumes", ...containers])
  if (networks.length > 0) commands.push(["docker", "network", "rm", ...networks])
  if (volumes.length > 0) commands.push(["docker", "volume", "rm", ...volumes])
  return Object.freeze(
    commands.map(function freezeCommand(command) {
      return Object.freeze(command)
    })
  )
}

/** Runs one bounded Docker inventory command and returns exact-label resource names. */
async function dockerNames(
  root: string,
  command: readonly string[],
  timeoutMs: number
): Promise<ReadonlySet<string>> {
  const result = await runCheckedCommand(root, command, timeoutMs)
  const names = result.stdout
    .split(/\r?\n/)
    .map(function trim(value) {
      return value.trim()
    })
    .filter(function nonempty(value) {
      return value.length > 0
    })
  return new Set(names)
}

/** Snapshots resources carrying one exact invocation owner label. */
async function dockerSnapshot(
  root: string,
  owner: string,
  timeoutMs: number
): Promise<DockerSnapshot> {
  const commands = dockerInventoryCommands(owner)
  const snapshots = await Promise.all([
    dockerNames(root, commands[0], timeoutMs),
    dockerNames(root, commands[1], timeoutMs),
    dockerNames(root, commands[2], timeoutMs)
  ])
  return Object.freeze({ containers: snapshots[0], networks: snapshots[1], volumes: snapshots[2] })
}

/** Fails and cleans when a Docker suite leaves any exact-owner resource behind. */
export async function verifyDockerOwnerCleanup(
  root: string,
  owner: string,
  deadline: number
): Promise<void> {
  const containers = new Set<string>()
  const networks = new Set<string>()
  const volumes = new Set<string>()
  const cleanupFailures: unknown[] = []
  let quietSince: number | null = null
  let remaining: DockerSnapshot = {
    containers: new Set<string>(),
    networks: new Set<string>(),
    volumes: new Set<string>()
  }
  while (true) {
    const inventoryTimeout = availableTimeout(
      deadline,
      25_000,
      DockerInventoryTimeoutMs,
      "Docker cleanup inventory"
    )
    const observed = await dockerSnapshot(root, owner, inventoryTimeout)
    remaining = observed
    const observedContainers = Array.from(observed.containers).sort()
    const observedNetworks = Array.from(observed.networks).sort()
    const observedVolumes = Array.from(observed.volumes).sort()
    if (
      observedContainers.length === 0 &&
      observedNetworks.length === 0 &&
      observedVolumes.length === 0
    ) {
      const now = performance.now()
      quietSince ??= now
      const quietRemaining = DockerCleanupQuietMs - (now - quietSince)
      if (quietRemaining <= 0) break
      const pauseMs = availableTimeout(
        deadline,
        ProcessTerminationReserveMs,
        Math.min(DockerCleanupPollMs, Math.ceil(quietRemaining)),
        "Docker cleanup quiet window"
      )
      await Bun.sleep(pauseMs)
      continue
    }
    quietSince = null
    for (const name of observedContainers) containers.add(name)
    for (const name of observedNetworks) networks.add(name)
    for (const name of observedVolumes) volumes.add(name)
    const failuresBeforeCleanup = cleanupFailures.length
    const commands = dockerRemovalCommands(observed)
    const containerCommand = observedContainers.length === 0 ? null : commands[0]
    if (containerCommand === undefined)
      throw new Error("Docker cleanup plan omitted owned containers")
    const dependentCommands = containerCommand === null ? commands : commands.slice(1)
    if (containerCommand !== null) {
      try {
        const timeoutMs = availableTimeout(deadline, 20_000, 10_000, "Docker container cleanup")
        await runCheckedCommand(root, containerCommand, timeoutMs)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    const dependencyTimeout = availableTimeout(
      deadline,
      12_000,
      10_000,
      "Docker network and volume cleanup"
    )
    const dependencyCleanup = await Promise.allSettled(
      dependentCommands.map(function cleanup(command) {
        return runCheckedCommand(root, command, dependencyTimeout)
      })
    )
    for (const outcome of dependencyCleanup) {
      if (outcome.status === "rejected") cleanupFailures.push(outcome.reason)
    }
    if (cleanupFailures.length > failuresBeforeCleanup) {
      const finalInventoryTimeout = availableTimeout(
        deadline,
        ProcessTerminationReserveMs,
        8_000,
        "Docker post-cleanup inventory"
      )
      remaining = await dockerSnapshot(root, owner, finalInventoryTimeout)
      break
    }
  }
  const leakedContainers = Array.from(containers).sort()
  const leakedNetworks = Array.from(networks).sort()
  const leakedVolumes = Array.from(volumes).sort()
  const remainingContainers = Array.from(remaining.containers).sort()
  const remainingNetworks = Array.from(remaining.networks).sort()
  const remainingVolumes = Array.from(remaining.volumes).sort()
  if (leakedContainers.length > 0 || leakedNetworks.length > 0 || leakedVolumes.length > 0) {
    const message = `Docker suite leaked resources: containers=${leakedContainers.join(",")} networks=${leakedNetworks.join(",")} volumes=${leakedVolumes.join(",")}`
    if (
      cleanupFailures.length > 0 ||
      remainingContainers.length > 0 ||
      remainingNetworks.length > 0 ||
      remainingVolumes.length > 0
    ) {
      const failures = cleanupFailures.slice()
      if (
        remainingContainers.length > 0 ||
        remainingNetworks.length > 0 ||
        remainingVolumes.length > 0
      ) {
        failures.push(
          new Error(
            `Docker owner cleanup incomplete: containers=${remainingContainers.join(",")} networks=${remainingNetworks.join(",")} volumes=${remainingVolumes.join(",")}`
          )
        )
      }
      throw new AggregateError(failures, message)
    }
    throw new Error(message)
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(cleanupFailures, "Docker cleanup commands failed")
  if (
    remainingContainers.length > 0 ||
    remainingNetworks.length > 0 ||
    remainingVolumes.length > 0
  ) {
    throw new Error(
      `Docker owner cleanup incomplete: containers=${remainingContainers.join(",")} networks=${remainingNetworks.join(",")} volumes=${remainingVolumes.join(",")}`
    )
  }
}

/** Validates every version and cleanup field declared by a suite definition. */
function verifyExpectations(
  definition: SuiteDefinition,
  details: Readonly<Record<string, unknown>>
): void {
  for (const expectation of definition.expectations) {
    const observed = field(details, expectation.path)
    if (expectation.mode === "includes") {
      if (typeof observed !== "string" || !observed.includes(String(expectation.value))) {
        throw new Error(
          `${definition.id} expected ${expectation.path} to include ${expectation.value}`
        )
      }
      continue
    }
    if (Array.isArray(expectation.value)) {
      const matches =
        Array.isArray(observed) &&
        observed.length === expectation.value.length &&
        expectation.value.every(function exact(value, index): boolean {
          return observed[index] === value
        })
      if (!matches) {
        throw new Error(
          `${definition.id} expected ${expectation.path}=${JSON.stringify(expectation.value)}, observed ${JSON.stringify(observed)}`
        )
      }
      continue
    }
    if (observed !== expectation.value) {
      throw new Error(
        `${definition.id} expected ${expectation.path}=${expectation.value}, observed ${String(observed)}`
      )
    }
  }
}

/** Observes the executable runtime version used by one suite lane. */
async function runtimeEvidence(
  root: string,
  definition: SuiteDefinition,
  deadline: number
): Promise<RuntimeEvidence> {
  if (definition.runtime === "bun") {
    return Object.freeze({
      label: `Bun ${Bun.version}`,
      version: Bun.version,
      source: "runner.Bun.version"
    })
  }
  const timeoutMs = availableTimeout(
    deadline,
    ProcessTerminationReserveMs,
    5_000,
    `${definition.id} runtime probe`
  )
  const result = await runCheckedCommand(root, ["node", "--version"], timeoutMs)
  const version = result.stdout.trim().replace(/^v/, "")
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${definition.id} Node runtime probe returned ${result.stdout.trim()}`)
  }
  return Object.freeze({
    label: `Node.js ${version}`,
    version,
    source: "command:node --version"
  })
}

/** Verifies an optional suite-reported runtime against the executed runtime probe. */
function verifyReportedRuntime(
  definition: SuiteDefinition,
  details: Readonly<Record<string, unknown>>,
  runtime: RuntimeEvidence
): void {
  const reported = details["runtime"]
  if (reported === undefined) return
  if (typeof reported !== "string" || !reported.includes(runtime.version)) {
    throw new Error(
      `${definition.id} reported runtime ${String(reported)}, executed ${runtime.label}`
    )
  }
}

/** Binds every release claim to matched structured values instead of trusting scenario slugs. */
function provenScenarios(
  definition: SuiteDefinition,
  details: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
  contract: SuiteProofContract | null
): ProvenScenarios {
  const observed = scenarioNames(details["scenarios"])
  if (definition.releaseBlocking) {
    if (contract === null) throw new Error(`${definition.id} has no release evidence contract`)
    const names = Object.keys(contract.scenarios).sort()
    if (names.length === 0) throw new Error(`${definition.id} release contract has no scenarios`)
    const proofs: ScenarioProof[] = []
    for (const scenario of names) {
      if (!observed.includes(scenario))
        throw new Error(`${definition.id} did not execute scenario ${scenario}`)
      const expectations = contract.scenarios[scenario]
      if (expectations === undefined)
        throw new Error(`${definition.id} scenario contract disappeared: ${scenario}`)
      const sources = verifyProofList(definition.id, root, expectations, `scenario ${scenario}`)
      proofs.push(Object.freeze({ scenario, source: sources.join("+") }))
    }
    return Object.freeze({ names: Object.freeze(names), proofs: Object.freeze(proofs) })
  }

  const names =
    observed.length === 0 ? Object.freeze(definition.fallbackScenarios.slice()) : observed
  if (names.length === 0) throw new Error(`${definition.id} did not report any scenarios`)
  if (new Set(names).size !== names.length)
    throw new Error(`${definition.id} reported duplicate scenarios`)
  const source =
    observed.length > 0
      ? "details.scenarios"
      : definition.marker !== null
        ? `output:${definition.marker}`
        : definition.outputIncludes !== undefined
          ? `output:${definition.outputIncludes}`
          : ""
  if (source.length === 0) {
    throw new Error(`${definition.id} fallback scenarios are not bound to actual output`)
  }
  return Object.freeze({
    names,
    proofs: Object.freeze(
      names.map(function scenarioProof(scenario) {
        return Object.freeze({ scenario, source: `scenario:${scenario}@${source}` })
      })
    )
  })
}

/** Releases service labels only after service-specific structured or runner-observed proof passes. */
function provenServices(
  definition: SuiteDefinition,
  root: Readonly<Record<string, unknown>>,
  contract: SuiteProofContract | null,
  scenarios: ProvenScenarios
): readonly ServiceProof[] {
  if (definition.releaseBlocking) {
    if (contract === null) throw new Error(`${definition.id} has no release service contract`)
    const declared = [...definition.services].sort()
    const contracted = Object.keys(contract.services).sort()
    if (
      declared.length !== contracted.length ||
      declared.some((service, index) => service !== contracted[index])
    ) {
      throw new Error(
        `${definition.id} service evidence contract does not exactly match its executed services`
      )
    }
    return Object.freeze(
      definition.services.map(function serviceProof(service) {
        const expectations = contract.services[service]
        if (expectations === undefined)
          throw new Error(`${definition.id} omitted service execution proof for ${service}`)
        const sources = verifyProofList(definition.id, root, expectations, `service ${service}`)
        return Object.freeze({ service, source: sources.join("+") })
      })
    )
  }

  const scenarioSources = Array.from(
    new Set(
      scenarios.proofs.map(function source(proof) {
        return proof.source
      })
    )
  ).join(",")
  const expectationSources = definition.expectations
    .map(function source(expectation) {
      return `details.${expectation.path}`
    })
    .join(",")
  const source = [scenarioSources, expectationSources]
    .filter(function present(value) {
      return value.length > 0
    })
    .join("+")
  return Object.freeze(
    definition.services.map(function serviceProof(service) {
      return Object.freeze({ service, source })
    })
  )
}

/** Binds each claimed scenario cleanup to verified cleanup values and owner observations. */
function provenCleanup(
  definition: SuiteDefinition,
  root: Readonly<Record<string, unknown>>,
  contract: SuiteProofContract | null,
  scenarios: ProvenScenarios
): readonly CleanupProof[] {
  if (definition.releaseBlocking) {
    if (contract === null) throw new Error(`${definition.id} has no release cleanup contract`)
    const sources = verifyProofList(definition.id, root, contract.cleanup, "cleanup")
    if (
      !contract.cleanup.some(function structured(expectation) {
        return expectation.path.startsWith("details.cleanup.")
      })
    ) {
      throw new Error(`${definition.id} cleanup contract lacks a structured details.cleanup value`)
    }
    return Object.freeze(
      scenarios.names.map(function cleanupProof(scenario) {
        const scenarioProof = scenarios.proofs.find(function matching(candidate) {
          return candidate.scenario === scenario
        })
        if (scenarioProof === undefined) {
          throw new Error(`${definition.id} cleanup proof lost scenario evidence for ${scenario}`)
        }
        return Object.freeze({
          proof: `scenario:${scenario}`,
          source: `${scenarioProof.source}+${sources.join("+")}`
        })
      })
    )
  }

  const proofs = new Set<string>()
  proofs.add("runner.processTreeClean")
  if (definition.marker !== null) proofs.add("details.valid")
  if (definition.outputIncludes !== undefined) proofs.add(`output:${definition.outputIncludes}`)
  for (const expectation of definition.expectations) proofs.add(`details.${expectation.path}`)
  for (const scenario of scenarios.names) proofs.add(`scenario:${scenario}`)
  if (definition.docker) proofs.add("runner.dockerResourcesRestored")
  const source = Array.from(proofs).sort().join("+")
  return Object.freeze(
    scenarios.names.map(function cleanupProof(scenario) {
      return Object.freeze({ proof: `scenario:${scenario}`, source })
    })
  )
}

/** Returns the immutable declared suite inventory. */
export function suiteDefinitions(): readonly {
  readonly id: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly marker: string | null
  readonly docker: boolean
  readonly releaseBlocking: boolean
}[] {
  return Object.freeze(
    Definitions.map(function publicDefinition(definition) {
      return Object.freeze({
        id: definition.id,
        cwd: definition.cwd,
        command: Object.freeze(definition.command.slice()),
        marker: definition.marker,
        docker: definition.docker,
        releaseBlocking: definition.releaseBlocking
      })
    })
  )
}

export interface SuiteEvaluationInput {
  readonly details: Readonly<Record<string, unknown>>
  readonly runtime: string
  readonly runtimeVersion: string
  readonly runtimeProof: string
  readonly processTreeClean: boolean
  readonly dockerResourcesRestored: boolean
}

/** Normalizes one completed suite only after every release claim has matched independent structured evidence. */
export function evaluateSuiteEvidence(suite: string, input: SuiteEvaluationInput): SuiteEvidence {
  const definition = Definitions.find(function matching(candidate) {
    return candidate.id === suite
  })
  if (definition === undefined) throw new Error(`unknown sourced E2E suite ${suite}`)
  if (input.details["valid"] !== true && input.details["ok"] !== true) {
    throw new Error(`${suite} did not report valid=true`)
  }
  verifyExpectations(definition, input.details)
  const runtime = Object.freeze({
    label: input.runtime,
    version: input.runtimeVersion,
    source: input.runtimeProof
  })
  verifyReportedRuntime(definition, input.details, runtime)
  const runner = Object.freeze({
    processTreeClean: input.processTreeClean,
    dockerResourcesRestored: input.dockerResourcesRestored,
    runtime: input.runtime,
    runtimeVersion: input.runtimeVersion
  })
  const root = Object.freeze({ details: input.details, runner })
  const contract = proofContract(suite)
  const scenarios = provenScenarios(definition, input.details, root, contract)
  const serviceProofs = provenServices(definition, root, contract, scenarios)
  const cleanupProofs = provenCleanup(definition, root, contract, scenarios)
  return Object.freeze({
    suite,
    valid: true,
    scenarios: scenarios.names,
    cleanupValid: cleanupProofs.length > 0,
    runtime: runtime.label,
    runtimeProof: runtime.source,
    services: Object.freeze(definition.services.slice()),
    serviceProofs,
    scenarioProofs: scenarios.proofs,
    cleanupProofs,
    releaseBlocking: definition.releaseBlocking,
    details: input.details
  })
}

/** Executes one real suite and normalizes its machine-readable evidence. */
export async function runSuite(root: string, suite: string): Promise<SuiteEvidence> {
  const definition = Definitions.find(function matching(candidate) {
    return candidate.id === suite
  })
  if (definition === undefined) throw new Error(`unknown sourced E2E suite ${suite}`)
  const deadline = performance.now() + definition.timeoutMs
  const dockerOwner = definition.docker ? newDockerOwner(suite) : null
  let commandFailure: Error | null = null
  let details: Readonly<Record<string, unknown>> | null = null
  let runtime: RuntimeEvidence | null = null
  let dockerResourcesRestored = !definition.docker
  try {
    if (dockerOwner !== null) {
      const inventoryTimeout = availableTimeout(
        deadline,
        DockerCleanupReserveMs,
        DockerInventoryTimeoutMs,
        `${suite} Docker preflight`
      )
      const preflight = await dockerSnapshot(root, dockerOwner, inventoryTimeout)
      if (
        preflight.containers.size > 0 ||
        preflight.networks.size > 0 ||
        preflight.volumes.size > 0
      ) {
        throw new Error(`${suite} Docker owner collision`)
      }
    }
    const commandTimeout = availableTimeout(
      deadline,
      definition.docker ? DockerCleanupReserveMs : ProcessTerminationReserveMs,
      definition.timeoutMs,
      `${suite} command`
    )
    const result = await runCommand(root, {
      cwd: definition.cwd,
      command: definition.command,
      timeoutMs: commandTimeout,
      environment:
        dockerOwner === null ? undefined : Object.freeze({ LIKEGO_E2E_OWNER: dockerOwner })
    })
    const output = `${result.stdout}\n${result.stderr}`
    if (result.timedOut)
      throw new Error(`${suite} command exceeded its ${commandTimeout}ms owner budget`)
    if (result.exitCode !== 0) {
      throw new Error(`${suite} exited ${result.exitCode}: ${output.slice(-12_000)}`)
    }
    if (definition.outputIncludes !== undefined && !output.includes(definition.outputIncludes)) {
      throw new Error(`${suite} did not emit ${definition.outputIncludes}`)
    }
    details =
      definition.marker === null
        ? Object.freeze({ valid: true })
        : markerRecord(output, definition.marker)
    runtime = await runtimeEvidence(root, definition, deadline)
  } catch (error) {
    commandFailure = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (dockerOwner !== null) {
      try {
        await verifyDockerOwnerCleanup(root, dockerOwner, deadline)
        dockerResourcesRestored = true
      } catch (cleanupError) {
        if (commandFailure === null)
          commandFailure =
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
        else
          commandFailure = new AggregateError(
            [commandFailure, cleanupError],
            `${suite} failed and leaked Docker resources`
          )
      }
    }
  }
  if (commandFailure !== null) throw commandFailure
  if (details === null || runtime === null)
    throw new Error(`${suite} completed without captured evidence`)
  return evaluateSuiteEvidence(suite, {
    details,
    runtime: runtime.label,
    runtimeVersion: runtime.version,
    runtimeProof: runtime.source,
    processTreeClean: true,
    dockerResourcesRestored
  })
}
