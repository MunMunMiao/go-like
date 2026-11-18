# الصحة وقابلية الرصد

فحوص الصحة والقياس عن بعد نقاط تركيب. ينشئ التطبيق سجل الفحوص، وأداة التسجيل، ومزوّدات OpenTelemetry SDK، وسجل Prometheus. يملك core سجلات وحدات العمل. تملأ Plugs العقود `LogHandler` و`TracerProvider` و`MeterProvider` و`Propagator`. لا شيء في هذا المسار يثبّت لك أداة تسجيل أو مقياساً أو متتبّعاً أو ناشر سياق عاماً.

## الحيوية والجاهزية

لـ `@go-like/core/health` نوعا فحص:

- `live`: هل تُعد العملية حية؟
- `ready`: هل تُقبل الحركة الآن؟

الحيوية الفارغة سليمة. وتفشل الجاهزية الفارغة مغلقة. عندما توجد فحوص جاهزية، يجب أن ينجح كل واحد منها.

```ts
import { readyProbe } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  if (ctx.err() !== null) throw ctx.err() as Error
  await policyServer.endpoint(ctx)
})

const health = createHealthHandler(probes)
const app = newApp(readyProbe(probes))
void health
void app
```

تعيد `register(kind, name, probe)` دالة إلغاء تسجيل متكافئة. المساران الافتراضيان هما `/livez` و`/readyz`. يقبل المعالج `GET` و`HEAD`، ويعيد 200 عندما ينجح التقرير، و503 عندما لا ينجح، و404 لأي مسار آخر، و405 للطرق الأخرى. تستخدم الاستجابات `Cache-Control: no-store`. وتبقى أخطاء الفحص خارج الجسم العام.

يسجّل `readyProbe(probes)` نافذة App على السجل نفسه تحت الاسم `"app"` ما لم تمرر اسماً آخر. ينجح الفحص فقط من لحظة اكتمال البدء حتى يبدأ `stop()`، مع المقياس `go_like.app.ready`. من دونه، أو من دون فحص جاهزية آخر، يبقى `/readyz` على 503. تلك هي قاعدة الإخفاق المغلق.

استدعِ `Handler` الصحة من موجّهك الخاص. ولا يركّبه core. تعمل `ProbeRegistry.check(...)` بلا أي سطح HTTP. يجيب مستمع `newServer` الأحادي أيضاً `GET` و`HEAD` على `/healthz` باستجابة 200 فارغة. يعني ذلك الفحص أن المستمع استقبل الطلب. وهو لا يشغّل سجل الفحوص.

## حزمة قياس واحدة

ابنِ كائنات SDK الأصلية بنفسك. كيّفها بدوال إنشاء Plug. مرّر الحزمة إلى `telemetry(tel)` على `newApp`. يسجّل core بعد ذلك وحدات RPC وHTTP والرسائل والمهام والإعداد والسجل ودورة الحياة. تستخدم شيفرة العمل `@go-like/core/log` و`inSpan` ومقابض المقاييس النمطية.

```ts
import { name, newApp, server, telemetry, version } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newTelemetry } from "@go-like/core/telemetry"
import { contextHandler } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"
import { newOtelMeterProvider, newOtelTracerProvider } from "@go-like/otel"
import { newPinoHandler } from "@go-like/pino/log"
import { context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import pino from "pino"

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

const sdkTracer = new TracerProvider({
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })]
})
const sdkMeter = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })]
})
const destination = pino.destination({ dest: 1, sync: false })
const logger = pino({ base: null, level: "info" }, destination)
const tel = newTelemetry({
  tracerProvider: newOtelTracerProvider(sdkTracer, { requireContextManager: true }),
  meterProviders: [newOtelMeterProvider(sdkMeter)],
  logHandlers: [newPinoHandler(logger, destination)],
  completionLogs: "failures",
  ignoreRequest: (request) => {
    const { pathname } = new URL(request.url)
    return pathname === "/livez" || pathname === "/readyz" || pathname === "/metrics"
  }
})

const web = newNodeServer(
  contextHandler(async () => Response.json({ ok: true })),
  port(8080)
)
export const app = newApp(signal(), name("shop"), version("v1"), telemetry(tel), server(web))
```

