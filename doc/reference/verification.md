# Verification

LikeGo treats a passing unit test as one kind of evidence, not a universal proof. Portable packages run strict TypeScript checks, source-policy checks, production-source coverage, build verification, and published-package smoke tests. Runtime lanes exercise supported Bun, Node.js, and Deno environments where the package contract applies.

External systems are tested against real containers pinned by immutable image digest. The suites create actual Consul, etcd, NATS, OpenTelemetry Collector, Redis/BullMQ, ZooKeeper, and Kubernetes/K3s resources as needed, then verify both behaviour and cleanup. A fake provider is useful for deterministic edge cases, but it never substitutes for a real protocol gate.

The only complete release-blocking root gate is:

```sh
bun run verify
```

Provider-specific Docker commands and narrower checks live in their package scripts and produce machine-readable result markers. They are useful diagnostics, but do not replace the complete root gate. Release status is determined only by the terminal result of the latest full `bun run verify`; also inspect generated package contents, workspace manifests, Docker resource teardown, and `git status`. A started command or an empty log is not evidence of success.

## Production soak

The scheduled and manually dispatched soak is separate from pull-request verification. It runs a pinned k6 image against the standard Fetch Web server with [k6's normal HTTP keep-alive semantics](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/#no-connection-reuse) while a real LikeGo Client reuses two internal HTTP endpoints. Forced short-connection churn is intentionally excluded from the 60-minute gate because [Docker Desktop routes container-to-host traffic through its VM/backend](https://docs.docker.com/desktop/features/networking/); the shutdown scenario independently exercises connection close, drain, and rejection. A complete release-candidate run lasts at least 60 minutes and then executes the RabbitMQ publisher-confirm interruption and Redis Sentinel/Cluster failover gates.

```sh
bun run soak:http
bun run soak:check
```

The schema-v3 JSON records the exact runner argv, pinned Bun/Node/k6 versions, Git HEAD and clean state at both boundaries; request, failure, dropped-iteration and latency figures; Client call/dial counts; scenario outcomes; server/client terminal state, port rebind, and Docker container/network/volume cleanup. `runnerSamples` measures the Bun orchestration process and its portable internal Client workload. `webHostSamples` independently measures the Node process that owns the Fetch Web server and both Node-only internal service servers; the harness never executes `@likego/transport-http/node` in Bun. Both series include RSS, heap, active handles, and file descriptors. Raw k6 output is written to `k6.log`, and runtime samples are written to `runtime.json`, before HTTP thresholds or provider gates are enforced, so failed gates retain diagnostic evidence. Each release-duration series must strictly cover the requested interval with no gap over 15 seconds. Shutdown evidence holds eight concurrent requests, proves all eight drain, and proves a new request is rejected after stop begins. SIGINT/SIGTERM abort every owned command through the shared process-tree boundary before cleanup is checked.

Any missing provenance, mismatched runner or pinned runtime, shortened or sparse sample timeline, missing Linux/macOS file-descriptor evidence, unexpected error, unhandled rejection, failed check, dropped iteration, invalid quantile, sustained steady-state window growth, invalid shutdown evidence, or cleanup residue fails closed. Retained FD or active-handle growth over its threshold fails even after it plateaus. RSS and heap fail when a threshold-breaking early-to-late median rise continues inside the late window, or when a retained plateau exceeds twice the growth threshold plus the recent-window noise allowance. This rejects rising and repeated-step baselines without misclassifying one bounded allocator high-water step as unbounded growth. A short run such as `--duration 10s` validates the harness only and can never become a release candidate. A valid full run from a dirty worktree may pass behavioural checking, but `releaseCandidate` remains `false`; only a run that is clean at both boundaries can set it to `true`.

Hosted evidence still depends on repository settings outside this tree: a pushed and protected `main`, enabled Actions, the protected `npm` environment, npm trusted-publisher configuration, and retained workflow artifacts. Local success does not prove those controls exist or that a production pilot has succeeded.
