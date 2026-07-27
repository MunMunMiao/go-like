# LikeGo 文件交付清单

本清单按目录列出仓库中可审查的真实文件。
以下生成物、依赖目录、IDE 状态、Git 内部数据、覆盖率数据和私有工作流临时文件不在清单内：
`.artifacts`, `.git`, `.idea`, `.superpowers`, `coverage`, `dist`, `node_modules`, `reports`, `test-build`,
以及 `.DS_Store` 和 `*.tsbuildinfo`。

目录数：682。文件数：2216。

## .

- `.gitignore`
- `.oxfmtrc.json`
- `LICENSE`
- `README.md`
- `SECURITY.md`
- `bun.lock`
- `bunfig.toml`
- `deno.json`
- `package.json`
- `tsconfig.base.json`
- `tsconfig.build.json`
- `tsconfig.json`
- `tsconfig.test.json`
- `tsconfig.tsdown.json`
- `tsdown.config.ts`

## .changeset

- `README.md`
- `config.json`

## .github

- `dependabot.yml`

## .github/workflows

- `codeql.yml`
- `release.yml`
- `soak.yml`
- `verify.yml`

## config

- `runtime-matrix.json`

## doc

- `index.md`

## doc/.vitepress

- `config.ts`

## doc/ar-Arab

- `index.md`

## doc/ar-Arab/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/ar-Arab/reference

- `packages.md`
- `verification.md`

## doc/es-Latn

- `index.md`

## doc/es-Latn/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/es-Latn/reference

- `packages.md`
- `verification.md`

## doc/fr-Latn

- `index.md`

## doc/fr-Latn/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/fr-Latn/reference

- `packages.md`
- `verification.md`

## doc/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/public

- `favicon.svg`

## doc/reference

- `packages.md`
- `verification.md`

## doc/ru-Cyrl

- `index.md`

## doc/ru-Cyrl/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/ru-Cyrl/reference

- `packages.md`
- `verification.md`

## doc/zh-Hans

- `index.md`

## doc/zh-Hans/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/zh-Hans/reference

- `packages.md`
- `verification.md`

## doc/zh-Hant-HK

- `index.md`

## doc/zh-Hant-HK/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/zh-Hant-HK/reference

- `packages.md`
- `verification.md`

## doc/zh-Hant-TW

- `index.md`

## doc/zh-Hant-TW/guide

- `architecture.md`
- `broker-events.md`
- `config-registry-store.md`
- `getting-started.md`
- `health-observability.md`
- `service-call.md`
- `streaming.md`

## doc/zh-Hant-TW/reference

- `packages.md`
- `verification.md`

## docs

- `capability-comparison.md`
- `developer-experience-alignment.md`
- `example-portfolio.md`
- `file-inventory.md`
- `v1-evidence-matrix.md`

## docs/adr

- `0001-kernel-public-api.md`
- `0002-build-runtime-and-coverage.md`
- `0003-resident-adapter-ownership.md`
- `0004-service-registry-and-selection.md`
- `0005-operation-resilience.md`
- `0006-store-contract-and-providers.md`
- `0007-broker-event-native-semantics.md`
- `0008-service-declaration-and-registration.md`

## docs/releases

- `0.0.1.md`

## docs/releases/0.0.1

- _（当前目录无直属文件）_

## docs/releases/0.0.1/changesets

- `broker-event-nats.md`
- `broker-memory-provider.md`
- `broker-terminal-observability.md`
- `bullmq-latest-recovery.md`
- `cache-vault-providers.md`
- `calm-services-call.md`
- `client-discovery-block.md`
- `client-metadata-runtime-readiness.md`
- `client-operation-breaker.md`
- `client-pool-bounds.md`
- `client-resident-transport-reuse.md`
- `client-single-transport.md`
- `config-node-transport-memory.md`
- `config-placeholder-resolver.md`
- `config-terminal-error.md`
- `config-yaml-etcd.md`
- `core-app-hooks-health-readiness.md`
- `core-lifecycle-deadlines.md`
- `core-positional-servers.md`
- `core-registry-service-instance.md`
- `core-start-stop-race.md`
- `create-likego-scaffold.md`
- `health-remove-app-status.md`
- `internal-provider-conformance.md`
- `node-http-client-provider.md`
- `observability-error-redaction.md`
- `otel-instrumentation.md`
- `otel-portable-server-name.md`
- `provider-server-lifecycle.md`
- `rabbitmq-kubernetes-config.md`
- `rabbitmq-publisher-confirms.md`
- `redis-native-topologies.md`
- `registry-construction-options.md`
- `registry-etcd.md`
- `registry-kubernetes.md`
- `registry-registration-terminal.md`
- `registry-selectors.md`
- `registry-zookeeper.md`
- `release-production-gates.md`
- `selection-outcome-done-info.md`
- `server-auto-registration.md`
- `server-go-style-api.md`
- `server-operation-middleware.md`
- `server-rate-limit.md`
- `store-consul.md`
- `store-etcd.md`
- `store-file.md`
- `store-memory-provider.md`
- `transport-http-single-transport.md`
- `transport-supported-options.md`
- `vault-store-constructor.md`
- `vitepress-docs.md`
- `web-readiness-fail-closed.md`

## docs/superpowers

- _（当前目录无直属文件）_

## docs/superpowers/plans

- `2026-07-17-bun-monorepo-foundation.md`
- `2026-07-17-prekernel-verification-gates.md`
- `2026-07-18-native-lifecycle-adapters.md`
- `2026-07-19-likego-package-transport-web.md`
- `2026-07-20-likego-service-call-closure.md`
- `2026-07-21-likego-struct-package.md`
- `2026-07-21-likego-v1-framework-completion.md`
- `2026-07-25-latest-stable-dependencies.md`
- `2026-07-25-likego-v001-remediation.md`
- `2026-07-26-go-framework-validated-remediation.md`
- `2026-07-26-likego-follow-up-audit-remediation.md`
- `2026-07-26-likego-production-readiness.md`

## docs/superpowers/specs

- `2026-07-17-likego-v1-program-design.md`
- `2026-07-19-likego-package-transport-web-design.md`
- `2026-07-20-likego-service-call-closure-design.md`
- `2026-07-21-likego-v1-framework-completion-design.md`
- `2026-07-25-latest-stable-dependencies-design.md`
- `2026-07-25-likego-v001-remediation-design.md`
- `2026-07-26-likego-follow-up-audit-remediation-design.md`
- `2026-07-26-likego-production-readiness-design.md`

## e2e

- `README.md`
- `case.ts`
- `contracts.ts`
- `e2e.test.ts`
- `inventory.ts`
- `package-identities.ts`
- `run.ts`
- `suites.test.ts`
- `suites.ts`
- `tsconfig.json`
- `validate.ts`

## e2e/cases

