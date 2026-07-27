# OpenTelemetry Collector 0.157.0 真实 Docker 验证报告

- 执行日期：2026-07-25（Asia/Shanghai）
- 命令：`LIKEGO_E2E_OWNER=version-refresh bun run --filter @likego/otel e2e:docker`
- Docker Server：29.6.2
- Collector：`otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6`
- Collector 实测版本：0.157.0
- OpenTelemetry SDK：2.10.0
- 最终结果：两个真实服务套件均以退出码 0 完成

第一套通过 OTLP/HTTP 验证 traces、metrics、Collector outage/restart、shutdown flush 与无重复 shutdown
span。第二套验证 unary Client → HTTP Server 和标准 Web Handler 的 W3C 父子链，并确认插桩未读取或锁定
request/response body。

本次机器可读结果：

```text
LIKEGO_OTEL_E2E_RESULT={"schemaVersion":1,"valid":true,"package":"@likego/otel","scenarios":["otlp-traces-and-metrics-export","collector-outage-does-not-block-business","collector-restart-recovers-export","shutdown-flushes-both-signals","no-duplicate-shutdown-span"],"scenarioEvidence":{"otlp-traces-and-metrics-export":{"tracesReceived":true,"metricsReceived":true,"applicationResourceReceived":true},"collector-outage-does-not-block-business":{"businessProgress":2,"traceFailureObserved":true,"metricFailureObserved":true},"collector-restart-recovers-export":{"collectorRestarted":true,"recoveredTrace":true,"recoveredMetric":true},"shutdown-flushes-both-signals":{"traceFlushed":true,"metricFlushed":true},"no-duplicate-shutdown-span":{"shutdownSpanCount":1,"duplicateShutdownSpans":0}},"image":"otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6","otelVersion":"2.10.0","version":"0.157.0","collectorVersion":"0.157.0","cleanupExitCode":0,"cleanupFailures":0,"residualContainers":0,"cleanup":{"remainingContainers":0,"duplicateShutdownSpans":0,"providersTerminal":true}}
LIKEGO_OTEL_INSTRUMENTATION_E2E_RESULT={"schemaVersion":1,"valid":true,"package":"@likego/otel","otelVersion":"2.10.0","collector":{"image":"otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6","version":"0.157.0"},"scenarios":["client-http-server-parent-child","standard-web-handler-parent-child","otel-collector-export"],"traceId":"369b409493549724c782c668859008d9","webTraceId":"65f8c81e5cf562302883ecbbe50f1e51","collectorSpans":["likego.e2e.root.78ff9421674d473480761720c9c9283a","likego.client likego.otel.78ff9421674d473480761720c9c9283a/Trace","likego.server likego.otel.78ff9421674d473480761720c9c9283a/Trace","likego.e2e.web.root.78ff9421674d473480761720c9c9283a","POST"],"collectorSpanCount":5,"response":"response","scenarioEvidence":{"client-http-server-parent-child":{"traceId":"369b409493549724c782c668859008d9","chainSpanCount":3,"sameTrace":true,"clientParentRoot":true,"serverParentClient":true,"responseBody":"response","responseHeader":"ok"},"standard-web-handler-parent-child":{"traceId":"65f8c81e5cf562302883ecbbe50f1e51","chainSpanCount":2,"sameTrace":true,"handlerParentRoot":true,"requestBodyUsedAtHandlerEntry":false,"requestBodyLockedAtHandlerEntry":false,"responseBodyUsedBeforeOwnerRead":false,"responseBodyLockedBeforeOwnerRead":false,"requestBody":"web-request","responseBody":"web-response","collectorReceived":true},"otel-collector-export":{"collectorReceived":true,"spanCount":5}},"cleanup":{"unaryHttpTerminal":true,"webHttpTerminal":true,"providersTerminal":true,"residualContainers":0}}
```

两个 runner 只删除本次创建的 Collector 容器；通过标记要求容器残留为零且所有 provider 与 HTTP server
达到真实终态。
