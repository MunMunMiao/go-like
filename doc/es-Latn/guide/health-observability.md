# Salud y observabilidad

`@go-like/health` trata liveness y readiness por separado. Un registro de liveness vacío está sano porque el proceso sigue vivo. Un registro de readiness vacío falla de forma segura: sin una prueba registrada todavía no conviene enviar tráfico. `@go-like/web/health` puede exponer ambos resultados como respuestas Web estándar. Sus rutas por defecto son `GET /livez` y `GET /readyz`: una respuesta sana es `200`, una fallida `503`, un método no permitido `405` y una ruta desconocida `404`. El registro liveness vacío devuelve `200` y el readiness vacío `503`; la aplicación debe montar el Handler en su propio router/host.

```ts
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"

const probes = newProbeRegistry()
const health = createHealthHandler(probes)
// Monta /livez y /readyz en el route table de la aplicación.
```

Usa `curl -i http://127.0.0.1:3000/livez` solo después de montar ese Handler en ese listener.

Métricas y trazas se montan explícitamente. `@go-like/prometheus` sirve un `Registry` de `prom-client` propiedad de la aplicación, sin tocar el global. `@go-like/otel` integra el ciclo de vida de providers OpenTelemetry creados por la aplicación y ofrece wrappers de Client, middleware unary y Broker; no instala providers, exporters, context managers ni instrumentación automática global.

Los logs siguen la misma idea. `@go-like/pino` y `@go-like/winston` gestionan únicamente el cierre del destination o logger nativo. Niveles, redacción, formatos, transports, child loggers y reglas de campos se quedan en la aplicación.

Limita la cardinalidad de labels y no metas secretos en attributes. Para conservar parentesco de trazas asíncronas instala un context manager compatible con el runtime. Si falla la exportación, el estado terminal debe contarlo; un apagado limpio no se consigue escondiendo errores.