- `app-graceful-stop.case.ts`
- `app-structural-server.case.ts`
- `bullmq-noncooperative-force.case.ts`
- `bullmq-queue-ownership-cleanup.case.ts`
- `bullmq-redis-recovery.case.ts`
- `bullmq-retry-backoff.case.ts`
- `bullmq-stalled-recovery.case.ts`
- `config-consul-blocking-update.case.ts`
- `config-consul-initial-load.case.ts`
- `config-consul-last-good.case.ts`
- `config-consul-reconcile.case.ts`
- `config-etcd-watch-compaction.case.ts`
- `context-after-func-race.case.ts`
- `context-deadline-timeout.case.ts`
- `context-parent-cancel-cause.case.ts`
- `context-without-cancel-value.case.ts`
- `cron-explicit-stop-no-fabricated-drain.case.ts`
- `cron-native-exhaustion-unobservable.case.ts`
- `fetch-node-client-abort.case.ts`
- `fetch-node-graceful-drain.case.ts`
- `fetch-node-hard-force.case.ts`
- `fetch-node-request-response.case.ts`
- `fetch-node-streaming-response.case.ts`
- `health-fetch-policy.case.ts`
- `health-readiness-sanitization.case.ts`
- `jetstream-ackack.case.ts`
- `jetstream-dlq-ordering.case.ts`
- `jetstream-max-deliver.case.ts`
- `jetstream-reconnect.case.ts`
- `jetstream-startup-cancel.case.ts`
- `nats-core-at-most-once-failure.case.ts`
- `nats-core-queue-group.case.ts`
- `nats-core-raw-pubsub.case.ts`
- `nats-core-reconnect.case.ts`
- `nats-core-startup-cancel.case.ts`
- `otel-instrumentation-collector-export.case.ts`
- `otel-instrumentation-unary-parent-child.case.ts`
- `otel-instrumentation-web-handler-parent-child.case.ts`
- `otel-outage-business-progress.case.ts`
- `otel-shutdown-flush.case.ts`
- `otel-traces-metrics-export.case.ts`
- `pino-native-destination-lifecycle.case.ts`
- `pino-native-transport-lifecycle.case.ts`
- `prometheus-fetch-scrape.case.ts`
- `registry-consul-private-ttl-heartbeat.case.ts`
- `registry-consul-replacement-watch.case.ts`
- `registry-consul-service-roundtrip.case.ts`
- `registry-etcd-lost-response-readback.case.ts`
- `registry-etcd-service-lifecycle.case.ts`
- `registry-etcd-sigkill-lease-expiry.case.ts`
- `registry-kubernetes-namespace-isolation.case.ts`
- `registry-kubernetes-resourceversion.case.ts`
- `registry-kubernetes-service-lifecycle.case.ts`
- `registry-kubernetes-watch-recovery.case.ts`
- `registry-mdns-collision-rescue.case.ts`
- `registry-mdns-crash-expiry.case.ts`
- `registry-mdns-register-discover.case.ts`
- `registry-mdns-watch-update-delete.case.ts`
- `registry-mdns-wire-cleanup.case.ts`
- `registry-transport-consul-call.case.ts`
- `registry-zookeeper-service-lifecycle.case.ts`
- `registry-zookeeper-sigkill-expiry.case.ts`
- `resilience-circuit-breaker-recovery.case.ts`
- `resilience-retry-fresh-request.case.ts`
- `resilience-token-bucket-refill.case.ts`
- `store-consul-acl-redaction.case.ts`
- `store-consul-crud-cas-ttl.case.ts`
- `store-consul-root-isolation.case.ts`
- `store-etcd-crud-cas-pagination.case.ts`
- `store-etcd-lease-restart.case.ts`
- `store-file-checksum-recovery.case.ts`
- `store-file-process-crash.case.ts`
- `transport-http-graceful-drain.case.ts`
- `transport-http-hard-force.case.ts`
- `transport-http-passive-failure.case.ts`
- `transport-http-unary-loopback.case.ts`
- `web-elysia-fetch-listener.case.ts`
- `web-h3-fetch-listener.case.ts`
- `web-hono-fetch-listener.case.ts`
- `web-vanilla-fetch-listener.case.ts`
- `winston-native-file-lifecycle.case.ts`

## e2e/evidence

- `README.md`

## e2e/load

- `k6-http.js`
- `web-host.ts`

## e2e/scripts

- `kernel-native.ts`
- `prometheus-native.ts`
- `registry-transport-consul-docker.ts`
- `resilience-native.ts`
- `store-file-process.ts`
- `web-framework-native.ts`
- `winston-native.ts`

## examples

- `README.md`
- `catalog.json`

## examples/ad-campaign-serving

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/ad-campaign-serving/src

- `ad-resources.ts`
- `campaigns.ts`
- `http.ts`
- `main.ts`
- `service.ts`

## examples/ad-campaign-serving/test

- `main.test.ts`

## examples/airline-irregular-operations

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/airline-irregular-operations/src

- `http.ts`
- `main.ts`
- `registry.ts`
- `service.ts`

## examples/airline-irregular-operations/test

- `main.test.ts`

## examples/bank-transfer-gateway

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/bank-transfer-gateway/src

- `contract.ts`
- `http.ts`
- `main.ts`
- `service.ts`
- `transport.ts`

## examples/bank-transfer-gateway/test

- `main.test.ts`

## examples/batch-reporting

- `README.md`
- `bunfig.toml`
- `compose.yaml`
- `package.json`
- `tsconfig.json`

## examples/batch-reporting/src

- `checkpoint.ts`
- `main.ts`
- `processor.ts`
- `report-window.ts`
- `scheduler.ts`

## examples/batch-reporting/src/application

- _（当前目录无直属文件）_

## examples/batch-reporting/src/domain

- _（当前目录无直属文件）_

## examples/batch-reporting/src/entrypoint

- _（当前目录无直属文件）_

## examples/batch-reporting/src/infrastructure

- _（当前目录无直属文件）_

## examples/batch-reporting/test

- _（当前目录无直属文件）_

## examples/batch-reporting/test/e2e

- `docker-e2e.ts`
- `stalled-child.ts`

## examples/batch-reporting/test/unit

- `reporting.test.ts`

## examples/cold-chain-monitoring

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/cold-chain-monitoring/src

- `config.ts`
- `http.ts`
- `main.ts`
- `service.ts`

## examples/cold-chain-monitoring/test

- `main.test.ts`

## examples/commerce-catalog

- `README.md`
- `compose.yaml`
- `package.json`
- `tsconfig.json`

## examples/commerce-catalog/e2e

- `docker.ts`

## examples/commerce-catalog/src

- `catalog.ts`
- `http.ts`
- `main.ts`
- `pricing.ts`

## examples/commerce-catalog/src/application

- _（当前目录无直属文件）_

## examples/commerce-catalog/src/domain

- _（当前目录无直属文件）_

## examples/commerce-catalog/src/entrypoint

- _（当前目录无直属文件）_

## examples/commerce-catalog/src/infrastructure

- _（当前目录无直属文件）_

## examples/commerce-catalog/test

- `app.test.ts`

## examples/customer-support-routing

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/customer-support-routing/src

- `http.ts`
- `main.ts`
- `routing.ts`
- `service.ts`

## examples/customer-support-routing/test

- `main.test.ts`

## examples/cybersecurity-alert-triage

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/cybersecurity-alert-triage/e2e

- `docker.ts`

## examples/cybersecurity-alert-triage/src

- `config.ts`
- `http.ts`
- `main.ts`
- `service.ts`

## examples/cybersecurity-alert-triage/test

- `main.test.ts`

## examples/digital-identity-verification

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/digital-identity-verification/src

- `http.ts`
- `main.ts`
- `provider.ts`
- `service.ts`

## examples/digital-identity-verification/test

- `main.test.ts`

## examples/elysia

- `README.md`
- `bunfig.toml`
- `package.json`
- `tsconfig.json`

## examples/elysia/src

- `app.ts`
- `main.ts`
- `routes.ts`

## examples/elysia/test

- `app.test.ts`
- `node-e2e.ts`

## examples/emergency-response-dispatch

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/emergency-response-dispatch/src

