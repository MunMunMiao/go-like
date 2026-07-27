# Health and observability

`@likego/health` keeps liveness and readiness separate. An empty liveness registry is healthy because the process itself is running. An empty readiness registry fails closed: a service should not receive traffic until at least one readiness probe exists and all registered readiness probes pass. The optional `@likego/web/health` handler exposes those results through standard Web responses.

Metrics and tracing are explicit. `@likego/prometheus` serves an application-owned `prom-client` registry and does not touch the global registry. `@likego/otel` accepts application-owned OpenTelemetry providers for lifecycle, and offers explicit wrappers for the LikeGo client, unary middleware, and broker. It does not install global providers, exporters, context managers, or automatic instrumentation.

Logging adapters follow the same rule. `@likego/pino` and `@likego/winston` accept native destinations or loggers and only manage the shutdown boundary. Levels, redaction, formats, transports, child loggers, and field policy remain in application code.

Bound label cardinality, never put credentials into attributes, and install a context manager supported by the chosen runtime before expecting asynchronous trace parentage. If telemetry export fails, lifecycle must still report that failure rather than silently claiming a clean stop.