يجب أن تتلقى `newPinoHandler` كائن `destination` نفسه الذي بنى أداة التسجيل. تسقط `ignoreRequest` الوحدة كلها لمسارات الفحص والجمع، وهذا يُبقي فحوص Kubernetes خارج سجلات الاكتمال. ابنِ `Resource` في OpenTelemetry من ثابتي `name` و`version` نفسيهما اللذين تمررهما إلى `newApp`.

`completionLogs` هي `"failures"` أو `"all"`. مفاتيح سمات span والمقاييس مجموعة مغلقة. ولا يضع core رسائل الخطأ أو المكدسات أو الأسباب على spans أو تسميات المقاييس أو سجلات الاكتمال. قد ترفق أحداث التشخيص الكائن المحلي `Error` بوصفه `LogField.exception`. ويربط Plug ذلك الحقل بالخانة الأصلية.

### التمهيد قبل newApp

غالباً ما يجب أن يُحمَّل الإعداد قبل وجود الخوادم. تستطيع الحزمة أن تراقب ذلك العمل قبل أن يملكه App:

```ts
import { background, withTimeout } from "@go-like/core/context"
import { newTelemetry, withTelemetry } from "@go-like/core/telemetry"

const tel = newTelemetry({ logHandlers: [handler] })
const bootCtx = withTelemetry(background(), tel)
try {
  await config.load(bootCtx)
} catch (error) {
  const [ctx, cancel] = withTimeout(background(), 5_000)
  try {
    await tel.stop(ctx)
  } finally {
    cancel()
  }
  throw error
}
const app = newApp(telemetry(tel))
void app
```

تصرّف `Telemetry.stop` قبل `start` كل مزوّد من دون قبوله، ولا يمكن بدء الحزمة بعد ذلك. يستخدم script لا يستدعي `newApp` الدوال `withTelemetry` و`tel.start` و`tel.stop` مباشرة. تسجّل `newTelemetryRecorder` من `@go-like/core/testing` الـ spans والمقاييس والسجلات في الاختبارات.

## OpenTelemetry

يصدّر `@go-like/otel` الدوال `newOtelTracerProvider` و`newOtelMeterProvider` و`newOtelLogHandler` و`newOtelPropagator`. الاعتماد النظير هو `@opentelemetry/api`. ينشئ التطبيق مزوّدات SDK، ويسجّل مدير سياق، ويترك الناشر العام غير مضبوط. تسجيل واحد يمكن أن يكرّر `traceparent`.

يُوقف كل مزوّد مرة واحدة. انتظار الإيقاف الافتراضي هو `defaultOtelShutdownTimeoutMs` (25 ثانية). تفشل `shutdownTimeoutMs: 0` انتظار المالك فوراً. الأخطاء العامة هي `OtelAlreadyStartedError` (`GO_LIKE_OTEL_ALREADY_STARTED`) و`OtelShutdownTimeoutError` (`GO_LIKE_OTEL_SHUTDOWN_TIMEOUT`) و`OtelContextManagerMissingError` (`GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING`).

## Prometheus

يصدّر `@go-like/prometheus/metric` الدالتين `newPrometheusMeterProvider(registry)` و`createPrometheusHandler(registry, { path? })`. مرّر السجل الذي أنشأته. ولا يلمس Plug السجل العام. تسجّل `start` المقياس `target_info` من مورد App ثم تُحل. معالج الجمع هو Web `Handler` عادي: ركّبه على مضيف Web من core، في طبقة الخوادم، حتى يتوقف قبل طبقة القياس.

```ts
import { createPrometheusHandler, newPrometheusMeterProvider } from "@go-like/prometheus/metric"
import { Registry } from "prom-client"

const registry = new Registry()
const meters = newPrometheusMeterProvider(registry)
const metrics = createPrometheusHandler(registry)
void meters
void metrics
```

## Pino

يربط `newPinoHandler(logger, destination, ...options)` الحقل `LogField.exception` بمفتاح `err` في Pino. يكتب مسلسِل `err` الافتراضي في Pino مسبقاً `name` و`message` و`stack`. تضبط `pinoDrainTimeout(ms)` حد تصريف المالك. تتحقق دورة الحياة من أن `destination` هو التدفق الذي بُنيت به أداة التسجيل، ثم تفرّغه وتنهيه وتغلقه. الأخطاء: `GO_LIKE_PINO_ALREADY_STARTED` و`GO_LIKE_PINO_DRAIN_TIMEOUT` و`GO_LIKE_PINO_DESTINATION_CLOSED`.