- `dispatch.ts`
- `http.ts`
- `main.ts`
- `service.ts`

## examples/emergency-response-dispatch/test

- `main.test.ts`

## examples/energy-meter-settlement

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/energy-meter-settlement/src

- `http.ts`
- `main.ts`
- `meter-settlement.ts`
- `service.ts`
- `tariff-config.ts`

## examples/energy-meter-settlement/test

- `main.test.ts`

## examples/enterprise-platform-runtime

- `README.md`
- `bunfig.toml`
- `compose.yaml`
- `package.json`
- `tsconfig.json`

## examples/enterprise-platform-runtime/src

- `config.ts`
- `echo.ts`
- `main.ts`
- `management.ts`
- `probes.ts`
- `runtime-state.ts`

## examples/enterprise-platform-runtime/src/application

- _（当前目录无直属文件）_

## examples/enterprise-platform-runtime/src/domain

- _（当前目录无直属文件）_

## examples/enterprise-platform-runtime/src/infrastructure

- _（当前目录无直属文件）_

## examples/enterprise-platform-runtime/src/runtime

- _（当前目录无直属文件）_

## examples/enterprise-platform-runtime/src/servers

- _（当前目录无直属文件）_

## examples/enterprise-platform-runtime/test

- _（当前目录无直属文件）_

## examples/enterprise-platform-runtime/test/e2e

- `docker-e2e.ts`

## examples/enterprise-platform-runtime/test/unit

- `runtime.test.ts`

## examples/ev-charging-control

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/ev-charging-control/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/ev-charging-control/test

- `main.test.ts`

## examples/fraud-risk-scoring

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/fraud-risk-scoring/src

- `cache.ts`
- `http.ts`
- `main.ts`
- `service.ts`

## examples/fraud-risk-scoring/test

- `main.test.ts`

## examples/government-permit-workflow

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/government-permit-workflow/src

- `http.ts`
- `main.ts`
- `permits.ts`
- `service.ts`
- `worker.ts`

## examples/government-permit-workflow/test

- `main.test.ts`

## examples/h3

- `README.md`
- `bunfig.toml`
- `package.json`
- `tsconfig.json`

## examples/h3/src

- `app.ts`
- `main.ts`
- `routes.ts`

## examples/h3/test

- `app.test.ts`
- `node-e2e.ts`

## examples/healthcare-appointments

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/healthcare-appointments/src

- `http.ts`
- `main.ts`
- `service.ts`
- `transport.ts`

## examples/healthcare-appointments/test

- `main.test.ts`

## examples/hono

- `README.md`
- `bunfig.toml`
- `package.json`
- `tsconfig.json`

## examples/hono/src

- `app.ts`
- `main.ts`
- `routes.ts`

## examples/hono/test

- `app.test.ts`
- `node-e2e.ts`

## examples/hotel-room-reservation

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/hotel-room-reservation/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/hotel-room-reservation/test

- `main.test.ts`

## examples/insurance-claims

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/insurance-claims/src

- `http.ts`
- `main.ts`
- `service.ts`
- `worker.ts`

## examples/insurance-claims/test

- `main.test.ts`

## examples/iot-telemetry

- `README.md`
- `compose.yaml`
- `package.json`
- `tsconfig.json`

## examples/iot-telemetry/e2e

- `docker.ts`

## examples/iot-telemetry/src

- `main.ts`
- `nats.ts`
- `processor.ts`
- `runtime.ts`
- `telemetry.ts`
- `worker.ts`

## examples/iot-telemetry/src/application

- _（当前目录无直属文件）_

## examples/iot-telemetry/src/domain

- _（当前目录无直属文件）_

## examples/iot-telemetry/src/entrypoint

- _（当前目录无直属文件）_

## examples/iot-telemetry/src/infrastructure

- _（当前目录无直属文件）_

## examples/iot-telemetry/test

- `telemetry.test.ts`

## examples/laboratory-results

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/laboratory-results/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/laboratory-results/test

- `main.test.ts`

## examples/last-mile-dispatch

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/last-mile-dispatch/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/last-mile-dispatch/test

- `main.test.ts`

## examples/learning-enrollment

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/learning-enrollment/src

- `http.ts`
- `main.ts`
- `runtime.ts`
- `service.ts`
- `transport.ts`

## examples/learning-enrollment/test

- `main.test.ts`

## examples/live-game-matchmaking

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/live-game-matchmaking/src

- `http.ts`
- `main.ts`
- `match-resources.ts`
- `registry.ts`
- `service.ts`

## examples/live-game-matchmaking/test

- `main.test.ts`

## examples/logistics-shipment-tracking

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/logistics-shipment-tracking/src

- `cache.ts`
- `http.ts`
- `main.ts`
- `service.ts`

## examples/logistics-shipment-tracking/test

- `main.test.ts`

## examples/manufacturing-maintenance

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/manufacturing-maintenance/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/manufacturing-maintenance/test

- `main.test.ts`

## examples/marketplace-order-fulfillment

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/marketplace-order-fulfillment/src

- `http.ts`
- `main.ts`
- `service.ts`
- `worker.ts`

## examples/marketplace-order-fulfillment/test

- `main.test.ts`

## examples/media-transcoding-pipeline

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/media-transcoding-pipeline/src

- `http.ts`
- `main.ts`
- `service.ts`
- `transcode-jobs.ts`
- `transcode-worker.ts`

## examples/media-transcoding-pipeline/test

- `main.test.ts`

## examples/notification-delivery

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/notification-delivery/src

- `events.ts`
- `http.ts`
- `main.ts`
- `provider.ts`
- `service.ts`

## examples/notification-delivery/test

- `main.test.ts`

## examples/payments-ledger

- `README.md`
- `compose.yaml`
- `package.json`
- `tsconfig.json`

## examples/payments-ledger/e2e

- `docker.ts`

## examples/payments-ledger/src

- `http.ts`
- `main.ts`
- `nats.ts`
- `payment.ts`
- `post-payment.ts`
- `postgres.ts`
- `worker.ts`

## examples/payments-ledger/src/application

- _（当前目录无直属文件）_

## examples/payments-ledger/src/domain

- _（当前目录无直属文件）_

## examples/payments-ledger/src/entrypoint

- _（当前目录无直属文件）_

## examples/payments-ledger/src/infrastructure

- _（当前目录无直属文件）_

## examples/payments-ledger/src/infrastructure/nats

- _（当前目录无直属文件）_

## examples/payments-ledger/src/infrastructure/postgres

- _（当前目录无直属文件）_

## examples/payments-ledger/test

- `ledger.test.ts`

## examples/pharmacy-prescription

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/pharmacy-prescription/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/pharmacy-prescription/test

- `main.test.ts`

## examples/public-transit-arrivals

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/public-transit-arrivals/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/public-transit-arrivals/test

- `main.test.ts`

## examples/real-estate-search-index

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/real-estate-search-index/src

- `cache.ts`
- `http.ts`
- `main.ts`
- `repository.ts`
- `service.ts`

## examples/real-estate-search-index/test

- `main.test.ts`

## examples/restaurant-kitchen-routing

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/restaurant-kitchen-routing/src

- `http.ts`
- `main.ts`
- `registry.ts`
- `routing.ts`
- `service.ts`

## examples/restaurant-kitchen-routing/test

- `main.test.ts`

## examples/retail-inventory-reservation

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/retail-inventory-reservation/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/retail-inventory-reservation/test

- `main.test.ts`

## examples/saas-tenant-api

- `README.md`
- `compose.yaml`
- `package.json`
- `tsconfig.json`

