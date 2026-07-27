# Consul 2.0.2 Docker 集成验证报告

- 执行日期：2026-07-24（Asia/Shanghai）
- 验证命令：`LIKEGO_E2E_OWNER=config-ux bun run --filter @likego/config-consul test:docker`
- Docker Server：29.6.2
- 镜像：`hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2`
- 实测二进制：`Consul v2.0.2`
- 官方版本目录：https://releases.hashicorp.com/consul/
- 官方 KV API：https://developer.hashicorp.com/consul/api-docs/kv
- 官方 Blocking Query 规则：https://developer.hashicorp.com/consul/api-docs/features/blocking

验证器为每次执行创建唯一容器名和标签，使用操作系统分配的回环端口，并把
`/consul/data` 挂载到 64 MiB 的临时内存文件系统。停止、删除并重建 Consul 容器时，
Fetch origin 保持不变。验证过程不会删除无关镜像、卷、缓存或用户容器。

本轮机器可读结果如下：

```text
LIKEGO_CONFIG_CONSUL_E2E_RESULT={"schemaVersion":1,"valid":true,"package":"@likego/config-consul","scenarios":["consul-kv-initial-load","outage-preserves-last-good","restart-reconciles-new-index","blocking-query-publishes-change","config-close-and-container-clean"],"image":"hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2","version":"2.0.2","dockerServerVersion":"29.6.2","consulVersion":"Consul v2.0.2","observedVersion":"Consul v2.0.2","events":["container-started","consul-ready","binary-version-verified","kv-initial-written","config-initial-published","consul-stopped","last-good-preserved","consul-recovered","kv-reseeded","config-outage-reconciliation-published","kv-updated","config-blocking-change-published","config-closed","container-clean"],"fetchAttempts":14,"fetchFailures":5,"retryStatuses":[],"indexObservations":["load->200:78","load->200:78","78->200:78","78->200:14","load->200:14","load->200:14","14->200:19","load->200:19","load->200:19"],"publications":[1,2,3],"scenarioEvidence":{"consul-kv-initial-load":{"release":1,"revisionObserved":true},"restart-reconciles-new-index":{"release":2,"replacementValuePublished":true,"indexRegressionObserved":true,"revisionAdvanced":true},"blocking-query-publishes-change":{"release":3,"blockingRevisionAdvanced":true,"nestedValuePreserved":true},"outage-preserves-last-good":{"valueIdentityPreserved":true,"release":1,"featureEnabled":false,"fetchFailures":5,"retryStatuses":[],"outageFailureCount":5}},"cleanupExitCode":0,"cleanupFailures":0,"residualContainers":0,"cleanup":{"remainingContainers":0,"pendingTimers":0,"activeFetches":0,"activeBlockingFetches":0,"watcherTerminal":true}}
```

场景先对同一个 `app/config` key 连续写入，确保首个 Consul 实例的目标查询游标真实推进到
`78`，再恢复 release 1，并执行 `newConfig(source(consulSource(...)))` 与 `config.load(ctx)`。
这避免了把其他 KV key 的 Raft 变更错误地当作目标查询 index 的变更。容器被停止和删除后，
Config 在真实 Fetch 失败期间持续保留 release 1 的同一个 last-good value。

同一镜像在同一 origin 上以空数据重新启动后，目标查询返回 `14`，因此本轮真实观测到
`78 -> 14` 的 index 回退。适配器随后发布 release 2；再写入 release 3 后，由 blocking
query 触发第三次发布。最终发布顺序为 `[1, 2, 3]`。

`finally` 使用独立的 10 秒 Context 执行 `config.close(ctx)`。中央 E2E 契约确认：
容器、计时器、普通 Fetch、blocking Fetch 均无残留，watcher 已到达终态。
