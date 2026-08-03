# Salud y observabilidad

`@likego/health` trata liveness y readiness por separado. Un registro de liveness vacío está sano porque el proceso sigue vivo. Un registro de readiness vacío falla de forma segura: sin una prueba registrada todavía no conviene enviar tráfico. `@likego/web/health` puede exponer ambos resultados como respuestas Web estándar.

Métricas y trazas se montan explícitamente. `@likego/prometheus` sirve un `Registry` de `prom-client` propiedad de la aplicación, sin tocar el global. `@likego/otel` integra el ciclo de vida de providers OpenTelemetry creados por la aplicación y ofrece wrappers de Client, middleware unary y Broker; no instala providers, exporters, context managers ni instrumentación automática global.

Los logs siguen la misma idea. `@likego/pino` y `@likego/winston` gestionan únicamente el cierre del destination o logger nativo. Niveles, redacción, formatos, transports, child loggers y reglas de campos se quedan en la aplicación.

Limita la cardinalidad de labels y no metas secretos en attributes. Para conservar parentesco de trazas asíncronas instala un context manager compatible con el runtime. Si falla la exportación, el estado terminal debe contarlo; un apagado limpio no se consigue escondiendo errores.