## examples/saas-tenant-api/e2e

- `docker.ts`

## examples/saas-tenant-api/src

- `cache.ts`
- `config.ts`
- `http.ts`
- `main.ts`
- `runtime-state.ts`

## examples/saas-tenant-api/src/application

- _（当前目录无直属文件）_

## examples/saas-tenant-api/src/domain

- _（当前目录无直属文件）_

## examples/saas-tenant-api/src/entrypoint

- _（当前目录无直属文件）_

## examples/saas-tenant-api/src/infrastructure

- _（当前目录无直属文件）_

## examples/saas-tenant-api/test

- `app.test.ts`

## examples/securities-market-data

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/securities-market-data/src

- `http.ts`
- `main.ts`
- `service.ts`

## examples/securities-market-data/test

- `main.test.ts`

## examples/smart-agriculture-irrigation

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/smart-agriculture-irrigation/src

- `http.ts`
- `irrigation-config.ts`
- `irrigation-policy.ts`
- `main.ts`
- `service.ts`

## examples/smart-agriculture-irrigation/test

- `main.test.ts`

## examples/subscription-billing

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/subscription-billing/src

- `config.ts`
- `http.ts`
- `main.ts`
- `service.ts`

## examples/subscription-billing/test

- `main.test.ts`

## examples/telecom-service-provisioning

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/telecom-service-provisioning/src

- `http.ts`
- `main.ts`
- `repository.ts`
- `service.ts`
- `transport.ts`

## examples/telecom-service-provisioning/test

- `main.test.ts`

## examples/vanilla-web

- `README.md`
- `bunfig.toml`
- `package.json`
- `tsconfig.json`

## examples/vanilla-web/src

- `app.ts`
- `main.ts`
- `routes.ts`

## examples/vanilla-web/test

- `app.test.ts`
- `node-e2e.ts`

## examples/warehouse-wave-picking

- `README.md`
- `package.json`
- `tsconfig.json`

## examples/warehouse-wave-picking/src

- `http.ts`
- `main.ts`
- `service.ts`
- `worker.ts`

## examples/warehouse-wave-picking/test

- `main.test.ts`

## packages

- _（当前目录无直属文件）_

## packages/broker

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/broker/memory

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/broker/memory/src

- `index.ts`

## packages/broker/memory/test

- `broker.test.ts`
- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/broker/rabbitmq

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/broker/rabbitmq/src

- `index.ts`

## packages/broker/rabbitmq/test

- `broker.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/broker/rabbitmq/test/e2e

- `rabbitmq-docker-e2e.ts`

## packages/broker/rabbitmq/test/runtime

- `published-runtime.fixture`

## packages/broker/src

- `index.ts`
- `provider.ts`

## packages/broker/test

- `broker.test.ts`
- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`

## packages/bullmq

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/bullmq/src

- `errors.ts`
- `index.ts`
- `server.ts`
- `testing.ts`
- `types.ts`

## packages/bullmq/test

- `construction.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `lifecycle.test.ts`
- `native-boundary.test.ts`
- `outage-observation.test.ts`
- `outage-observation.ts`
- `package-contract.test.ts`
- `processor.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/bullmq/test/e2e

- `docker-e2e.ts`
- `stalled-child.ts`

## packages/bullmq/test/smoke

- `package-smoke.ts`
- `redis-smoke.ts`

## packages/cache

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/cache/memory

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/cache/memory/src

- `cache.ts`
- `index.ts`
- `options.ts`
- `types.ts`

## packages/cache/memory/test

- `cache.test.ts`
- `conformance.test.ts`
- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/cache/redis

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/cache/redis/src

- `cache.ts`
- `codec.ts`
- `connection.ts`
- `errors.ts`
- `index.ts`
- `options.ts`
- `types.ts`

## packages/cache/redis/test

- `cache.test.ts`
- `codec.test.ts`
- `connection.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `options-errors.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/cache/redis/test/integration

- `redis-8.8.0-report.md`
- `redis-8.8.1-report.md`
- `redis-docker.ts`

## packages/cache/src

- `index.ts`
- `options.ts`
- `provider.ts`
- `testing.ts`
- `types.ts`

## packages/cache/test

- `conformance.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `options-errors.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/client

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/client/src

- `cleanup.ts`
- `index.ts`
- `resolver.ts`

## packages/client/test

- `client.test.ts`
- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/config

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/config/consul

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/config/consul/src

- `index.ts`

## packages/config/consul/test

- `consul.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/config/consul/test/integration

- `consul-2.0.2-report.md`
- `consul-docker.ts`
- `runtime-matrix-report.md`
- `runtime-matrix.ts`

## packages/config/etcd

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/config/etcd/src

- `index.ts`

## packages/config/etcd/test

- `boundary.test.ts`
- `coverage-contract.ts`
- `etcd.test.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `public-api.test.ts`

## packages/config/etcd/test/integration

- `etcd-3.7.0-report.md`
- `etcd-3.7.1-report.md`
- `etcd-docker.ts`

## packages/config/kubernetes

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/config/kubernetes/src

- `index.ts`

## packages/config/kubernetes/test

- `boundary.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `kubernetes.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`

## packages/config/kubernetes/test/integration

- `k3s-1.36.2-report.md`
- `k3s-docker.ts`

## packages/config/kubernetes/test/runtime

- `published-runtime.fixture`

## packages/config/src

- `config.ts`
- `env.ts`
- `errors.ts`
- `file.ts`
- `index.ts`
- `merge.ts`
- `node-host.ts`
- `node.ts`
- `source.ts`
- `validation.ts`
- `value.ts`
- `yaml.ts`

## packages/config/test

- `construction.test.ts`
- `coverage-contract.ts`
- `env-package-contract.test.ts`
- `env-public-api.test.ts`
- `env-public-types.ts`
- `env-source-policy.test.ts`
- `env.test.ts`
- `file-helpers.ts`
- `file-package-contract.test.ts`
- `file-public-api.test.ts`
- `file-public-types.ts`
- `file-source-policy.test.ts`
- `file.test.ts`
- `helpers.ts`
- `lifecycle.test.ts`
- `load.test.ts`
- `merge.test.ts`
- `node-file.test.ts`
- `node-public-api.test.ts`
- `node-public-types.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `reload.test.ts`
- `resolver.test.ts`
- `source-policy.test.ts`
- `subscription.test.ts`
- `validation.test.ts`
- `value.test.ts`
- `yaml.test.ts`

## packages/config/test/runtime

- `deno-runtime.ts`
- `file-published-runtime.fixture.ts`
- `node-file-runtime.ts`
- `node-runtime.ts`
- `published-runtime.fixture`

## packages/config/test/smoke

- `dist-smoke.ts`

## packages/config/vault

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/config/vault/src

- `index.ts`

## packages/config/vault/test

- `coverage-contract.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `vault.test.ts`

## packages/config/vault/test/integration

- `vault-2.0.3-report.md`
- `vault-docker.ts`

## packages/context

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/context/src

- `after-func.ts`
- `cancel.ts`
- `deadline.ts`
- `empty.ts`
- `errors.ts`
- `index.ts`
- `internal.ts`
- `value.ts`

## packages/context/test

- `after-func.test.ts`
- `cancel-value.test.ts`
- `coverage-contract.ts`
- `deadline.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/context/test/smoke

- `package-smoke.ts`

## packages/core

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/core/src

- `app.ts`
- `index.ts`
- `lifecycle.ts`
- `node.ts`

