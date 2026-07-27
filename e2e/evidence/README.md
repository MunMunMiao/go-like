# 来源与引用边界

每个有来源依据的用例都会在 `e2e/cases/*.case.ts` 中，把自己的来源信息与可执行 runner 绑定放在一起。

证据策略仅保留链接：LikeGo 记录官方 URL，并以转述方式描述待测行为；不会复制源代码或大段逐字文档。
因此，每个用例都使用以下明确边界：

`Link only; behavior paraphrased; no verbatim source copied.`

中央清单会拒绝非 HTTPS 来源、未经审查的 host、缺失检索日期、重复的规范化场景、空断言、空清理证据、
未知 suite、少于 40 个用例或能力域覆盖不完整。GitHub 链接仅允许指向已经审查的上游仓库。

清单使用的官方来源类别如下：

| 能力 | 官方来源 |
| --- | --- |
| Go 风格 Context | [Go `context` 包](https://pkg.go.dev/context) |
| 结构化 Server | [go-kratos transport 契约](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/transport.go#L16-L25) |
| 优雅终止 | [Kubernetes Pod 生命周期](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination) |
| 健康检查 | [Kubernetes 探针](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/) |
| 标准 Fetch | [MDN Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) |
| 请求取消 | [MDN Request signal](https://developer.mozilla.org/en-US/docs/Web/API/Request/signal) |
| Node HTTP | [Node.js HTTP](https://nodejs.org/api/http.html) |
| Hono | [Hono app API](https://hono.dev/docs/api/hono) |
| Elysia | [Elysia handler and Web API boundary](https://elysiajs.com/essential/handler) |
| H3 | [H3 API](https://h3.dev/guide/api/h3) |
| Cron | [Croner 10.0.1 API](https://jsr.io/@hexagon/croner/doc) |
| 持久任务 | [BullMQ retry](https://docs.bullmq.io/guide/retrying-failing-jobs)、[stalled jobs](https://docs.bullmq.io/guide/jobs/stalled) 与 [workers](https://docs.bullmq.io/guide/workers) |
| NATS Core | [receiving](https://docs.nats.io/using-nats/developer/receiving)、[queue groups](https://docs.nats.io/using-nats/developer/receiving/queues) 与 [connecting](https://docs.nats.io/using-nats/developer/connecting) |
| JetStream | [JetStream](https://docs.nats.io/nats-concepts/jetstream) 与 [consumers](https://docs.nats.io/nats-concepts/jetstream/consumers) |
| Consul 配置 | [KV API](https://developer.hashicorp.com/consul/api-docs/kv) 与 [blocking queries](https://developer.hashicorp.com/consul/api-docs/features/blocking) |
| Consul 注册中心 | [service registration](https://developer.hashicorp.com/consul/commands/services/register)、[TTL checks](https://developer.hashicorp.com/consul/api-docs/agent/check) 与 [ACLs](https://developer.hashicorp.com/consul/docs/secure/acl) |
| 日志 | [Pino API](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md)、[Winston 3.19.0 README](https://github.com/winstonjs/winston/blob/v3.19.0/README.md) |
| 遥测 | [OpenTelemetry JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/) |
| Prometheus 指标 | [prom-client README](https://github.com/prometheus/client_js/blob/main/README.md) |
