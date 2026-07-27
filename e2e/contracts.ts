import { transportHTTPService, transportHTTPVersion } from "./package-identities"

export type EvidenceExpectationMode =
  | "equal"
  | "includes"
  | "array-includes"
  | "greater-than"
  | "less-than"
  | "non-empty"

export interface EvidenceExpectation {
  readonly path: string
  readonly value: string | number | boolean
  readonly mode: EvidenceExpectationMode
}

export interface SuiteProofContract {
  readonly scenarios: Readonly<Record<string, readonly EvidenceExpectation[]>>
  readonly services: Readonly<Record<string, readonly EvidenceExpectation[]>>
  readonly cleanup: readonly EvidenceExpectation[]
}

const equal = (path: string, value: string | number | boolean): EvidenceExpectation =>
  Object.freeze({ path, value, mode: "equal" })
const includes = (path: string, value: string): EvidenceExpectation =>
  Object.freeze({ path, value, mode: "includes" })
const arrayIncludes = (path: string, value: string | number | boolean): EvidenceExpectation =>
  Object.freeze({ path, value, mode: "array-includes" })
const greaterThan = (path: string, value: number): EvidenceExpectation =>
  Object.freeze({ path, value, mode: "greater-than" })
const lessThan = (path: string, value: number): EvidenceExpectation =>
  Object.freeze({ path, value, mode: "less-than" })
const nonEmpty = (path: string): EvidenceExpectation =>
  Object.freeze({ path, value: true, mode: "non-empty" })

const WebCleanup = Object.freeze([
  equal("details.cleanup.terminalCompleted", true),
  equal("details.cleanup.portReleased", true),
  equal("runner.processTreeClean", true)
])

const WebHostServices = Object.freeze({
  "@hono/node-server 2.0.11": [equal("details.hostVersion", "2.0.11")],
  "Node HTTP listener": [equal("details.cleanup.portReleased", true)]
})

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
const CollectorImage =
  "otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6"
const MDNSNodeImage =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const MDNSNetshootImage =
  "docker.io/nicolaka/netshoot:v0.16@sha256:b09d9b21381f47a79b3cbcb30da25266dc17186ea00ae65e99fdc51396f48e70"