## packages/core/test

- `app.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `lifecycle.test.ts`
- `node-process.test.ts`
- `node.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/core/test/smoke

- `package-smoke.ts`

## packages/create

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/create/src

- `cli-run.ts`
- `cli.ts`
- `index.ts`
- `project.ts`
- `templates.ts`

## packages/create/test

- `cli.test.ts`
- `coverage-contract.ts`
- `create.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/croner

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/croner/src

- `errors.ts`
- `index.ts`
- `server.ts`
- `types.ts`

## packages/croner/test

- `construction.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `lifecycle.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/croner/test/e2e

- `native-e2e.ts`

## packages/croner/test/runtime

- `deno-runtime.ts`
- `published-runtime.fixture.ts`

## packages/croner/test/smoke

- `package-smoke.ts`

## packages/elysia

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/elysia/src

- `index.ts`

## packages/elysia/test

- `coverage-contract.ts`
- `handler.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/event

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/event/src

- `index.ts`

## packages/event/test

- `coverage-contract.ts`
- `event.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`

## packages/h3

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/h3/src

- `index.ts`

## packages/h3/test

- `coverage-contract.ts`
- `handler.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/health

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/health/src

- `index.ts`
- `registry.ts`

## packages/health/test

- `cancellation.test.ts`
- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `registry.test.ts`
- `source-policy.test.ts`

## packages/health/test/smoke

- `package-smoke.ts`

## packages/hono

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/hono/src

- `index.ts`

## packages/hono/test

- `coverage-contract.ts`
- `handler.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/metadata

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/metadata/src

- `index.ts`

## packages/metadata/test

- `context.test.ts`
- `coverage-contract.ts`
- `metadata.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`

## packages/metadata/test/smoke

- `package-smoke.ts`

## packages/nats

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/nats/src

- `broker-message.ts`
- `broker-runtime.ts`
- `broker.ts`
- `index.ts`
- `jetstream-broker.ts`
- `jetstream.ts`
- `server.ts`

## packages/nats/test

- `broker-helpers.ts`
- `broker-internal.test.ts`
- `broker-public-api.test.ts`
- `broker-public-types.ts`
- `broker.test.ts`
- `core-lifecycle.test.ts`
- `core-package-contract.test.ts`
- `core-public-api.test.ts`
- `core-public-types.ts`
- `core-source-policy.test.ts`
- `core-upstream-types-repro.ts`
- `coverage-contract.ts`
- `jetstream-broker-public-api.test.ts`
- `jetstream-broker-public-types.ts`
- `jetstream-broker.test.ts`
- `jetstream-lifecycle.test.ts`
- `jetstream-package-contract.test.ts`
- `jetstream-public-api.test.ts`
- `jetstream-public-types.ts`
- `jetstream-source-policy.test.ts`
- `jetstream-upstream-types-repro.ts`

## packages/nats/test/e2e

- `core-docker-e2e.ts`
- `jetstream-docker-e2e.ts`

## packages/nats/test/smoke

- `core-package-smoke.ts`
- `jetstream-package-smoke.ts`

## packages/otel

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.e2e.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/otel/src

- `broker.ts`
- `client.ts`
- `errors.ts`
- `index.ts`
- `instrumentation.ts`
- `runtime.ts`
- `server.ts`
- `types.ts`

## packages/otel/test

- `client-fixture.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `instrumentation.test.ts`
- `metrics.test.ts`
- `official.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `runtime.test.ts`
- `source-policy.test.ts`

## packages/otel/test/e2e

- `collector-0.156.0-report.md`
- `collector-0.157.0-report.md`
- `collector.yaml`
- `docker-e2e.ts`
- `instrumentation-docker.ts`

## packages/otel/test/smoke

- `runtime-smoke.ts`

## packages/pino

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/pino/src

- `errors.ts`
- `index.ts`
- `logging.ts`
- `runtime.ts`
- `thread-stream-node26-compat.ts`
- `types.ts`

## packages/pino/test

- `coverage-contract.ts`
- `helpers.ts`
- `logging.test.ts`
- `package-contract.test.ts`
- `provenance.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `published-runtime.test.ts`
- `runtime.test.ts`
- `source-policy.test.ts`

## packages/pino/test/e2e

- `native-e2e.ts`

## packages/pino/test/integration

- `published-install.ts`

## packages/pino/test/smoke

- `runtime-smoke.ts`

## packages/prometheus

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/prometheus/src

- `index.ts`

## packages/prometheus/test

- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `registry-handler.test.ts`
- `request-metrics.test.ts`
- `source-policy.test.ts`

## packages/prometheus/test/smoke

- `runtime-smoke.ts`

## packages/registry

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.published.json`
- `tsconfig.runtime.json`
- `tsconfig.test.json`

## packages/registry/consul

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/registry/consul/src

- `codec.ts`
- `discovery.ts`
- `errors.ts`
- `http.ts`
- `index.ts`
- `options.ts`
- `registration.ts`
- `runtime.ts`
- `types.ts`

## packages/registry/consul/test

- `codec.test.ts`
- `conformance.test.ts`
- `construction.test.ts`
- `consul-evidence.test.ts`
- `coverage-contract.ts`
- `discovery.test.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `published-runtime-cleanup.test.ts`
- `registration.test.ts`
- `registry-contract.test.ts`
- `runtime.test.ts`
- `source-policy.test.ts`

## packages/registry/consul/test/integration

- `consul-docker.ts`
- `consul-evidence.ts`
- `docker-cleanup.ts`
- `published-behavior.ts`
- `published-runtime.ts`

## packages/registry/etcd

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/registry/etcd/src

- `codec.ts`
- `discovery.ts`
- `errors.ts`
- `http.ts`
- `index.ts`
- `options.ts`
- `protocol.ts`
- `records.ts`
- `registration.ts`
- `runtime.ts`
- `types.ts`

## packages/registry/etcd/test

- `boundaries.test.ts`
- `codec.test.ts`
- `conformance.test.ts`
- `construction.test.ts`
- `coverage-contract.ts`
- `discovery-boundaries.test.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `protocol.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `records.test.ts`
- `registration-boundaries.test.ts`
- `registration-manager.test.ts`
- `registry.test.ts`
- `source-policy.test.ts`

## packages/registry/etcd/test/integration

- `etcd-docker.ts`
- `published-behavior.ts`
- `published-runtime.ts`

## packages/registry/kubernetes

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/registry/kubernetes/src

- `codec.ts`
- `discovery.ts`
- `errors.ts`
- `http.ts`
- `index.ts`
- `options.ts`
- `protocol.ts`
- `records.ts`
- `registration.ts`
- `runtime.ts`
- `types.ts`

## packages/registry/kubernetes/test

- `boundaries.test.ts`
- `codec.test.ts`
- `conformance.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `public-types.ts`
- `records.test.ts`
- `registry.test.ts`
- `runtime.test.ts`

## packages/registry/kubernetes/test/integration

- `k3s-docker.ts`
- `published-behavior.ts`

## packages/registry/mdns

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.portable.json`
- `tsconfig.test.json`

## packages/registry/mdns/src

- `base32.ts`
- `cache.ts`
- `canonical.ts`
- `codec.ts`
- `dns.ts`
- `errors.ts`
- `index.ts`
- `node-host.ts`
- `node.ts`
- `options.ts`
- `registration.ts`
- `registry.ts`
- `testing.ts`
- `token-stack.ts`
- `types.ts`
- `watcher.ts`

## packages/registry/mdns/test

- `alias-evidence.test.ts`
- `cache.test.ts`
- `codec.test.ts`
- `conformance.test.ts`
- `coverage-contract.ts`
- `dns.test.ts`
- `node-host.test.ts`
- `options.test.ts`
- `package-contract.test.ts`
- `packet-capture.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `registration.test.ts`
- `registry-boundaries.test.ts`
- `source-policy.test.ts`
- `testing.test.ts`
- `token-stack.test.ts`
- `watcher.test.ts`