## Winston

يربط `newWinstonHandler(logger)` الحقل `LogField.exception` بمفتاح `error` الأصلي في Winston. يسلسل `winston.format.json()` وحده الكائن `Error` إلى `{}`، فتختفي الرسالة والمكدس. ضع تنسيقاً يفهم `Error` قبل JSON. ولا يحتاج Pino إلى هذه الخطوة.

```ts
import { LogField, newTelemetry } from "@go-like/core/telemetry"
import { newWinstonHandler } from "@go-like/winston/log"
import winston from "winston"

const expandError = winston.format((info) => {
  const error: unknown = info.error
  if (error instanceof Error) {
    info.error = { name: error.name, message: error.message, stack: error.stack }
  }
  return info
})

const logger = winston.createLogger({
  format: winston.format.combine(expandError(), winston.format.json()),
  transports: [new winston.transports.Console()]
})

export const tel = newTelemetry({ logHandlers: [newWinstonHandler(logger)] })
void LogField
```

يعيد القبول ربط أداة التسجيل بـ `child(...)` من مورد App. تستدعي `stop` الدالة `logger.end()` وتنتظر `finish` أو `close`. لا يوجد إغلاق قسري لـ Winston ولا مهلة في Plug؛ `stopTimeout` في App هو انتظار المستدعي، والافتراضي غير محدود. الأخطاء: `GO_LIKE_WINSTON_ALREADY_STARTED` و`GO_LIKE_WINSTON_LOGGER_FINISHED` و`GO_LIKE_WINSTON_LOGGER_CLOSED`.

تمر سجلات العمل عبر `@go-like/core/log` (`log.info(ctx, message, attrs)`). تتلقى المعالجات النشطة `trace_id` و`span_id` و`trace_flags` عندما يكون span حالياً. يبقى حجب حقول التطبيق على أداة التسجيل الأصلية (`pino({ redact })`، وتنسيقات Winston).

## ما الذي يُسجَّل

تشمل وحدات core خادم RPC وعميله، وخادم HTTP، ونشر الرسائل ومعالجتها، وتشغيل المهمة وإدراجها، وتحميل الإعداد وإعادة تحميله، وتسجيل السجل ومراقبته، وإعادة المحاولة، وانتقالات القاطع، ورفض حد المعدل، وبدء App وجاهزيته وإيقافه وتوقفه وإخفاق المشارك. لا تُعطى استدعاءات Cache وStore وحدة core: يستدعي التطبيق Plug مباشرة. تُحذف عمليات جمع الصحة عندما تقول `ignoreRequest` ذلك.

مفاتيح السمات وأسماء المقاييس وأسماء أحداث السجل هي الثوابت على `@go-like/core/telemetry` (`SemconvVersion` هي `"1.45.0"`). تأتي سمات المقاييس فقط من `attributeKeys` المعلنة على `newCounter` و`newHistogram` و`newUpDownCounter` و`newGauge`. لا ينتمي موضوع أو URL أو معرّف مستخدم إلى مقياس.

عندما لا يُثبَّت `LogHandler`، تُكتب أحداث التشخيص من مستوى الخطأ سطراً JSON واحداً إلى `console.error` مع `event.name` و`error.type` و`go_like.operation`. ولا يتضمن السطر نص الخطأ. لا يوجد Plug لسجل وحدة التحكم.

## قائمة التحقق التشغيلية

- أنشأ التطبيق SDK وأداة التسجيل وسجل Prometheus.
- الناشر العام في OpenTelemetry غير مضبوط.
- `telemetry(tel)` على App، لا داخل `server(...)`.
- لدى `/readyz` فحص جاهزية حقيقي، بما في ذلك `readyProbe` عندما ينبغي للعملية أن تبلّغ نافذة App.
- مسارات الفحص والجمع مدرجة في `ignoreRequest` عندما تغرق سجلاتها الإشارة.
- يوسّع Winston الحقل `info.error` قبل `format.json()`.
- للتسميات وحقول السجل سياسة حجب على أداة التسجيل أو المصدّر الأصلي.
