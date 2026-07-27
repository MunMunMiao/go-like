# Проверки и наблюдаемость

`@likego/health` разделяет liveness и readiness. Пустой liveness registry считается исправным: процесс действительно жив. Пустой readiness registry закрыт для трафика, потому что без единой зарегистрированной проверки готовность не доказана. `@likego/web/health` выдаёт результаты как стандартные Web responses.

Метрики и трассировка подключаются явно. `@likego/prometheus` обслуживает принадлежащий приложению `prom-client` Registry и не трогает глобальный. `@likego/otel` управляет жизненным циклом созданных приложением OpenTelemetry providers и даёт wrappers для Client, unary middleware и Broker; глобальные providers, exporters, context managers и auto instrumentation он не устанавливает.

Для логов действует тот же принцип. `@likego/pino` и `@likego/winston` отвечают лишь за завершение нативного destination или logger. Levels, redaction, formats, transports, child loggers и политика полей остаются в приложении.

Ограничивайте cardinality labels и не помещайте секреты в attributes. Для асинхронной связи spans установите context manager, поддерживаемый runtime. Ошибка экспорта должна попасть в конечное состояние, а не исчезнуть ради красивого отчёта об остановке.