## packages/registry/mdns/test/e2e

- `alias-evidence.ts`
- `compose.ipv4.yaml`
- `compose.ipv6.yaml`
- `docker-e2e.ts`
- `loader.ts`
- `observer.ts`
- `packet-capture.ts`
- `publisher.ts`
- `scenario.ts`

## packages/registry/mdns/test/runtime

- `node-runtime.ts`
- `portable-runtime.test.ts`
- `portable-runtime.ts`

## packages/registry/mdns/test/smoke

- _（当前目录无直属文件）_

## packages/registry/src

- `errors.ts`
- `index.ts`
- `options.ts`
- `provider.ts`
- `selector.ts`
- `snapshot.ts`
- `testing.ts`
- `types.ts`

## packages/registry/test

- `conformance.test.ts`
- `coverage-contract.ts`
- `errors.test.ts`
- `helpers.ts`
- `options.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `published-types.ts`
- `selector.test.ts`
- `snapshot.test.ts`

## packages/registry/zookeeper

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/registry/zookeeper/src

- `changes.ts`
- `codec.ts`
- `discovery.ts`
- `errors.ts`
- `index.ts`
- `native.ts`
- `options.ts`
- `records.ts`
- `registration.ts`
- `runtime.ts`
- `tree.ts`
- `types.ts`

## packages/registry/zookeeper/test

- `codec-records.test.ts`
- `conformance.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `native.test.ts`
- `options-errors-runtime.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `registry.test.ts`
- `source-policy.test.ts`

## packages/registry/zookeeper/test/integration

- `published-behavior.ts`
- `published-runtime.ts`
- `zookeeper-docker.ts`

## packages/resilience

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/resilience/src

- `circuit.ts`
- `errors.ts`
- `index.ts`
- `internal.ts`
- `limiter.ts`
- `retry.ts`
- `types.ts`

## packages/resilience/test

- `backoff.test.ts`
- `circuit.test.ts`
- `coverage-contract.ts`
- `errors.test.ts`
- `helpers.ts`
- `internal.test.ts`
- `limiter.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `retry.test.ts`
- `source-policy.test.ts`

## packages/resilience/test/smoke

- `package-smoke.ts`

## packages/server

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/server/src

- `index.ts`

## packages/server/test

- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `server.test.ts`
- `source-policy.test.ts`

## packages/store

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/store/consul

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/store/consul/src

- `codec.ts`
- `errors.ts`
- `http.ts`
- `index.ts`
- `options.ts`
- `store.ts`
- `types.ts`

## packages/store/consul/test

- `codec.test.ts`
- `conformance.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `http.test.ts`
- `options-errors.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `store.test.ts`

## packages/store/consul/test/integration

- `consul-2.0.2-report.md`
- `consul-docker.ts`

## packages/store/etcd

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/store/etcd/src

- `codec.ts`
- `errors.ts`
- `http.ts`
- `index.ts`
- `options.ts`
- `protocol.ts`
- `store.ts`
- `types.ts`

## packages/store/etcd/test

- `codec.test.ts`
- `conformance.test.ts`
- `construction.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `http.test.ts`
- `options-errors.test.ts`
- `package-contract.test.ts`
- `protocol.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `store.test.ts`

## packages/store/etcd/test/integration

- `etcd-3.7.0-report.md`
- `etcd-3.7.1-report.md`
- `etcd-docker.ts`
- `runtime-matrix-report.md`
- `runtime-matrix.ts`

## packages/store/file

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/store/file/src

- `index.ts`
- `node-host.ts`
- `node.ts`
- `store.ts`
- `types.ts`

## packages/store/file/test

- `conformance.test.ts`
- `coverage-contract.ts`
- `file-store.test.ts`
- `helpers.ts`
- `lifecycle.test.ts`
- `node-host.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `store-boundaries.test.ts`

## packages/store/memory

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/store/memory/src

- `index.ts`
- `store.ts`

## packages/store/memory/test

- `conformance.test.ts`
- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `store-internal.test.ts`
- `store.test.ts`

## packages/store/src

- `errors.ts`
- `index.ts`
- `options.ts`
- `provider.ts`
- `snapshot.ts`
- `testing.ts`
- `types.ts`

## packages/store/test

- `conformance.test.ts`
- `coverage-contract.ts`
- `errors.test.ts`
- `helpers.ts`
- `options.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `snapshot.test.ts`

## packages/store/vault

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/store/vault/src

- `codec.ts`
- `errors.ts`
- `http.ts`
- `index.ts`
- `options.ts`
- `store.ts`
- `types.ts`

## packages/store/vault/test

- `boundary.test.ts`
- `conformance.test.ts`
- `coverage-contract.ts`
- `helpers.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `store.test.ts`

## packages/store/vault/test/integration

- `vault-2.0.3-report.md`
- `vault-docker.ts`

## packages/testing

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/testing/src

- `index.ts`
- `listener.ts`
- `server.ts`

## packages/testing/test

- `coverage-contract.ts`
- `listener.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `server.test.ts`
- `source-policy.test.ts`

## packages/testing/test/smoke

- _（当前目录无直属文件）_

## packages/transport

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/transport/http

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/transport/http/src

- `address.ts`
- `client.ts`
- `errors.ts`
- `headers.ts`
- `index.ts`
- `listener.ts`
- `node-client.ts`
- `node-host.ts`
- `node.ts`
- `options.ts`
- `socket.ts`
- `transport-info.ts`
- `transport.ts`
- `types.ts`

## packages/transport/http/test

- `address.test.ts`
- `client.test.ts`
- `coverage-contract.ts`
- `listener.test.ts`
- `node-client-boundary.test.ts`
- `node-host.test.ts`
- `node-secure-host.test.ts`
- `node-transport.test.ts`
- `options.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `wire.test.ts`

## packages/transport/http/test/e2e

- `node-e2e.ts`
- `node-secure-e2e.ts`
- `node-security-docker.ts`
- `node-security-report.md`
- `run-node-e2e.ts`

## packages/transport/http/test/fixtures

- _（当前目录无直属文件）_

## packages/transport/http/test/fixtures/tls

- `ca.pem`
- `client-key.pem`
- `client.pem`
- `server-key.pem`
- `server.pem`

## packages/transport/http/test/runtime

- `cleanup-matrix.ts`
- `portable-runtime.ts`

## packages/transport/http/test/smoke

- `package-smoke.ts`

## packages/transport/memory

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/transport/memory/src

- `index.ts`
- `options.ts`
- `testing.ts`
- `transport-info.ts`
- `transport.ts`
- `types.ts`

## packages/transport/memory/test

- `conformance.test.ts`
- `coverage-contract.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `transport.test.ts`

## packages/transport/memory/test/runtime

- `portable-runtime.ts`

## packages/transport/memory/test/smoke

- `package-smoke.ts`

## packages/transport/src

- `endpoint.ts`
- `errors.ts`
- `headers.ts`
- `index.ts`
- `json.ts`
- `message.ts`
- `metadata.ts`
- `middleware.ts`
- `options.ts`
- `provider.ts`
- `testing.ts`
- `transport-info.ts`
- `types.ts`

