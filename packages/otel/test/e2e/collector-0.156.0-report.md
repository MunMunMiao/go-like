# OpenTelemetry Collector 0.156.0 真实 Docker 验证报告

- 执行日期：2026-07-24（Asia/Shanghai）
- 命令：`LIKEGO_E2E_OWNER=likego-codex-20260724 bun run --filter '@likego/otel' e2e:docker`
- Docker Server：29.6.2
- Collector：`otel/opentelemetry-collector-contrib@sha256:125bdbeb7590cc1952c5b3430ecf14063568980c2c93d5b38676cc0446ed8108`
- Collector 实测版本：0.156.0
- OpenTelemetry SDK：2.10.0
- 最终结果：两个真实服务套件均以退出码 0 完成

验证由两个顺序执行的真实服务套件组成。

第一套向 Collector 的 OTLP/HTTP 端点发送真实 traces 与 metrics；停止 Collector 后确认 exporter
失败不会阻塞业务，再启动同一个固定镜像并确认恢复导出。最后由 LikeGo 生命周期触发 provider shutdown，
证明 trace 与 metric 均完成 flush，且 shutdown span 只导出一次。

第二套启动真实 Collector、Node HTTP unary server、`@likego/client` 与
`@likego/transport-http`，并额外通过 `Bun.serve` 承载标准 Web `Request -> Response` Handler。
AsyncLocalStorage Context Manager 与 W3C propagator 实测形成两条独立 trace：

```text
unary root
└── likego.client <service>/Trace
    └── likego.server <service>/Trace

web root
└── POST
```

标准 Web Handler 入口处的 `Request.bodyUsed` 与 `Request.body.locked` 都为 `false`；应用读取
`Response` 之前，其 `bodyUsed` 与 `body.locked` 也都为 `false`。随后由应用显式读取并核对完整请求体与
响应体，证明插桩没有接管 body ownership。

本次机器可读结果：

```text
LIKEGO_OTEL_E2E_RESULT={"schemaVersion":1,"valid":true,"package":"@likego/otel","scenarios":["otlp-traces-and-metrics-export","collector-outage-does-not-block-business","collector-restart-recovers-export","shutdown-flushes-both-signals","no-duplicate-shutdown-span"],"scenarioEvidence":{"otlp-traces-and-metrics-export":{"tracesReceived":true,"metricsReceived":true,"applicationResourceReceived":true},"collector-outage-does-not-block-business":{"businessProgress":2,"traceFailureObserved":true,"metricFailureObserved":true},"collector-restart-recovers-export":{"collectorRestarted":true,"recoveredTrace":true,"recoveredMetric":true},"shutdown-flushes-both-signals":{"traceFlushed":true,"metricFlushed":true},"no-duplicate-shutdown-span":{"shutdownSpanCount":1,"duplicateShutdownSpans":0}},"image":"otel/opentelemetry-collector-contrib@sha256:125bdbeb7590cc1952c5b3430ecf14063568980c2c93d5b38676cc0446ed8108","otelVersion":"2.10.0","version":"0.156.0","collectorVersion":"0.156.0","cleanupExitCode":0,"cleanupFailures":0,"residualContainers":0,"cleanup":{"remainingContainers":0,"duplicateShutdownSpans":0,"providersTerminal":true}}
LIKEGO_OTEL_INSTRUMENTATION_E2E_RESULT={"schemaVersion":1,"valid":true,"package":"@likego/otel","otelVersion":"2.10.0","collector":{"image":"otel/opentelemetry-collector-contrib@sha256:125bdbeb7590cc1952c5b3430ecf14063568980c2c93d5b38676cc0446ed8108","version":"0.156.0"},"scenarios":["client-http-server-parent-child","standard-web-handler-parent-child","otel-collector-export"],"traceId":"70d9763be1891e348f4382a593838bf9","webTraceId":"3697a1b898d9198f502a02c64b892045","collectorSpans":["likego.e2e.root.84862a5563fc4646a36536aa14780215","likego.client likego.otel.84862a5563fc4646a36536aa14780215/Trace","likego.server likego.otel.84862a5563fc4646a36536aa14780215/Trace","likego.e2e.web.root.84862a5563fc4646a36536aa14780215","POST"],"collectorSpanCount":5,"response":"response","scenarioEvidence":{"client-http-server-parent-child":{"traceId":"70d9763be1891e348f4382a593838bf9","chainSpanCount":3,"sameTrace":true,"clientParentRoot":true,"serverParentClient":true,"responseBody":"response","responseHeader":"ok"},"standard-web-handler-parent-child":{"traceId":"3697a1b898d9198f502a02c64b892045","chainSpanCount":2,"sameTrace":true,"handlerParentRoot":true,"requestBodyUsedAtHandlerEntry":false,"requestBodyLockedAtHandlerEntry":false,"responseBodyUsedBeforeOwnerRead":false,"responseBodyLockedBeforeOwnerRead":false,"requestBody":"web-request","responseBody":"web-response","collectorReceived":true},"otel-collector-export":{"collectorReceived":true,"spanCount":5}},"cleanup":{"unaryHttpTerminal":true,"webHttpTerminal":true,"providersTerminal":true,"residualContainers":0}}
```

两个 runner 都使用唯一容器名与回环地址随机端口。`finally` 路径会等待 unary HTTP server、
Bun Web server 和 telemetry providers 的真实终态，只删除本次创建的 Collector 容器，并按精确名称重新
查询。只有在容器残留为零且所有 cleanup 均成功后才输出通过标记。
