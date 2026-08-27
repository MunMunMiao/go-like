# Проверки и наблюдаемость

`@go-like/health` разделяет liveness и readiness. Пустой liveness registry считается исправным: процесс действительно жив. Пустой readiness registry закрыт для трафика, потому что без единой зарегистрированной проверки готовность не доказана. `@go-like/web/health` выдаёт результаты как стандартные Web responses. По умолчанию это `GET /livez` и `GET /readyz`: `200` при успехе, `503` при ошибке, `405` для неподдерживаемого метода и `404` для неизвестного пути. Пустой liveness registry даёт `200`, пустой readiness registry — `503`; приложение само монтирует Handler в свой router/host.

```ts
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"

const probes = newProbeRegistry()
const health = createHealthHandler(probes)
// Подключите /livez и /readyz к route table приложения.
```

Используйте `curl -i http://127.0.0.1:3000/livez` только после того, как этот Handler подключён к listener.

Метрики и трассировка подключаются явно. `@go-like/prometheus` обслуживает принадлежащий приложению `prom-client` Registry и не трогает глобальный. `@go-like/otel` управляет жизненным циклом созданных приложением OpenTelemetry providers и даёт wrappers для Client, unary middleware и Broker; глобальные providers, exporters, context managers и auto instrumentation он не устанавливает.

Для логов действует тот же принцип. `@go-like/pino` и `@go-like/winston` отвечают лишь за завершение нативного destination или logger. Levels, redaction, formats, transports, child loggers и политика полей остаются в приложении.

Ограничивайте cardinality labels и не помещайте секреты в attributes. Для асинхронной связи spans установите context manager, поддерживаемый runtime. Ошибка экспорта должна попасть в конечное состояние, а не исчезнуть ради красивого отчёта об остановке.