## packages/transport/test

- `conformance.test.ts`
- `coverage-contract.ts`
- `endpoint.test.ts`
- `errors.test.ts`
- `message.test.ts`
- `metadata-wire.test.ts`
- `middleware.test.ts`
- `negative-types.ts`
- `options.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`
- `transport-info.test.ts`

## packages/transport/test/runtime

- `options-fixture.ts`
- `portable-runtime.ts`

## packages/transport/test/smoke

- `package-smoke.ts`

## packages/web

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/web/src

- `context.ts`
- `health.ts`
- `index.ts`
- `node-errors.ts`
- `node-server.ts`
- `node.ts`

## packages/web/test

- `context-handler-cleanup.test.ts`
- `context-handler-factory-validation.test.ts`
- `context-handler-passthrough.test.ts`
- `context-handler-request-abort.test.ts`
- `context-handler-timeout.test.ts`
- `coverage-contract.ts`
- `health.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/web/test/e2e

- `native-e2e.ts`

## packages/web/test/node

- `host.test.ts`
- `lifecycle.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `source-policy.test.ts`

## packages/web/test/node/smoke

- `dist-smoke.ts`

## packages/web/test/runtime

- `portable-runtime.ts`

## packages/web/test/smoke

- `package-smoke.ts`

## packages/winston

- `LICENSE`
- `README.md`
- `bunfig.toml`
- `capability.json`
- `owner.json`
- `package.json`
- `tsconfig.json`
- `tsconfig.test.json`

## packages/winston/src

- `errors.ts`
- `index.ts`
- `logging.ts`
- `server.ts`
- `types.ts`

## packages/winston/test

- `coverage-contract.ts`
- `helpers.ts`
- `logging.test.ts`
- `package-contract.test.ts`
- `public-api.test.ts`
- `public-types.ts`
- `runtime.test.ts`
- `source-policy.test.ts`

## packages/winston/test/smoke

- `runtime-smoke.ts`

## schemas

- `capability-manifest.schema.json`
- `gate-result.schema.json`
- `owner-manifest.schema.json`

## scripts

- `annotate-dist.cli.ts`
- `annotate-dist.test.ts`
- `annotate-dist.ts`
- `changeset-required.cli.ts`
- `changeset-required.ts`
- `clean-generated.cli.ts`
- `clean-generated.ts`
- `example-program-port.ts`
- `file-inventory.test.ts`
- `file-inventory.ts`
- `format-scope.test.ts`
- `generate-file-inventory.cli.ts`
- `generated-artifacts.test.ts`
- `package-dist.test.ts`
- `package-dist.ts`
- `provider-docker-gate.cli.ts`
- `release-config.test.ts`
- `release-preflight.cli.ts`
- `release-preflight.ts`
- `soak.cli.ts`
- `soak.test.ts`
- `verify-dist.cli.ts`
- `verify-dist.ts`
- `verify-example-programs.cli.ts`
- `verify-example-programs.test.ts`
- `verify-workspace.cli.ts`
- `verify-workspace.test.ts`
- `verify-workspace.ts`

## scripts/published

- `build-stamp.cli.ts`
- `build-stamp.ts`
- `business-cases.ts`
- `cli.ts`
- `contracts.ts`
- `coverage.ts`
- `inventory.ts`
- `process.ts`
- `runner.ts`
- `workspace-coverage.cli.ts`
- `workspace-coverage.ts`

## test

- `ci-workflow.test.ts`
- `core-web-lifecycle.test.ts`
- `doc-site.test.ts`
- `repository-contract.test.ts`

## test/fixtures

- `2026-07-19-migration-baseline.json`

## test/published

- `business-cases.ts`
- `published.test.ts`

## test/published/cases

- `completion.ts`
- `identity.ts`
- `integrations.ts`
- `node-services.ts`
- `portable.ts`

## tools

- _（当前目录无直属文件）_

## tools/boundaries

- `module-syntax.fixture.cli.ts`
- `module-syntax.test.ts`
- `module-syntax.ts`
- `project-session.fixture.cli.ts`
- `project-session.probe.cli.ts`
- `project-session.test.ts`
- `project-session.ts`
- `semantic-global.fixture.cli.ts`
- `semantic-global.test.ts`
- `semantic-global.ts`

## tools/boundaries/fixtures

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/module-syntax

- `cases.json`

## tools/boundaries/fixtures/module-syntax/invalid

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/module-syntax/invalid/absolute-and-hash

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/absolute-and-hash/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/absolute-and-hash/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/direct-require

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/direct-require/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/direct-require/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-framework

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-framework/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-framework/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-vendor

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-vendor/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-vendor/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-workspace

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-workspace/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/disallowed-workspace/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/dynamic-nonliteral

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/dynamic-nonliteral/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/dynamic-nonliteral/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/import-equals

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/import-equals/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/import-equals/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/import-type-policy

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/import-type-policy/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/import-type-policy/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/module-require

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/module-require/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/module-require/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/parenthesized-require

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/parenthesized-require/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/parenthesized-require/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/policy-subpath-not-exact

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/policy-subpath-not-exact/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/policy-subpath-not-exact/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/relative-extension-present

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/relative-extension-present/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/relative-extension-present/project/src

- `index.source`

## tools/boundaries/fixtures/module-syntax/invalid/relative-missing-js

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/module-syntax/invalid/relative-missing-js/project

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/module-syntax/invalid/relative-missing-js/project/src

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/module-syntax/invalid/relative-package-escape

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/relative-package-escape/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/relative-package-escape/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/relative-target-missing

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/relative-target-missing/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/relative-target-missing/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/schemes

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/schemes/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/schemes/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/invalid/type-only-policy

- `policy.json`

## tools/boundaries/fixtures/module-syntax/invalid/type-only-policy/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/invalid/type-only-policy/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/valid

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/module-syntax/valid/allowed-workspace-exact

- `policy.json`

## tools/boundaries/fixtures/module-syntax/valid/allowed-workspace-exact/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/valid/allowed-workspace-exact/project/src

- `index.ts`

## tools/boundaries/fixtures/module-syntax/valid/dynamic-literal-internal

- `policy.json`

## tools/boundaries/fixtures/module-syntax/valid/dynamic-literal-internal/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/valid/dynamic-literal-internal/project/src

- `index.ts`
- `value.ts`

## tools/boundaries/fixtures/module-syntax/valid/export-from-internal

- `policy.json`

## tools/boundaries/fixtures/module-syntax/valid/export-from-internal/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/valid/export-from-internal/project/src

- `index.ts`
- `value.ts`

## tools/boundaries/fixtures/module-syntax/valid/static-internal

- `policy.json`

## tools/boundaries/fixtures/module-syntax/valid/static-internal/project

- `tsconfig.json`

## tools/boundaries/fixtures/module-syntax/valid/static-internal/project/src

- `index.ts`
- `value.ts`

## tools/boundaries/fixtures/project-session

- `cases.json`

## tools/boundaries/fixtures/project-session/diagnostic

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/diagnostic/bind-and-semantic

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/diagnostic/bind-and-semantic/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/diagnostic/bind-and-semantic/project/src

- `index.ts`

## tools/boundaries/fixtures/project-session/diagnostic/config-file-parsing

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/diagnostic/config-file-parsing/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/diagnostic/config-file-parsing/project/src

- `index.ts`

## tools/boundaries/fixtures/project-session/diagnostic/global

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/diagnostic/global/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/diagnostic/global/project/src