const Contracts: Readonly<Record<string, SuiteProofContract>> = Object.freeze({
  "kernel-native": {
    scenarios: {
      "context-parent-cancel-cause-propagation": [
        equal(
          "details.scenarioEvidence.context-parent-cancel-cause-propagation.signalAborted",
          true
        ),
        equal(
          "details.scenarioEvidence.context-parent-cancel-cause-propagation.canceledSentinelObserved",
          true
        ),
        equal(
          "details.scenarioEvidence.context-parent-cancel-cause-propagation.causeIdentityStable",
          true
        )
      ],
      "context-deadline-timeout-sentinel": [
        equal("details.scenarioEvidence.context-deadline-timeout-sentinel.deadlineObserved", true),
        equal("details.scenarioEvidence.context-deadline-timeout-sentinel.signalAborted", true),
        equal(
          "details.scenarioEvidence.context-deadline-timeout-sentinel.errorIsDeadlineExceeded",
          true
        ),
        equal(
          "details.scenarioEvidence.context-deadline-timeout-sentinel.causeIsDeadlineExceeded",
          true
        )
      ],
      "context-without-cancel-retains-values": [
        equal("details.scenarioEvidence.context-without-cancel-retains-values.value", "req-42"),
        equal(
          "details.scenarioEvidence.context-without-cancel-retains-values.parentSignalAborted",
          true
        ),
        equal("details.scenarioEvidence.context-without-cancel-retains-values.doneDetached", true),
        equal("details.scenarioEvidence.context-without-cancel-retains-values.errorDetached", true),
        equal(
          "details.scenarioEvidence.context-without-cancel-retains-values.deadlineDetached",
          true
        )
      ],
      "context-after-func-stop-race": [
        equal("details.scenarioEvidence.context-after-func-stop-race.stoppedCallbackCalls", 0),
        equal("details.scenarioEvidence.context-after-func-stop-race.firedCallbackCalls", 1),
        equal(
          "details.scenarioEvidence.context-after-func-stop-race.stoppedBeforeCancellation",
          true
        ),
        equal("details.scenarioEvidence.context-after-func-stop-race.stoppedAfterAdmission", false),
        equal("details.scenarioEvidence.context-after-func-stop-race.firedSignalAborted", true)
      ],
      "core-plain-structural-server-composition": [
        equal(
          "details.scenarioEvidence.core-plain-structural-server-composition.startOrder",
          "start:first,start:second"
        )
      ],
      "core-graceful-stop": [
        equal("details.scenarioEvidence.core-graceful-stop.startOrder", "start:first,start:second"),
        equal("details.scenarioEvidence.core-graceful-stop.stopOrder", "stop:first,stop:second"),
        equal("details.scenarioEvidence.core-graceful-stop.serverDoneTerminals", "first,second"),
        equal("details.scenarioEvidence.core-graceful-stop.appDoneSettled", true)
      ],
      "health-readiness-failure-is-sanitized": [
        equal("details.scenarioEvidence.health-readiness-failure-is-sanitized.liveStatus", 200),
        equal(
          "details.scenarioEvidence.health-readiness-failure-is-sanitized.livePayloadStatusOk",
          true
        ),
        equal("details.scenarioEvidence.health-readiness-failure-is-sanitized.readyStatus", 503),
        equal(
          "details.scenarioEvidence.health-readiness-failure-is-sanitized.publicProbeNamePresent",
          true
        ),
        equal("details.scenarioEvidence.health-readiness-failure-is-sanitized.secretLeaked", false)
      ],
      "health-fetch-routing-head-and-cache-policy": [
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.headStatus",
          503
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.readyStatus",
          503
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.headBodyEmpty",
          true
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.methodStatus",
          405
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.allowHeader",
          "GET, HEAD"
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.missingStatus",
          404
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.liveCacheControl",
          "no-store"
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.readyCacheControl",
          "no-store"
        )
      ]
    },
    services: {
      "LikeGo App lifecycle": [
        equal(
          "details.scenarioEvidence.core-plain-structural-server-composition.startOrder",
          "start:first,start:second"
        ),
        equal("details.scenarioEvidence.core-graceful-stop.appDoneSettled", true)
      ],
      "microtask queue": [
        equal("details.scenarioEvidence.context-after-func-stop-race.firedCallbackCalls", 1),
        equal("details.scenarioEvidence.context-after-func-stop-race.stoppedAfterAdmission", false)
      ],
      "standard AbortSignal": [
        equal(
          "details.scenarioEvidence.context-parent-cancel-cause-propagation.signalAborted",
          true
        ),
        equal("details.scenarioEvidence.context-deadline-timeout-sentinel.signalAborted", true),
        equal(
          "details.scenarioEvidence.context-without-cancel-retains-values.parentSignalAborted",
          true
        ),
        equal("details.scenarioEvidence.context-after-func-stop-race.firedSignalAborted", true)
      ],
      "native timers": [equal("details.cleanup.pendingTimers", 0)],
      "standard Fetch": [
        equal("details.scenarioEvidence.health-readiness-failure-is-sanitized.liveStatus", 200),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.methodStatus",
          405
        )
      ],
      "LikeGo probe registry": [
        equal(
          "details.scenarioEvidence.health-readiness-failure-is-sanitized.publicProbeNamePresent",
          true
        ),
        equal(
          "details.scenarioEvidence.health-fetch-routing-head-and-cache-policy.missingStatus",
          404
        )
      ]
    },
    cleanup: [
      equal("details.cleanup.pendingTimers", 0),
      equal("details.cleanup.appCompleted", true),
      equal("runner.processTreeClean", true)
    ]
  },
  "resilience-native": {
    scenarios: {
      "retry-fresh-request-bounded-backoff": [
        equal("details.scenarioEvidence.retry-fresh-request-bounded-backoff.attempts", 3),
        equal("details.scenarioEvidence.retry-fresh-request-bounded-backoff.requestInstances", 3),
        equal(
          "details.scenarioEvidence.retry-fresh-request-bounded-backoff.requestBodySequence",
          "attempt-1,attempt-2,attempt-3"
        ),
        equal("details.scenarioEvidence.retry-fresh-request-bounded-backoff.delaySequence", "2,3"),
        equal("details.scenarioEvidence.retry-fresh-request-bounded-backoff.status", 201)
      ],
      "circuit-open-half-open-recovery": [
        equal("details.scenarioEvidence.circuit-open-half-open-recovery.openedState", "open"),
        equal("details.scenarioEvidence.circuit-open-half-open-recovery.openedFailures", 2),
        equal(
          "details.scenarioEvidence.circuit-open-half-open-recovery.openedRetryAfterPositive",
          true
        ),
        equal(
          "details.scenarioEvidence.circuit-open-half-open-recovery.openSentinelIdentityStable",
          true
        ),
        equal("details.scenarioEvidence.circuit-open-half-open-recovery.blockedInvocationCount", 2),
        equal(
          "details.scenarioEvidence.circuit-open-half-open-recovery.halfOpenState",
          "half-open"
        ),
        equal(
          "details.scenarioEvidence.circuit-open-half-open-recovery.recoveryResult",
          "recovered"
        ),
        equal("details.scenarioEvidence.circuit-open-half-open-recovery.finalState", "closed"),
        equal("details.scenarioEvidence.circuit-open-half-open-recovery.finalInvocations", 3),
        equal("details.scenarioEvidence.circuit-open-half-open-recovery.finalProbeActive", false)
      ],
      "token-bucket-capacity-refill": [
        equal("details.scenarioEvidence.token-bucket-capacity-refill.initialAllowed", 2),
        equal("details.scenarioEvidence.token-bucket-capacity-refill.excessAllowed", false),
        greaterThan("details.scenarioEvidence.token-bucket-capacity-refill.retryAfterMs", 0),
        equal("details.scenarioEvidence.token-bucket-capacity-refill.emptyAvailableTokens", 0),
        equal("details.scenarioEvidence.token-bucket-capacity-refill.configuredRefillTokens", 1),
        equal("details.scenarioEvidence.token-bucket-capacity-refill.refilledAvailableTokens", 1),
        equal("details.scenarioEvidence.token-bucket-capacity-refill.refillAdmissionAllowed", true),
        equal("details.scenarioEvidence.token-bucket-capacity-refill.consumedExactlyOne", true)
      ]
    },
    services: {
      "native timers": [equal("details.cleanup.pendingTimers", 0)],
      "standard Fetch": [
        equal("details.scenarioEvidence.retry-fresh-request-bounded-backoff.status", 201),
        equal("details.scenarioEvidence.retry-fresh-request-bounded-backoff.requestInstances", 3)
      ],
      "standard monotonic clock": [
        greaterThan("details.scenarioEvidence.token-bucket-capacity-refill.retryAfterMs", 0),
        equal("details.scenarioEvidence.token-bucket-capacity-refill.refilledAvailableTokens", 1)
      ]
    },
    cleanup: [equal("details.cleanup.pendingTimers", 0), equal("runner.processTreeClean", true)]
  },
  "store-file-process": {
    scenarios: {
      "file-store-process-crash-recovery": [
        greaterThan("details.scenarioEvidence.file-store-process-crash-recovery.childExitCode", 0),
        equal("details.scenarioEvidence.file-store-process-crash-recovery.staleLockRejected", true),
        equal("details.scenarioEvidence.file-store-process-crash-recovery.staleTempObserved", true),
        equal(
          "details.scenarioEvidence.file-store-process-crash-recovery.lastSnapshotRecovered",
          true
        ),
        equal("details.scenarioEvidence.file-store-process-crash-recovery.staleTempRemoved", true)
      ],
      "file-store-checksum-fail-closed": [
        equal(
          "details.scenarioEvidence.file-store-checksum-fail-closed.corruptionCode",
          "LIKEGO_FILE_STORE_CORRUPTION"
        ),
        equal(
          "details.scenarioEvidence.file-store-checksum-fail-closed.validSnapshotRestored",
          true
        )
      ]
    },
    services: {
      "Node filesystem": [
        equal("details.scenarioEvidence.file-store-process-crash-recovery.staleTempObserved", true)
      ],
      "LikeGo File Store": [
        equal(
          "details.scenarioEvidence.file-store-process-crash-recovery.lastSnapshotRecovered",
          true
        )
      ]
    },
    cleanup: [
      equal("details.cleanup.directoryRemoved", true),
      equal("details.cleanup.childTerminated", true),
      equal("details.cleanup.lockRemoved", true),
      equal("details.cleanup.tempRemoved", true),
      equal("runner.processTreeClean", true)
    ]
  },
  "vanilla-node": {
    scenarios: {
      "vanilla-fetch-live-listener": [
        equal("details.scenarioEvidence.vanilla-fetch-live-listener.status", 200),
        equal("details.scenarioEvidence.vanilla-fetch-live-listener.method", "GET"),
        equal("details.scenarioEvidence.vanilla-fetch-live-listener.path", "/live")
      ]
    },
    services: {
      ...WebHostServices,
      "standard Fetch": [equal("details.scenarioEvidence.vanilla-fetch-live-listener.status", 200)]
    },
    cleanup: WebCleanup
  },
  "hono-node": {
    scenarios: {
      "hono-fetch-live-listener": [
        equal("details.scenarioEvidence.hono-fetch-live-listener.status", 200),
        equal("details.scenarioEvidence.hono-fetch-live-listener.framework", "hono"),
        equal("details.scenarioEvidence.hono-fetch-live-listener.id", "99")
      ]
    },
    services: {
      "Hono 4.12.32": [equal("details.frameworkVersion", "4.12.32")],
      ...WebHostServices
    },
    cleanup: WebCleanup
  },
  "elysia-node": {
    scenarios: {
      "elysia-fetch-live-listener": [
        equal("details.scenarioEvidence.elysia-fetch-live-listener.status", 200),
        equal("details.scenarioEvidence.elysia-fetch-live-listener.framework", "elysia"),
        equal("details.scenarioEvidence.elysia-fetch-live-listener.id", "99")
      ]
    },
    services: {
      "Elysia 1.4.29": [equal("details.frameworkVersion", "1.4.29")],
      ...WebHostServices
    },
    cleanup: WebCleanup
  },
  "h3-node": {
    scenarios: {
      "h3-fetch-live-listener": [
        equal("details.scenarioEvidence.h3-fetch-live-listener.status", 200),
        equal("details.scenarioEvidence.h3-fetch-live-listener.framework", "h3"),
        equal("details.scenarioEvidence.h3-fetch-live-listener.ok", true)
      ]
    },
    services: {
      "H3 1.15.11": [equal("details.frameworkVersion", "1.15.11")],
      ...WebHostServices
    },
    cleanup: WebCleanup
  },
  "web-node-native": {
    scenarios: {
      "request-response-method-body-headers": [
        equal("details.scenarioEvidence.request-response-method-body-headers.status", 200),
        equal("details.scenarioEvidence.request-response-method-body-headers.method", "POST"),
        equal("details.scenarioEvidence.request-response-method-body-headers.body", "abc"),
        equal("details.scenarioEvidence.request-response-method-body-headers.responseBody", "ok"),
        equal(
          "details.scenarioEvidence.request-response-method-body-headers.responseHeader",
          "POST"
        ),
        equal("details.scenarioEvidence.request-response-method-body-headers.responseCookie", "a=b")
      ],
      "exact-one-argument-fetch-abi": [
        equal("details.scenarioEvidence.exact-one-argument-fetch-abi.argumentCount", 1)
      ],
      "incremental-readable-stream-response": [
        equal("details.scenarioEvidence.incremental-readable-stream-response.firstChunk", "a"),
        equal("details.scenarioEvidence.incremental-readable-stream-response.secondChunk", "b"),
        equal("details.scenarioEvidence.incremental-readable-stream-response.streamTerminal", true),
        equal("details.scenarioEvidence.incremental-readable-stream-response.readerClosed", true),
        equal(
          "details.scenarioEvidence.incremental-readable-stream-response.readerLockReleased",
          true
        ),
        lessThan(
          "details.scenarioEvidence.incremental-readable-stream-response.incrementalLatencyMs",
          45
        )
      ],
      "graceful-drain-refuses-new-connections": [
        equal(
          "details.scenarioEvidence.graceful-drain-refuses-new-connections.runningPendingBeforeHandlerRelease",
          true
        ),
        equal(
          "details.scenarioEvidence.graceful-drain-refuses-new-connections.acceptedRequestDrained",
          true
        ),
        equal(
          "details.scenarioEvidence.graceful-drain-refuses-new-connections.newConnectionRefused",
          true
        ),
        equal(
          "details.scenarioEvidence.graceful-drain-refuses-new-connections.listenerTerminal",
          true
        )
      ],
      "client-abort-cancels-response-body": [
        equal(
          "details.scenarioEvidence.client-abort-cancels-response-body.canceledBeforeStop",
          true
        ),
        equal("details.scenarioEvidence.client-abort-cancels-response-body.cancelCalls", 1),
        equal("details.scenarioEvidence.client-abort-cancels-response-body.listenerTerminal", true)
      ],
      "hard-force-noncooperative-body": [
        equal(
          "details.scenarioEvidence.hard-force-noncooperative-body.errorCode",
          "LIKEGO_NODE_SERVER_FORCE_CLOSE"
        ),
        equal("details.scenarioEvidence.hard-force-noncooperative-body.streamTerminal", true),
        equal("details.scenarioEvidence.hard-force-noncooperative-body.listenerTerminal", true),
        equal("details.scenarioEvidence.hard-force-noncooperative-body.errorIdentityStable", true)
      ]
    },
    services: {
      "@hono/node-server 2.0.11": [equal("details.hostVersion", "2.0.11")],
      "TCP client": [
        equal(
          "details.scenarioEvidence.client-abort-cancels-response-body.canceledBeforeStop",
          true
        )
      ],
      "standard AbortSignal": [
        equal("details.scenarioEvidence.client-abort-cancels-response-body.cancelCalls", 1)
      ],
      "Node HTTP listener": [equal("details.cleanup.portReleased", true)],
      "standard ReadableStream": [equal("details.cleanup.streamTerminal", true)],
      "standard Fetch": [
        equal("details.scenarioEvidence.exact-one-argument-fetch-abi.argumentCount", 1)
      ]
    },
    cleanup: [
      equal("details.cleanup.acceptedServers", 3),
      equal("details.cleanup.terminalServers", 3),
      equal("details.cleanup.lateRejections", 0),
      equal("details.cleanup.portReleased", true),
      equal("details.cleanup.forcePortReleased", true),
      equal("details.cleanup.streamTerminal", true),
      equal("details.cleanup.listenerTerminal", true),
      equal("details.cleanup.pendingTimers", 0),
      equal("details.cleanup.unhandledListenerDelta", 0),
      equal("runner.processTreeClean", true)
    ]
  },
  "transport-http-node": {
    scenarios: {
      "unary-loopback": [
        equal("details.scenarioEvidence.unary-loopback.status", 200),
        equal("details.scenarioEvidence.unary-loopback.acceptedBeforeRequest", true),
        equal("details.scenarioEvidence.unary-loopback.requestBody", "unary-request"),
        equal("details.scenarioEvidence.unary-loopback.responseBody", "unary-response"),
        equal("details.scenarioEvidence.unary-loopback.requestHeader", "loopback"),
        equal("details.scenarioEvidence.unary-loopback.responseHeader", "node"),
        equal("details.scenarioEvidence.unary-loopback.requestBytes", 13),
        equal("details.scenarioEvidence.unary-loopback.responseBytes", 14),
        nonEmpty("details.scenarioEvidence.unary-loopback.actualAddress"),
        greaterThan("details.scenarioEvidence.unary-loopback.actualPort", 0),
        equal("details.scenarioEvidence.unary-loopback.terminal", true),
        equal("details.scenarioEvidence.unary-loopback.portReleased", true)
      ],
      "graceful-drain": [
        equal("details.scenarioEvidence.graceful-drain.stopPendingBeforeRelease", true),
        equal("details.scenarioEvidence.graceful-drain.requestDrained", true),
        equal("details.scenarioEvidence.graceful-drain.callerCancellationScoped", true),
        equal("details.scenarioEvidence.graceful-drain.secondStopJoined", true),
        equal("details.scenarioEvidence.graceful-drain.newConnectionRefused", true),
        equal("details.scenarioEvidence.graceful-drain.responseBody", "drained:accepted"),
        equal("details.scenarioEvidence.graceful-drain.terminal", true),
        equal("details.scenarioEvidence.graceful-drain.portReleased", true)
      ],
      "hard-force-cleanup": [
        equal("details.scenarioEvidence.hard-force-cleanup.closePendingBeforeForce", true),
        equal("details.scenarioEvidence.hard-force-cleanup.closeBeforeForce", true),
        equal("details.scenarioEvidence.hard-force-cleanup.clientStreamTerminal", true),
        equal("details.scenarioEvidence.hard-force-cleanup.hostTerminal", true),
        equal("details.scenarioEvidence.hard-force-cleanup.listenerTerminal", true),
        equal("details.scenarioEvidence.hard-force-cleanup.activeHandlers", 0),
        equal("details.scenarioEvidence.hard-force-cleanup.forcePortReleased", true)
      ],
      "passive-host-failure": [
        equal("details.scenarioEvidence.passive-host-failure.originalErrorIdentity", true),
        equal("details.scenarioEvidence.passive-host-failure.stableDoneRejection", true),
        equal("details.scenarioEvidence.passive-host-failure.serveErrorIdentity", true),
        equal("details.scenarioEvidence.passive-host-failure.listenerTerminal", true),
        equal("details.scenarioEvidence.passive-host-failure.activeHandlers", 0),
        equal("details.scenarioEvidence.passive-host-failure.activeSockets", 0),
        equal("details.scenarioEvidence.passive-host-failure.portReleased", true)
      ]
    },
    services: {
      [transportHTTPService]: [
        equal("details.package", "@likego/transport-http/node"),
        equal("details.version", transportHTTPVersion)
      ],
      "Node HTTP 26.5.0": [
        equal("details.runtimeVersion", "26.5.0"),
        equal("details.connectionMetadata.ipv4.envelopeMatchesSocket", true),
        equal("details.connectionMetadata.ipv4.differsFromWildcardBind", true),
        equal("details.connectionMetadata.ipv4.status", 200),
        equal("details.connectionMetadata.ipv4.portReleased", true),
        equal("details.connectionMetadata.ipv6.envelopeMatchesSocket", true),
        equal("details.connectionMetadata.ipv6.differsFromWildcardBind", true),
        equal("details.connectionMetadata.ipv6.status", 200),
        equal("details.connectionMetadata.ipv6.portReleased", true),
        equal("details.cleanup.portReleased", true)
      ],
      "standard Fetch on Node.js 26.5.0": [
        equal("details.runtimeVersion", "26.5.0"),
        equal("details.scenarioEvidence.unary-loopback.responseBody", "unary-response")
      ]
    },
    cleanup: [
      equal("details.cleanup.acceptedServers", 6),
      equal("details.cleanup.terminalServers", 6),
      equal("details.cleanup.portReleased", true),
      equal("details.cleanup.pendingTimers", 0),
      equal("details.cleanup.unhandledRejections", 0),
      equal("details.cleanup.unhandledListenerDelta", 0),
      equal("runner.processTreeClean", true)
    ]
  },
  "cron-native": {
    scenarios: {
      "native-factory-resume-and-exhaustion-unobservable": [
        equal(
          "details.scenarioEvidence.native-factory-resume-and-exhaustion-unobservable.contextIdentityStable",
          true
        ),
        equal(
          "details.scenarioEvidence.native-factory-resume-and-exhaustion-unobservable.tickCalls",
          2
        ),
        equal(
          "details.scenarioEvidence.native-factory-resume-and-exhaustion-unobservable.observedNativeFailures",
          1
        ),
        equal(
          "details.scenarioEvidence.native-factory-resume-and-exhaustion-unobservable.schedulingExhausted",
          true
        ),
        equal(
          "details.scenarioEvidence.native-factory-resume-and-exhaustion-unobservable.passiveDonePending",
          true
        )
      ],
      "explicit-stop-does-not-fabricate-native-callback-drain": [
        equal(
          "details.scenarioEvidence.explicit-stop-does-not-fabricate-native-callback-drain.busyBeforeStop",
          true
        ),
        equal(
          "details.scenarioEvidence.explicit-stop-does-not-fabricate-native-callback-drain.stopAndDoneSettledBeforeRelease",
          true
        ),
        equal(
          "details.scenarioEvidence.explicit-stop-does-not-fabricate-native-callback-drain.busyAfterStop",
          true
        ),
        equal(
          "details.scenarioEvidence.explicit-stop-does-not-fabricate-native-callback-drain.contextCanceled",
          true
        ),
        equal(
          "details.scenarioEvidence.explicit-stop-does-not-fabricate-native-callback-drain.callbackSettledAfterRelease",
          true
        )
      ]
    },
    services: {
      "Croner 10.0.1": [equal("details.cronerVersion", "10.0.1")],
      "LikeGo Context": [
        equal(
          "details.scenarioEvidence.explicit-stop-does-not-fabricate-native-callback-drain.contextCanceled",
          true
        )
      ],
      "native timers": [equal("details.cleanup.pendingTimers", 0)]
    },
    cleanup: [
      equal("details.cleanup.acceptedServers", 2),
      equal("details.cleanup.stopAttempts", 2),
      equal("details.cleanup.terminalServers", 2),
      equal("details.cleanup.unhandledRejections", 0),
      equal("details.cleanup.pendingTimers", 0),
      equal("runner.processTreeClean", true)
    ]
  },
  "bullmq-docker": {
    scenarios: {
      "retry-attempts-fixed-backoff-and-borrowed-queue": [
        equal(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.processorAttempts",
          3
        ),
        equal(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.nativeAttemptsMade",
          3
        ),
        greaterThan(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.fixedBackoffElapsedMs",
          179
        ),
        greaterThan(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.firstFixedBackoffElapsedMs",
          89
        ),
        greaterThan(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.secondFixedBackoffElapsedMs",
          89
        ),
        equal(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.connectionsBeforeWorkerStart",
          1
        ),
        equal(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.connectionsAfterWorkerStop",
          1
        ),
        equal(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.privateConnectionsReturnedToBaseline",
          true
        ),
        equal(
          "details.scenarioEvidence.retry-attempts-fixed-backoff-and-borrowed-queue.applicationQueueUsableAfterWorkerStop",
          true
        )
      ],
      "redis-stop-start-recovery-with-observational-errors": [
        greaterThan(
          "details.scenarioEvidence.redis-stop-start-recovery-with-observational-errors.outageErrorsObservedWhileStopped",
          0
        ),
        equal(
          "details.scenarioEvidence.redis-stop-start-recovery-with-observational-errors.recoveredJobProcessed",
          true
        ),
        equal(
          "details.scenarioEvidence.redis-stop-start-recovery-with-observational-errors.outageDidNotPublishTerminal",
          true
        ),
        equal(
          "details.scenarioEvidence.redis-stop-start-recovery-with-observational-errors.privateConnectionsReturnedToBaseline",
          true
        )
      ],
      "independent-raw-worker-crash-and-stalled-recovery": [
        equal(
          "details.scenarioEvidence.independent-raw-worker-crash-and-stalled-recovery.rawWorkerLockedJobId",
          "real-stalled-lock"
        ),
        equal(
          "details.scenarioEvidence.independent-raw-worker-crash-and-stalled-recovery.rawWorkerExitCode",
          17
        ),
        equal(
          "details.scenarioEvidence.independent-raw-worker-crash-and-stalled-recovery.recoveredJobId",
          "real-stalled-lock"
        ),
        greaterThan(
          "details.scenarioEvidence.independent-raw-worker-crash-and-stalled-recovery.attemptsStarted",
          1
        ),
        greaterThan(
          "details.scenarioEvidence.independent-raw-worker-crash-and-stalled-recovery.stalledCounter",
          0
        ),
        equal(
          "details.scenarioEvidence.independent-raw-worker-crash-and-stalled-recovery.privateConnectionsReturnedToBaseline",
          true
        )
      ],
      "noncooperative-provider-timeout-until-handler-terminal": [
        equal(
          "details.scenarioEvidence.noncooperative-provider-timeout-until-handler-terminal.contextCanceled",
          true
        ),
        nonEmpty(
          "details.scenarioEvidence.noncooperative-provider-timeout-until-handler-terminal.cancellationCauseName"
        ),
        equal(
          "details.scenarioEvidence.noncooperative-provider-timeout-until-handler-terminal.runtimePendingBeforeHandlerRelease",
          true
        ),
        equal(
          "details.scenarioEvidence.noncooperative-provider-timeout-until-handler-terminal.nativeTerminalObservedAfterRelease",
          true
        ),
        equal(
          "details.scenarioEvidence.noncooperative-provider-timeout-until-handler-terminal.errorIdentityStable",
          true
        ),
        equal(
          "details.scenarioEvidence.noncooperative-provider-timeout-until-handler-terminal.privateConnectionsReturnedToBaseline",
          true
        )
      ],
      "application-closes-queue-last-and-zero-connections": [
        equal(
          "details.scenarioEvidence.application-closes-queue-last-and-zero-connections.applicationQueueUsableBeforeClose",
          true
        ),
        equal(
          "details.scenarioEvidence.application-closes-queue-last-and-zero-connections.privateConnectionsBeforeQueueClose",
          1
        ),
        equal(
          "details.scenarioEvidence.application-closes-queue-last-and-zero-connections.persistentConnectionsAfterQueueClose",
          0
        ),
        equal("details.queueOwnedBy", "application")
      ]
    },
    services: {
      "BullMQ 5.81.2": [equal("details.bullmqVersion", "5.81.2")],
      "Redis 8.8.1": [includes("details.redisVersion", "v=8.8.1")],
      "Redis 8.8.1 Docker": [includes("details.redisVersion", "v=8.8.1")]
    },
    cleanup: [
      equal("details.cleanup.lateRejections", 0),
      equal("details.cleanup.remainingContainers", 0),
      equal("details.cleanup.persistentConnections", 0),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "nats-core-docker": {
    scenarios: {
      "startup-cancel-unconsumed-subscription-cleanup": [
        equal(
          "details.scenarioEvidence.startup-cancel-unconsumed-subscription-cleanup.exactCause",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-unconsumed-subscription-cleanup.handlerCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-unconsumed-subscription-cleanup.deliveryDelta",
          0
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-unconsumed-subscription-cleanup.borrowedConnectionOpen",
          true
        )
      ],
      "startup-cancel-direct-subscription-preserved": [
        equal(
          "details.scenarioEvidence.startup-cancel-direct-subscription-preserved.exactCause",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-subscription-preserved.openAfterRejectedStart",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-subscription-preserved.applicationDeliveries",
          1
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-subscription-preserved.applicationCleanupTerminal",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-subscription-preserved.borrowedConnectionOpen",
          true
        )
      ],
      "raw-pub-sub": [
        equal("details.scenarioEvidence.raw-pub-sub.delivered", 1),
        equal("details.scenarioEvidence.raw-pub-sub.bodyMatch", true),
        nonEmpty("details.scenarioEvidence.raw-pub-sub.subject"),
        equal("details.scenarioEvidence.raw-pub-sub.subjectMatches", true),
        equal("details.scenarioEvidence.raw-pub-sub.nativeSubscriptionTerminal", true),
        equal("details.scenarioEvidence.raw-pub-sub.borrowedConnectionOpen", true)
      ],
      "queue-group-distribution": [
        equal("details.scenarioEvidence.queue-group-distribution.published", 20),
        equal("details.scenarioEvidence.queue-group-distribution.totalDelivered", 20),
        equal("details.scenarioEvidence.queue-group-distribution.uniqueDelivered", 20),
        greaterThan("details.scenarioEvidence.queue-group-distribution.firstWorker", 0),
        greaterThan("details.scenarioEvidence.queue-group-distribution.secondWorker", 0),
        equal(
          "details.scenarioEvidence.queue-group-distribution.nativeSubscriptionsTerminal",
          true
        ),
        equal("details.scenarioEvidence.queue-group-distribution.borrowedConnectionOpen", true)
      ],
      "at-most-once-handler-failure-isolation": [
        equal(
          "details.scenarioEvidence.at-most-once-handler-failure-isolation.observedFailures",
          1
        ),
        equal("details.scenarioEvidence.at-most-once-handler-failure-isolation.redeliveries", 0),
        equal(
          "details.scenarioEvidence.at-most-once-handler-failure-isolation.postFailureDeliveries",
          1
        ),
        equal(
          "details.scenarioEvidence.at-most-once-handler-failure-isolation.postFailureBody",
          "good"
        ),
        equal(
          "details.scenarioEvidence.at-most-once-handler-failure-isolation.nativeSubscriptionTerminal",
          true
        ),
        equal(
          "details.scenarioEvidence.at-most-once-handler-failure-isolation.borrowedConnectionOpen",
          true
        )
      ],
      "transient-outage-reconnect": [
        equal("details.scenarioEvidence.transient-outage-reconnect.disconnectObserved", true),
        equal("details.scenarioEvidence.transient-outage-reconnect.reconnectObserved", true),
        equal("details.scenarioEvidence.transient-outage-reconnect.postRestartDeliveries", 1),
        equal(
          "details.scenarioEvidence.transient-outage-reconnect.postRestartBody",
          "after-reconnect"
        ),
        equal(
          "details.scenarioEvidence.transient-outage-reconnect.postRestartSubjectMatches",
          true
        ),
        equal(
          "details.scenarioEvidence.transient-outage-reconnect.nativeSubscriptionTerminal",
          true
        ),
        equal("details.scenarioEvidence.transient-outage-reconnect.borrowedConnectionOpen", true)
      ]
    },
    services: {
      "NATS Server 2.14.3 Docker": [includes("details.serverVersion", "2.14.3")],
      "NATS JavaScript 3.4.0": [equal("details.sdkVersion", "3.4.0")]
    },
    cleanup: [
      equal("details.cleanup.lateRejections", 0),
      equal("details.cleanup.remainingContainers", 0),
      equal("details.cleanup.activeHandlers", 0),
      equal("details.cleanup.borrowedConnectionOpenAfterForce", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "nats-jetstream-docker": {
    scenarios: {
      "startup-cancel-official-unconsumed-iterator-rollback": [
        equal(
          "details.scenarioEvidence.startup-cancel-official-unconsumed-iterator-rollback.exactCause",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-official-unconsumed-iterator-rollback.closedPendingBeforeConsumption",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-official-unconsumed-iterator-rollback.closedAfterIteratorConsumption",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-official-unconsumed-iterator-rollback.durableConsumerPreserved",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-official-unconsumed-iterator-rollback.borrowedConnectionOpen",
          true
        )
      ],
      "startup-cancel-direct-consumer-messages-preserved": [
        equal(
          "details.scenarioEvidence.startup-cancel-direct-consumer-messages-preserved.exactCause",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-consumer-messages-preserved.closedPendingAfterRejectedStart",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-consumer-messages-preserved.applicationDeliveries",
          1
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-consumer-messages-preserved.ackConfirmed",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-consumer-messages-preserved.closedAfterApplicationCleanup",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-consumer-messages-preserved.durableConsumerPreserved",
          true
        ),
        equal(
          "details.scenarioEvidence.startup-cancel-direct-consumer-messages-preserved.borrowedConnectionOpen",
          true
        )
      ],
      "durable-explicit-raw-jsmsg-ackack": [
        equal("details.scenarioEvidence.durable-explicit-raw-jsmsg-ackack.subjectMatches", true),
        equal("details.scenarioEvidence.durable-explicit-raw-jsmsg-ackack.bodyMatch", true),
        equal("details.scenarioEvidence.durable-explicit-raw-jsmsg-ackack.ackConfirmed", true),
        equal("details.scenarioEvidence.durable-explicit-raw-jsmsg-ackack.ackPendingAfterAck", 0),
        equal(
          "details.scenarioEvidence.durable-explicit-raw-jsmsg-ackack.durableConsumerPreserved",
          true
        ),
        equal(
          "details.scenarioEvidence.durable-explicit-raw-jsmsg-ackack.nativeIteratorTerminal",
          true
        ),
        equal(
          "details.scenarioEvidence.durable-explicit-raw-jsmsg-ackack.borrowedConnectionOpen",
          true
        )
      ],
      "explicit-ack-max-deliver": [
        arrayIncludes("details.scenarioEvidence.explicit-ack-max-deliver.deliveryCounts", 1),
        arrayIncludes("details.scenarioEvidence.explicit-ack-max-deliver.deliveryCounts", 2),
        equal("details.scenarioEvidence.explicit-ack-max-deliver.maxDeliver", 2),
        equal("details.scenarioEvidence.explicit-ack-max-deliver.totalDeliveries", 2),
        equal("details.scenarioEvidence.explicit-ack-max-deliver.nativeIteratorTerminal", true),
        equal("details.scenarioEvidence.explicit-ack-max-deliver.borrowedConnectionOpen", true)
      ],
      "dlq-real-publish-failure-redelivery-puback-term-exactly-once": [
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.publishFailureAtThreshold",
          true
        ),
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.sourceAckPending",
          0
        ),
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.deadLetterMessages",
          1
        ),
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.deadLetterBodyMatch",
          true
        ),
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.deadLetterAckConfirmed",
          true
        ),
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.nativeIteratorTerminal",
          true
        ),
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.durableConsumerPreserved",
          true
        ),
        equal(
          "details.scenarioEvidence.dlq-real-publish-failure-redelivery-puback-term-exactly-once.borrowedConnectionOpen",
          true
        )
      ],
      "transient-outage-reconnect": [
        equal("details.scenarioEvidence.transient-outage-reconnect.disconnectObserved", true),
        equal("details.scenarioEvidence.transient-outage-reconnect.reconnectObserved", true),
        equal("details.scenarioEvidence.transient-outage-reconnect.postRestartDeliveries", 1),
        equal("details.scenarioEvidence.transient-outage-reconnect.postRestartAckConfirmed", true),
        equal("details.scenarioEvidence.transient-outage-reconnect.durableConsumerRestored", true),
        equal("details.scenarioEvidence.transient-outage-reconnect.nativeIteratorTerminal", true),
        equal("details.scenarioEvidence.transient-outage-reconnect.borrowedConnectionOpen", true)
      ]
    },
    services: {
      "NATS Server 2.14.3 with JetStream": [includes("details.serverVersion", "2.14.3")],
      "NATS JavaScript 3.4.0": [equal("details.sdkVersion", "3.4.0")]
    },
    cleanup: [
      equal("details.cleanup.lateRejections", 0),
      equal("details.cleanup.remainingContainers", 0),
      equal("details.cleanup.activeHandlers", 0),
      equal("details.cleanup.borrowedConnectionOpenAfterForce", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "config-consul-docker": {
    scenarios: {
      "consul-kv-initial-load": [
        equal("details.scenarioEvidence.consul-kv-initial-load.release", 1),
        equal("details.scenarioEvidence.consul-kv-initial-load.revisionObserved", true)
      ],
      "outage-preserves-last-good": [
        equal("details.scenarioEvidence.outage-preserves-last-good.valueIdentityPreserved", true),
        equal("details.scenarioEvidence.outage-preserves-last-good.release", 1),
        equal("details.scenarioEvidence.outage-preserves-last-good.featureEnabled", false),
        greaterThan("details.scenarioEvidence.outage-preserves-last-good.outageFailureCount", 0)
      ],
      "restart-reconciles-new-index": [
        equal("details.scenarioEvidence.restart-reconciles-new-index.release", 2),
        equal(
          "details.scenarioEvidence.restart-reconciles-new-index.replacementValuePublished",
          true
        ),
        equal(
          "details.scenarioEvidence.restart-reconciles-new-index.indexRegressionObserved",
          true
        ),
        equal("details.scenarioEvidence.restart-reconciles-new-index.revisionAdvanced", true)
      ],
      "blocking-query-publishes-change": [
        equal("details.scenarioEvidence.blocking-query-publishes-change.release", 3),
        equal(
          "details.scenarioEvidence.blocking-query-publishes-change.blockingRevisionAdvanced",
          true
        ),
        equal("details.scenarioEvidence.blocking-query-publishes-change.nestedValuePreserved", true)
      ]
    },
    services: {
      "Consul 2.0.2 Docker": [
        equal("details.image", ConsulImage),
        includes("details.consulVersion", "2.0.2")
      ],
      "standard Fetch": [greaterThan("details.fetchAttempts", 0)]
    },
    cleanup: [
      equal("details.cleanup.remainingContainers", 0),
      equal("details.cleanup.pendingTimers", 0),
      equal("details.cleanup.activeFetches", 0),
      equal("details.cleanup.activeBlockingFetches", 0),
      equal("details.cleanup.watcherTerminal", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "config-etcd-docker": {
    scenarios: {
      "config-etcd-load-watch-delete-compaction": [
        equal(
          "details.scenarioEvidence.config-etcd-load-watch-delete-compaction.initialLoaded",
          true
        ),
        equal(
          "details.scenarioEvidence.config-etcd-load-watch-delete-compaction.updateObserved",
          true
        ),
        equal(
          "details.scenarioEvidence.config-etcd-load-watch-delete-compaction.deleteObserved",
          true
        ),
        equal(
          "details.scenarioEvidence.config-etcd-load-watch-delete-compaction.compactionRelisted",
          true
        )
      ]
    },
    services: {
      "etcd 3.7.1 Docker JSON gateway": [
        equal("details.image", EtcdImage),
        equal("details.etcdVersion", "3.7.1")
      ],
      "standard Fetch": [equal("details.resourcesClean", true)]
    },
    cleanup: [
      equal("details.cleanup.remoteKeys", 0),
      equal("details.cleanup.watchersStopped", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "store-consul-docker": {
    scenarios: {
      "consul-store-root-isolation": [
        equal("details.scenarioEvidence.consul-store-root-isolation.externalKvIgnored", true),
        equal("details.scenarioEvidence.consul-store-root-isolation.differentRootsIsolated", true),
        equal("details.scenarioEvidence.consul-store-root-isolation.crossRootCursorRejected", true),
        equal(
          "details.scenarioEvidence.consul-store-root-isolation.corruptOwnedDataFailedClosed",
          true
        )
      ],
      "consul-store-crud-cas-pagination-ttl": [
        equal("details.scenarioEvidence.consul-store-crud-cas-pagination-ttl.crudRoundTrip", true),
        equal("details.scenarioEvidence.consul-store-crud-cas-pagination-ttl.staleConflict", true),
        equal(
          "details.scenarioEvidence.consul-store-crud-cas-pagination-ttl.staleCursorRejected",
          true
        ),
        nonEmpty("details.scenarioEvidence.consul-store-crud-cas-pagination-ttl.prefixOrder"),
        equal(
          "details.scenarioEvidence.consul-store-crud-cas-pagination-ttl.logicallyExpired",
          true
        ),
        equal(
          "details.scenarioEvidence.consul-store-crud-cas-pagination-ttl.restartPreserved",
          true
        )
      ],
      "consul-store-acl-redaction": [
        equal("details.scenarioEvidence.consul-store-acl-redaction.deniedStatus", 403),
        equal("details.scenarioEvidence.consul-store-acl-redaction.authorizedRead", true),
        equal("details.scenarioEvidence.consul-store-acl-redaction.ttlDeleted", true),
        equal("details.scenarioEvidence.consul-store-acl-redaction.tokenOnlyInHeader", true)
      ]
    },
    services: {
      "Consul 2.0.2 Docker": [
        equal("details.image", ConsulImage),
        includes("details.binaryVersion", "Consul v2.0.2")
      ],
      "Consul 2.0.2 Docker with ACLs": [
        equal("details.scenarioEvidence.consul-store-acl-redaction.deniedStatus", 403)
      ],
      "standard Fetch": [
        equal("details.scenarioEvidence.consul-store-acl-redaction.tokenOnlyInHeader", true)
      ]
    },
    cleanup: [
      equal("details.cleanup.remoteKv", 0),
      equal("details.cleanup.remoteSessions", 0),
      equal("details.cleanup.containers", 0),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "store-etcd-docker": {
    scenarios: {
      "etcd-store-crud-cas-pagination": [
        equal("details.scenarioEvidence.etcd-store-crud-cas-pagination.crud", true),
        equal("details.scenarioEvidence.etcd-store-crud-cas-pagination.casConflict", true),
        equal("details.scenarioEvidence.etcd-store-crud-cas-pagination.stablePagination", true)
      ],
      "etcd-store-lease-restart": [
        equal("details.scenarioEvidence.etcd-store-lease-restart.leaseExpired", true),
        equal("details.scenarioEvidence.etcd-store-lease-restart.leaseRevoked", true),
        equal("details.scenarioEvidence.etcd-store-lease-restart.restartPreserved", true)
      ]
    },
    services: {
      "etcd 3.7.1 Docker JSON gateway": [
        equal("details.image", EtcdImage),
        equal("details.etcd", "3.7.1")
      ],
      "standard Fetch": [
        equal("details.scenarioEvidence.etcd-store-crud-cas-pagination.crud", true)
      ]
    },
    cleanup: [
      equal("details.cleanup.remoteKeys", 0),
      equal("details.cleanup.remoteLeases", 0),
      equal("details.cleanup.containerRemoved", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "registry-etcd-docker": {
    scenarios: {
      "service-instance-register-get-watch-update-deregister": [
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.registerGet",
          true
        ),
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.watchUpdate",
          true
        ),
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.watchDeregisterEmpty",
          true
        )
      ],
      "lost-transaction-response-exact-readback": [
        equal(
          "details.scenarioEvidence.lost-transaction-response-exact-readback.exactReadback",
          true
        )
      ],
      "sigkill-publisher-lease-expiry": [
        equal("details.scenarioEvidence.sigkill-publisher-lease-expiry.expired", true)
      ]
    },
    services: {
      "etcd 3.7.1 Docker JSON gateway": [equal("details.image", EtcdImage)],
      "standard Fetch": [
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.registerGet",
          true
        )
      ]
    },
    cleanup: [
      equal("details.cleanup.remoteInstances", 0),
      equal("details.cleanup.watcherStopped", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "registry-kubernetes-docker": {
    scenarios: {
      "kubernetes-endpointslice-service-lifecycle": [
        equal("details.api", "discovery.k8s.io/v1 EndpointSlice"),
        equal("details.contract", "ServiceInstance register/deregister replacement watcher"),
        equal("details.podOwnerGarbageCollected", true)
      ],
      "kubernetes-resourceversion-cas": [equal("details.resourceVersionCas", true)],
      "kubernetes-namespace-foreign-isolation": [equal("details.foreignIsolation", true)],
      "kubernetes-watch-410-recovery": [equal("details.staleWatchRecovery", true)]
    },
    services: {
      "K3s 1.36.2 Docker": [equal("details.image", K3sImage)],
      "Kubernetes EndpointSlice API": [equal("details.api", "discovery.k8s.io/v1 EndpointSlice")],
      "standard Fetch": [equal("details.foreignIsolation", true)]
    },
    cleanup: [
      equal("details.cleanup.managedEndpointSlices", 0),
      equal("details.cleanup.namespaces", 0),
      equal("details.cleanup.containerRemoved", true),
      equal("details.cleanup.volumesRemoved", 4),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "registry-zookeeper-docker": {
    scenarios: {
      "service-instance-register-get-watch-update-deregister": [
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.registerGet",
          true
        ),
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.watchRegisterUpdateDeregister",
          true
        ),
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.deregisterReadbackEmpty",
          true
        )
      ],
      "sigkill-publisher-ephemeral-expiry": [
        equal("details.scenarioEvidence.sigkill-publisher-ephemeral-expiry.publisherReady", true),
        equal("details.scenarioEvidence.sigkill-publisher-ephemeral-expiry.signal", "SIGKILL"),
        equal(
          "details.scenarioEvidence.sigkill-publisher-ephemeral-expiry.ephemeralRecordExpired",
          true
        )
      ]
    },
    services: {
      "ZooKeeper 3.9.5 Docker": [equal("details.image", ZookeeperImage)],
      "node-zookeeper-client 1.1.3": [
        equal(
          "details.scenarioEvidence.service-instance-register-get-watch-update-deregister.watchRegisterUpdateDeregister",
          true
        )
      ]
    },
    cleanup: [
      equal("details.cleanup.remoteZnodes", 0),
      equal("details.cleanup.externalSessions", 0),
      equal("details.cleanup.containerRemaining", 0),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "registry-consul-docker": {
    scenarios: {
      "service-instance-roundtrip": [
        equal("details.scenarioEvidence.service-instance-roundtrip.registerReturnedVoid", true),
        equal("details.scenarioEvidence.service-instance-roundtrip.discoveredExact", true),
        equal("details.scenarioEvidence.service-instance-roundtrip.deterministicRemoteId", true),
        equal("details.scenarioEvidence.service-instance-roundtrip.deregisterReturnedVoid", true)
      ],
      "replacement-snapshot-watch": [
        equal("details.scenarioEvidence.replacement-snapshot-watch.initialSnapshot", 1),
        equal("details.scenarioEvidence.replacement-snapshot-watch.updatedSnapshot", 1),
        equal("details.scenarioEvidence.replacement-snapshot-watch.emptySnapshot", 0),
        equal("details.scenarioEvidence.replacement-snapshot-watch.watcherSurfaceExact", true)
      ],
      "private-ttl-heartbeat": [
        greaterThan("details.scenarioEvidence.private-ttl-heartbeat.heartbeatPasses", 1),
        equal("details.scenarioEvidence.private-ttl-heartbeat.publicHandleExposed", false)
      ]
    },
    services: {
      "Consul 2.0.2 Docker": [equal("details.image", ConsulImage)],
      "standard Fetch": [
        equal("details.scenarioEvidence.service-instance-roundtrip.discoveredExact", true)
      ],
      "TTL health check": [
        greaterThan("details.scenarioEvidence.private-ttl-heartbeat.heartbeatPasses", 1)
      ]
    },
    cleanup: [
      equal("details.cleanup.watcherTerminal", true),
      equal("details.cleanup.registrationRemoved", true),
      equal("details.cleanup.residualContainers", 0),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "registry-transport-consul-docker": {
    scenarios: {
      "consul-discovery-http-call-lifecycle": [
        equal("details.scenarioEvidence.bindBeforeRegister", true),
        equal("details.scenarioEvidence.deregisterBeforeStop", true),
        equal(
          "details.scenarioEvidence.lifecycleOrder",
          "start:a,bind:a,register:a,start:b,bind:b,register:b,deregister:a,stop:a,deregister:b,stop:b"
        ),
        equal("details.scenarioEvidence.dynamicAddressesReady", true),
        equal("details.scenarioEvidence.boundEndpointsMatchRegistry", true),
        equal("details.scenarioEvidence.rawRegistrations", 2),
        equal("details.scenarioEvidence.discoveredNodes", "a,b"),
        equal("details.scenarioEvidence.watcherInitialNodes", "a,b"),
        equal("details.scenarioEvidence.roundRobinSequence", "a,b,a,b"),
        equal("details.scenarioEvidence.selectedNodes", "a,b,a,b"),
        equal("details.scenarioEvidence.registrationsAfterFirstDeregister", 1),
        equal("details.scenarioEvidence.watcherAfterDeregister", "b"),
        equal("details.scenarioEvidence.postDeregisterNode", "b"),
        equal("details.scenarioEvidence.registrationsAfterSecondDeregister", 0),
        equal("details.scenarioEvidence.registryOperationsReturnedVoid", true),
        equal("details.scenarioEvidence.selectionFeedbackExactlyOnce", true),
        equal("details.scenarioEvidence.selectionFeedbackCalls", 5),
        equal("details.scenarioEvidence.feedbackOutcomesHealthy", true),
        equal("details.scenarioEvidence.transportClientsClosedExactlyOnce", true),
        equal("details.scenarioEvidence.transportBinds", 2),
        equal("details.scenarioEvidence.transportClientDials", 2),
        equal("details.scenarioEvidence.transportClientCloseCalls", 2),
        equal("details.scenarioEvidence.unaryCallsA", 2),
        equal("details.scenarioEvidence.unaryCallsB", 3)
      ]
    },
    services: {
      "Consul 2.0.2 Docker": [
        equal("details.image", ConsulImage),
        includes("details.consulVersion", "2.0.2"),
        equal("details.scenarioEvidence.rawRegistrations", 2),
        equal("details.scenarioEvidence.discoveredNodes", "a,b"),
        equal("details.scenarioEvidence.watcherAfterDeregister", "b"),
        equal("details.scenarioEvidence.registrationsAfterSecondDeregister", 0)
      ],
      "LikeGo HTTP Transport": [
        equal("details.scenarioEvidence.roundRobinSequence", "a,b,a,b"),
        equal("details.scenarioEvidence.transportBinds", 2),
        equal("details.scenarioEvidence.transportClientDials", 2),
        equal("details.scenarioEvidence.transportClientsClosedExactlyOnce", true)
      ],
      "LikeGo Server": [
        equal("details.scenarioEvidence.bindBeforeRegister", true),
        equal("details.scenarioEvidence.deregisterBeforeStop", true),
        equal(
          "details.scenarioEvidence.lifecycleOrder",
          "start:a,bind:a,register:a,start:b,bind:b,register:b,deregister:a,stop:a,deregister:b,stop:b"
        ),
        equal("details.scenarioEvidence.boundEndpointsMatchRegistry", true)
      ],
      "standard Fetch": [
        greaterThan("details.scenarioEvidence.consulFetchCalls", 0),
        equal("details.scenarioEvidence.transportFetchCalls", 5)
      ]
    },
    cleanup: [
      equal("details.cleanup.remainingContainers", 0),
      equal("details.cleanup.remainingNetworks", 0),
      equal("details.cleanup.remainingProviderRegistrations", 0),
      equal("details.cleanup.watcherStopped", true),
      equal("details.cleanup.appsStopped", true),
      equal("details.cleanup.appRunsSettled", true),
      equal("details.cleanup.httpPortsReleased", true),
      equal("details.cleanup.activeHandlers", 0),
      equal("details.cleanup.unhandledRejections", 0),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "registry-mdns-docker": {
    scenarios: {
      "register-discover": [
        equal("details.scenarioEvidence.register-discover.ipv4Created", true),
        equal("details.scenarioEvidence.register-discover.ipv6Created", true),
        equal("details.scenarioEvidence.register-discover.ipv4CompletePayload", true),
        equal("details.scenarioEvidence.register-discover.ipv6CompletePayload", true),
        equal("details.scenarioEvidence.register-discover.ipv4DomainIsolated", true),
        equal("details.scenarioEvidence.register-discover.ipv6DomainIsolated", true),
        nonEmpty("details.scenarioEvidence.register-discover.ipv6AdvertisedEndpoints"),
        nonEmpty("details.scenarioEvidence.register-discover.ipv6PacketSourceAddresses"),
        equal("details.scenarioEvidence.register-discover.ipv6IdentityLifecycle.identityCount", 1),
        equal("details.scenarioEvidence.register-discover.ipv6IdentityLifecycle.createCount", 1),
        equal("details.scenarioEvidence.register-discover.ipv6IdentityLifecycle.updateCount", 2),
        equal("details.scenarioEvidence.register-discover.ipv6IdentityLifecycle.deleteCount", 1),
        equal("details.scenarioEvidence.register-discover.ipv6AdvertisedULAObserved", true),
        equal("details.scenarioEvidence.register-discover.ipv6PacketLinkLocalObserved", true),
        equal(
          "details.scenarioEvidence.register-discover.ipv6SingleIdentityLifecycleObserved",
          true
        ),
        equal("details.scenarioEvidence.register-discover.ipv6ULAtoLinkLocalAliasObserved", true)
      ],
      "watch-update-delete": [
        equal("details.scenarioEvidence.watch-update-delete.ipv4Updated", true),
        equal("details.scenarioEvidence.watch-update-delete.ipv4Restored", true),
        equal("details.scenarioEvidence.watch-update-delete.ipv4Deleted", true),
        equal("details.scenarioEvidence.watch-update-delete.ipv6Updated", true),
        equal("details.scenarioEvidence.watch-update-delete.ipv6Restored", true),
        equal("details.scenarioEvidence.watch-update-delete.ipv6Deleted", true)
      ],
      "crash-expiry": [
        greaterThan("details.crash.publisherBeforeKill.socketFDs", 0),
        greaterThan("details.crash.publisherBeforeKill.udp4Rows", 0),
        equal("details.scenarioEvidence.crash-expiry.publisherExitCode", 137),
        equal("details.scenarioEvidence.crash-expiry.createObserved", true),
        equal("details.scenarioEvidence.crash-expiry.expiryDeleteObserved", true),
        equal("details.scenarioEvidence.crash-expiry.killWithoutGoodbye", true),
        equal("details.scenarioEvidence.crash-expiry.recordTTL2", true),
        arrayIncludes("details.scenarioEvidence.crash-expiry.recordTTLValues", 2),
        equal("details.crash.packets.goodbyeTTL0", false)
      ],
      "collision-rescue": [
        equal(
          "details.scenarioEvidence.collision-rescue.ipv4CollisionCode",
          "LIKEGO_REGISTRY_PROTOCOL"
        ),
        equal(
          "details.scenarioEvidence.collision-rescue.ipv6CollisionCode",
          "LIKEGO_REGISTRY_PROTOCOL"
        ),
        equal("details.scenarioEvidence.collision-rescue.ipv4Rescued", true),
        equal("details.scenarioEvidence.collision-rescue.ipv6Rescued", true)
      ],
      "wire-cleanup": [
        equal("details.scenarioEvidence.wire-cleanup.ipv4PacketValid", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv6PacketValid", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv4IPTTL255", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv6IPTTL255", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv4RecordTTL120And0", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv6RecordTTL120And0", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv4CompleteRRGraph", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv6CompleteRRGraph", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv4CacheFlushClassificationValid", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv6CacheFlushClassificationValid", true),
        arrayIncludes("details.ipv4.packets.ipTTLValues", 255),
        arrayIncludes("details.ipv6.evidence.packets.ipTTLValues", 255),
        arrayIncludes("details.ipv4.packets.recordTTLValues", 120),
        arrayIncludes("details.ipv4.packets.recordTTLValues", 0),
        arrayIncludes("details.ipv6.evidence.packets.recordTTLValues", 120),
        arrayIncludes("details.ipv6.evidence.packets.recordTTLValues", 0),
        equal("details.ipv4.packets.positiveCacheFlush", true),
        equal("details.ipv4.packets.goodbyeCacheFlush", true),
        equal("details.ipv6.evidence.packets.positiveCacheFlush", true),
        equal("details.ipv6.evidence.packets.goodbyeCacheFlush", true),
        equal("details.ipv4.packets.managedTXT", true),
        equal("details.ipv6.evidence.packets.managedTXT", true),
        equal("details.ipv4.packets.canonicalOwner", true),
        equal("details.ipv4.packets.canonicalTarget", true),
        equal("details.ipv6.evidence.packets.canonicalOwner", true),
        equal("details.ipv6.evidence.packets.canonicalTarget", true),
        equal("details.ipv4.packets.completeGraphs.ipv4.positiveTTL120", true),
        equal("details.ipv4.packets.completeGraphs.ipv4.goodbyeTTL0", true),
        equal("details.ipv6.evidence.packets.completeGraphs.ipv6.positiveTTL120", true),
        equal("details.ipv6.evidence.packets.completeGraphs.ipv6.goodbyeTTL0", true),
        equal("details.ipv4.packets.cacheFlushCounts.ipv4.invalid", 0),
        equal("details.ipv6.evidence.packets.cacheFlushCounts.ipv6.invalid", 0),
        greaterThan("details.ipv4.packets.cacheFlushCounts.ipv4.shared", 0),
        greaterThan("details.ipv4.packets.cacheFlushCounts.ipv4.unique", 0),
        greaterThan("details.ipv6.evidence.packets.cacheFlushCounts.ipv6.shared", 0),
        greaterThan("details.ipv6.evidence.packets.cacheFlushCounts.ipv6.unique", 0),
        greaterThan("details.ipv4.packets.recordTypeCounts.ipv4.PTR", 0),
        greaterThan("details.ipv4.packets.recordTypeCounts.ipv4.SRV", 0),
        greaterThan("details.ipv4.packets.recordTypeCounts.ipv4.TXT", 0),
        greaterThan("details.ipv4.packets.recordTypeCounts.ipv4.A", 0),
        greaterThan("details.ipv6.evidence.packets.recordTypeCounts.ipv6.PTR", 0),
        greaterThan("details.ipv6.evidence.packets.recordTypeCounts.ipv6.SRV", 0),
        greaterThan("details.ipv6.evidence.packets.recordTypeCounts.ipv6.TXT", 0),
        greaterThan("details.ipv6.evidence.packets.recordTypeCounts.ipv6.AAAA", 0),
        equal("details.ipv4.packets.legacyNamespaceAbsent", true),
        equal("details.ipv6.evidence.packets.legacyNamespaceAbsent", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv4StoppedObserverNoReceive", true),
        equal("details.scenarioEvidence.wire-cleanup.ipv6StoppedObserverNoReceive", true)
      ]
    },
    services: {
      "Node.js 24.18.0 Docker": [
        equal("details.nodeRuntime", "Node.js 24.18.0"),
        equal("details.images.node", MDNSNodeImage)
      ],
      "Node dgram UDP multicast": [
        greaterThan("details.crash.publisherBeforeKill.socketFDs", 0),
        greaterThan("details.crash.publisherBeforeKill.udp4Rows", 0)
      ],
      "mDNS IPv4 multicast": [
        greaterThan("details.ipv4.packets.ipv4ResponseCount", 0),
        equal("details.ipv4.packets.ipv6ResponseCount", 0),
        arrayIncludes("details.ipv4.packets.ipTTLValues", 255)
      ],
      "mDNS IPv6 multicast": [
        equal("details.ipv6.supported", true),
        greaterThan("details.ipv6.evidence.packets.ipv6ResponseCount", 0),
        equal("details.ipv6.evidence.packets.ipv4ResponseCount", 0),
        arrayIncludes("details.ipv6.evidence.packets.ipTTLValues", 255)
      ],
      "Docker packet capture": [
        equal("details.images.netshoot", MDNSNetshootImage),
        equal("details.ipv4.packets.linkType", 1),
        equal("details.ipv6.evidence.packets.linkType", 1),
        greaterThan("details.ipv4.packets.frameCount", 0),
        greaterThan("details.ipv6.evidence.packets.frameCount", 0)
      ]
    },
    cleanup: [
      equal("details.ipv4.observer.cleanup.afterStop.socketFDs", 0),
      equal("details.ipv4.observer.cleanup.afterStop.udp4Rows", 0),
      equal("details.ipv4.observer.cleanup.afterStop.udp6Rows", 0),
      equal("details.ipv4.observer.cleanup.finalAudit.socketFDs", 0),
      equal("details.ipv4.observer.cleanup.finalAudit.udp4Rows", 0),
      equal("details.ipv4.observer.cleanup.finalAudit.udp6Rows", 0),
      equal("details.ipv6.evidence.observer.cleanup.afterStop.socketFDs", 0),
      equal("details.ipv6.evidence.observer.cleanup.afterStop.udp4Rows", 0),
      equal("details.ipv6.evidence.observer.cleanup.afterStop.udp6Rows", 0),
      equal("details.ipv6.evidence.observer.cleanup.finalAudit.socketFDs", 0),
      equal("details.ipv6.evidence.observer.cleanup.finalAudit.udp4Rows", 0),
      equal("details.ipv6.evidence.observer.cleanup.finalAudit.udp6Rows", 0),
      equal("details.crash.observer.cleanup.after.socketFDs", 0),
      equal("details.crash.observer.cleanup.after.udp4Rows", 0),
      equal("details.crash.observer.cleanup.after.udp6Rows", 0),
      equal("details.cleanup.projectsRemoved", true),
      equal("details.cleanup.containersRemoved", true),
      equal("details.cleanup.networksRemoved", true),
      equal("details.cleanup.processTreesRemoved", true),
      equal("details.cleanup.protectedContainersUnchanged", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "otel-docker": {
    scenarios: {
      "otlp-traces-and-metrics-export": [
        equal("details.scenarioEvidence.otlp-traces-and-metrics-export.tracesReceived", true),
        equal("details.scenarioEvidence.otlp-traces-and-metrics-export.metricsReceived", true),
        equal(
          "details.scenarioEvidence.otlp-traces-and-metrics-export.applicationResourceReceived",
          true
        )
      ],
      "collector-outage-does-not-block-business": [
        greaterThan(
          "details.scenarioEvidence.collector-outage-does-not-block-business.businessProgress",
          0
        ),
        equal(
          "details.scenarioEvidence.collector-outage-does-not-block-business.traceFailureObserved",
          true
        ),
        equal(
          "details.scenarioEvidence.collector-outage-does-not-block-business.metricFailureObserved",
          true
        ),
        equal(
          "details.scenarioEvidence.collector-restart-recovers-export.collectorRestarted",
          true
        ),
        equal("details.scenarioEvidence.collector-restart-recovers-export.recoveredTrace", true),
        equal("details.scenarioEvidence.collector-restart-recovers-export.recoveredMetric", true)
      ],
      "shutdown-flushes-both-signals": [
        equal("details.scenarioEvidence.shutdown-flushes-both-signals.traceFlushed", true),
        equal("details.scenarioEvidence.shutdown-flushes-both-signals.metricFlushed", true),
        equal("details.scenarioEvidence.no-duplicate-shutdown-span.shutdownSpanCount", 1),
        equal("details.scenarioEvidence.no-duplicate-shutdown-span.duplicateShutdownSpans", 0)
      ]
    },
    services: {
      "OpenTelemetry JavaScript 2.10.0": [
        equal("details.otelVersion", "2.10.0"),
        equal(
          "details.scenarioEvidence.otlp-traces-and-metrics-export.applicationResourceReceived",
          true
        ),
        equal(
          "details.scenarioEvidence.collector-outage-does-not-block-business.traceFailureObserved",
          true
        ),
        equal(
          "details.scenarioEvidence.collector-outage-does-not-block-business.metricFailureObserved",
          true
        ),
        equal("details.scenarioEvidence.shutdown-flushes-both-signals.traceFlushed", true),
        equal("details.scenarioEvidence.shutdown-flushes-both-signals.metricFlushed", true)
      ],
      "Collector 0.157.0 Docker": [equal("details.collectorVersion", "0.157.0")]
    },
    cleanup: [
      equal("details.cleanup.remainingContainers", 0),
      equal("details.cleanup.duplicateShutdownSpans", 0),
      equal("details.cleanup.providersTerminal", true),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "otel-instrumentation-docker": {
    scenarios: {
      "client-http-server-parent-child": [
        nonEmpty("details.scenarioEvidence.client-http-server-parent-child.traceId"),
        equal("details.scenarioEvidence.client-http-server-parent-child.chainSpanCount", 3),
        equal("details.scenarioEvidence.client-http-server-parent-child.sameTrace", true),
        equal("details.scenarioEvidence.client-http-server-parent-child.clientParentRoot", true),
        equal("details.scenarioEvidence.client-http-server-parent-child.serverParentClient", true),
        equal("details.scenarioEvidence.client-http-server-parent-child.responseBody", "response"),
        equal("details.scenarioEvidence.client-http-server-parent-child.responseHeader", "ok")
      ],
      "standard-web-handler-parent-child": [
        nonEmpty("details.scenarioEvidence.standard-web-handler-parent-child.traceId"),
        equal("details.scenarioEvidence.standard-web-handler-parent-child.chainSpanCount", 2),
        equal("details.scenarioEvidence.standard-web-handler-parent-child.sameTrace", true),
        equal("details.scenarioEvidence.standard-web-handler-parent-child.handlerParentRoot", true),
        equal(
          "details.scenarioEvidence.standard-web-handler-parent-child.requestBodyUsedAtHandlerEntry",
          false
        ),
        equal(
          "details.scenarioEvidence.standard-web-handler-parent-child.requestBodyLockedAtHandlerEntry",
          false
        ),
        equal(
          "details.scenarioEvidence.standard-web-handler-parent-child.responseBodyUsedBeforeOwnerRead",
          false
        ),
        equal(
          "details.scenarioEvidence.standard-web-handler-parent-child.responseBodyLockedBeforeOwnerRead",
          false
        ),
        equal(
          "details.scenarioEvidence.standard-web-handler-parent-child.requestBody",
          "web-request"
        ),
        equal(
          "details.scenarioEvidence.standard-web-handler-parent-child.responseBody",
          "web-response"
        ),
        equal("details.scenarioEvidence.standard-web-handler-parent-child.collectorReceived", true)
      ],
      "otel-collector-export": [
        equal("details.scenarioEvidence.otel-collector-export.collectorReceived", true),
        equal("details.scenarioEvidence.otel-collector-export.spanCount", 5)
      ]
    },
    services: {
      "OpenTelemetry JavaScript 2.10.0": [
        equal("details.otelVersion", "2.10.0"),
        equal("details.collectorSpanCount", 5)
      ],
      "Collector 0.157.0 Docker": [
        equal("details.collector.image", CollectorImage),
        equal("details.collector.version", "0.157.0"),
        equal("details.scenarioEvidence.otel-collector-export.collectorReceived", true)
      ],
      "standard Web handler": [
        equal("details.scenarioEvidence.standard-web-handler-parent-child.handlerParentRoot", true),
        equal(
          "details.scenarioEvidence.standard-web-handler-parent-child.responseBodyUsedBeforeOwnerRead",
          false
        )
      ],
      "Node HTTP listener": [
        equal("details.cleanup.unaryHttpTerminal", true),
        equal("details.cleanup.webHttpTerminal", true)
      ]
    },
    cleanup: [
      equal("details.cleanup.unaryHttpTerminal", true),
      equal("details.cleanup.webHttpTerminal", true),
      equal("details.cleanup.providersTerminal", true),
      equal("details.cleanup.residualContainers", 0),
      equal("runner.processTreeClean", true),
      equal("runner.dockerResourcesRestored", true)
    ]
  },
  "pino-runtime": {
    scenarios: {
      "pino-native-destination-lifecycle": [
        equal("details.scenarioEvidence.pino-native-destination-lifecycle.component", "file"),
        equal("details.scenarioEvidence.pino-native-destination-lifecycle.redacted", "[Redacted]"),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.nativeCloseObserved",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.structuralFileDestinationAccepted",
          true
        ),
        equal("details.scenarioEvidence.pino-native-destination-lifecycle.fileLanded", true),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.preterminalRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.preterminalOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.preterminalListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.endingWindowRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.endingWindowOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.endingWindowListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startPrototypeMutationRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startPrototypeMutationOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startPrototypeMutationListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startOwnMethodMutationRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startOwnMethodMutationOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startOwnMethodMutationListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startLoggerBindingDriftRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startLoggerBindingOwnershipUnchanged",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startLoggerBindingListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startRegistrationReentryRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startRegistrationReentryOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startRegistrationReentryListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureDestroyRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureDestroyOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureDestroyListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureErrorRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureErrorIdentityPreserved",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureErrorOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureErrorListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureCloseRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureCloseOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureCloseListenersRestored",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.startCaptureCloseDestinationOpen",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerPrototypeMethodCaptured",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerPrototypeReplacementCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerOwnMethodsCaptured",
          true
        ),
        equal("details.scenarioEvidence.pino-native-destination-lifecycle.ownerOwnEndCalls", 0),
        equal("details.scenarioEvidence.pino-native-destination-lifecycle.ownerOwnDestroyCalls", 0),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerLoggerMethodCaptured",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerAdmittedFlushCalls",
          1
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerReplacementFlushCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerStreamDriftRejected",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerStreamDriftErrorStable",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerStreamOriginalClosed",
          true
        ),
        equal(
          "details.scenarioEvidence.pino-native-destination-lifecycle.ownerStreamReplacementOpen",
          true
        )
      ],
      "pino-native-transport-lifecycle": [
        equal("details.scenarioEvidence.pino-native-transport-lifecycle.component", "thread"),
        equal("details.scenarioEvidence.pino-native-transport-lifecycle.nativeCloseObserved", true),
        equal("details.scenarioEvidence.pino-native-transport-lifecycle.fileLanded", true),
        equal("details.scenarioEvidence.pino-native-transport-lifecycle.preterminalRejected", true),
        equal(
          "details.scenarioEvidence.pino-native-transport-lifecycle.preterminalOwnershipCalls",
          0
        ),
        equal(
          "details.scenarioEvidence.pino-native-transport-lifecycle.preterminalListenersRestored",
          true
        )
      ]
    },
    services: {
      "Pino 10.3.1": [equal("details.pinoVersion", "10.3.1")],
      "Pino-owned SonicBoom 4.2.1": [equal("details.pinoOwnedSonicBoomVersion", "4.2.1")],
      "thread-stream 4.2.0": [equal("details.threadStreamVersion", "4.2.0")],
      "native filesystem": [
        equal("details.scenarioEvidence.pino-native-destination-lifecycle.fileLanded", true)
      ],
      "native worker and filesystem": [
        equal("details.scenarioEvidence.pino-native-transport-lifecycle.fileLanded", true)
      ]
    },
    cleanup: [
      equal("details.cleanup.terminalRuns", 2),
      equal("details.cleanup.directoryRemoved", true),
      equal("runner.processTreeClean", true)
    ]
  },
  "winston-runtime": {
    scenarios: {
      "winston-native-file-lifecycle": [
        equal("details.scenarioEvidence.winston-native-file-lifecycle.component", "winston"),
        equal("details.scenarioEvidence.winston-native-file-lifecycle.final", true),
        equal("details.scenarioEvidence.winston-native-file-lifecycle.message", "native logger"),
        equal("details.scenarioEvidence.winston-native-file-lifecycle.level", "info"),
        equal("details.scenarioEvidence.winston-native-file-lifecycle.joinedStops", true),
        equal(
          "details.scenarioEvidence.winston-native-file-lifecycle.startPendingBeforeStop",
          true
        ),
        equal("details.scenarioEvidence.winston-native-file-lifecycle.nativeFinishObserved", true),
        equal("details.scenarioEvidence.winston-native-file-lifecycle.fileLanded", true),
        equal(
          "details.scenarioEvidence.winston-native-file-lifecycle.lifecycleOrder",
          "native-finish>stop-resolved>start-resolved>file-read"
        ),
        equal(
          "details.scenarioEvidence.winston-native-file-lifecycle.finishBeforeStopResolution",
          true
        ),
        equal(
          "details.scenarioEvidence.winston-native-file-lifecycle.finishBeforeStartResolution",
          true
        ),
        equal(
          "details.scenarioEvidence.winston-native-file-lifecycle.finalRecordReadAfterFinish",
          true
        )
      ]
    },
    services: {
      "Winston 3.19.0": [equal("details.winstonVersion", "3.19.0")],
      "Winston File transport": [
        equal("details.scenarioEvidence.winston-native-file-lifecycle.fileLanded", true),
        equal("details.scenarioEvidence.winston-native-file-lifecycle.component", "winston")
      ],
      "native filesystem": [equal("details.cleanup.directoryRemoved", true)]
    },
    cleanup: [
      equal("details.cleanup.terminalCompleted", true),
      equal("details.cleanup.listenerDelta", 0),
      equal("details.cleanup.directoryRemoved", true),
      equal("runner.processTreeClean", true)
    ]
  },
  "prometheus-runtime": {
    scenarios: {
      "prometheus-registry-handler-scrape": [
        equal("details.scrape.status", 200),
        equal("details.scrape.sampleValue", 1),
        includes("details.scrape.contentType", "text/plain")
      ]
    },
    services: {
      "prom-client 15.1.3": [equal("details.promClientVersion", "15.1.3")],
      "standard Web Handler": [equal("details.scrape.status", 200)]
    },
    cleanup: [
      equal("details.cleanup.registryCleared", true),
      equal("runner.processTreeClean", true)
    ]
  }
})

/** Returns one immutable release-evidence contract, or null for evidence-only suites. */
export function proofContract(suite: string): SuiteProofContract | null {
  return Contracts[suite] ?? null
}