- `index.ts`

## tools/boundaries/fixtures/project-session/diagnostic/program

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/diagnostic/program/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/diagnostic/program/project/src

- `index.ts`

## tools/boundaries/fixtures/project-session/diagnostic/semantic

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/diagnostic/semantic/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/diagnostic/semantic/project/src

- `index.ts`

## tools/boundaries/fixtures/project-session/diagnostic/syntactic

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/diagnostic/syntactic/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/diagnostic/syntactic/project/src

- `index.ts`

## tools/boundaries/fixtures/project-session/invalid

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/invalid/missing-exact-config

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/invalid/missing-exact-config/project

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/invalid/missing-exact-config/project/src

- `index.ts`

## tools/boundaries/fixtures/project-session/invalid/zero-package-source

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/invalid/zero-package-source/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/invalid/zero-package-source/project/src

- `README.md`

## tools/boundaries/fixtures/project-session/valid

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/valid/project

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/project-session/valid/project/project

- `tsconfig.json`

## tools/boundaries/fixtures/project-session/valid/project/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global

- `cases.json`

## tools/boundaries/fixtures/semantic-global/invalid

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/semantic-global/invalid/allowlisted-unresolved

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/allowlisted-unresolved/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/allowlisted-unresolved/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/ambient-declaration

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/ambient-declaration/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/ambient-declaration/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/eval

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/eval/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/eval/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-buffer

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-buffer/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-buffer/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-bun

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-bun/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-bun/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-deno

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-deno/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-deno/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-dirname

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-dirname/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-dirname/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-exports

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-exports/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-exports/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-filename

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-filename/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-filename/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-global

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-global/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-global/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-module

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-module/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-module/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-process

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-process/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-process/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/free-require

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-require/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/free-require/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/function-constructor

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/function-constructor/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/function-constructor/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-call-escape

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-call-escape/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-call-escape/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-chained-alias

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-chained-alias/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-chained-alias/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-computed

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-computed/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-computed/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-destructure

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-destructure/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-destructure/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-direct-alias

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-direct-alias/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-direct-alias/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-property

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-property/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-property/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-reassignment

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-reassignment/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-reassignment/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-return-escape

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-return-escape/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/global-this-return-escape/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/triple-slash-types

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/triple-slash-types/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/triple-slash-types/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/ts-ignore

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/ts-ignore/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/ts-ignore/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/ts-nocheck

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/ts-nocheck/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/ts-nocheck/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/unallowlisted-math

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/unallowlisted-math/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/unallowlisted-math/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/invalid/unknown-global

- `policy.json`

## tools/boundaries/fixtures/semantic-global/invalid/unknown-global/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/invalid/unknown-global/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/valid

- _（当前目录无直属文件）_

## tools/boundaries/fixtures/semantic-global/valid/allowlisted-console

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/allowlisted-console/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/allowlisted-console/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/valid/global-this-console-dot

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/global-this-console-dot/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/global-this-console-dot/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/valid/global-this-console-element

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/global-this-console-element/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/global-this-console-element/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/valid/imported-declarations

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/imported-declarations/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/imported-declarations/project/src

- `index.ts`
- `value.ts`

## tools/boundaries/fixtures/semantic-global/valid/labels

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/labels/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/labels/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/valid/local-declarations

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/local-declarations/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/local-declarations/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/valid/property-keys

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/property-keys/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/property-keys/project/src

- `index.ts`

## tools/boundaries/fixtures/semantic-global/valid/type-positions

- `policy.json`

## tools/boundaries/fixtures/semantic-global/valid/type-positions/project

- `tsconfig.json`

## tools/boundaries/fixtures/semantic-global/valid/type-positions/project/src

- `index.ts`

## tools/boundaries/probes

- _（当前目录无直属文件）_

## tools/boundaries/probes/project-session

- `admission-failure.json`
- `api-cleanup.json`
- `cases.json`
- `external-source.json`
- `input-invalid-path.json`
- `input-invalid-prefix.json`
- `materialization-failure.json`
- `primary-error.json`
- `primary-plus-all-cleanups.json`
- `primary-undefined.json`
- `project-count-multiple.json`
- `project-count-zero.json`
- `project-identity.json`
- `remove-after.json`
- `remove-before.json`
- `snapshot-cleanup.json`
- `source-realpath-escape.json`
- `success.json`
- `update-after-snapshot.json`
- `update-before-snapshot.json`
- `value-plus-all-cleanups.json`

## tools/gates

- `atomic-writer.ts`
- `fixture-corpus.test.ts`
- `fixture-corpus.ts`
- `protocol-probe.cli.ts`
- `result.test.ts`
- `result.ts`

## tools/manifests

- `capability-vocabulary.ts`
- `check.cli.ts`
- `validate.test.ts`
- `validate.ts`

## tools/manifests/fixtures

- `cases.json`

## tools/manifests/fixtures/application-owned

- _（当前目录无直属文件）_

## tools/manifests/fixtures/application-owned/structural-server

- _（当前目录无直属文件）_

## tools/manifests/fixtures/application-owned/structural-server/examples

- _（当前目录无直属文件）_

## tools/manifests/fixtures/application-owned/structural-server/examples/custom-server

- `contract-consumer.ts`
- `dist-test.virtual.json`
- `server.ts`

## tools/manifests/fixtures/invalid

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/adapter-under-packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/adapter-under-packages/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/adapter-under-packages/packages/adapter-under-packages-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/node-lanes

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/node-lanes/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/node-lanes/packages/node-lanes-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/package-mismatch

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/package-mismatch/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/package-mismatch/packages/package-mismatch-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/residency-conflict

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/residency-conflict/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/residency-conflict/packages/residency-conflict-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/resource-duplicate

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-duplicate/adapters

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-duplicate/adapters/resource-duplicate-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/resource-missing

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-missing/adapters

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-missing/adapters/resource-missing-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/resource-native-conflict

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-native-conflict/adapters

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-native-conflict/adapters/resource-native-conflict-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/resource-stop-conflict

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-stop-conflict/adapters

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/resource-stop-conflict/adapters/resource-stop-conflict-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/runtime-set

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/runtime-set/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/runtime-set/packages/runtime-set-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/runtime-version

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/runtime-version/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/runtime-version/packages/runtime-version-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/schema

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/schema/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/schema/packages/schema-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/invalid/terminal-observability

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/terminal-observability/adapters

- _（当前目录无直属文件）_

## tools/manifests/fixtures/invalid/terminal-observability/adapters/terminal-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/valid

- _（当前目录无直属文件）_

## tools/manifests/fixtures/valid/portable

- _（当前目录无直属文件）_

## tools/manifests/fixtures/valid/portable-resident

- _（当前目录无直属文件）_

## tools/manifests/fixtures/valid/portable-resident/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/valid/portable-resident/packages/portable-resident-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/valid/portable/packages

- _（当前目录无直属文件）_

## tools/manifests/fixtures/valid/portable/packages/portable-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/manifests/fixtures/valid/resident-adapter

- _（当前目录无直属文件）_

## tools/manifests/fixtures/valid/resident-adapter/adapters

- _（当前目录无直属文件）_

## tools/manifests/fixtures/valid/resident-adapter/adapters/resident-fixture

- `capability.json`
- `owner.json`
- `package.json`

## tools/runtime

- `runtime-manifest.cli.ts`
- `runtime-manifest.test.ts`
- `runtime-manifest.ts`

## tools/workspaces

- `discovery.test.ts`
- `discovery.ts`
