# البنية

go-like طبقة تركيب. يعلن `@go-like/core` العقود من نوع Socket وينفّذ الآليات التي لا تحتاج إلى عميل من طرف ثالث. يملأ Plug عقد Socket. ينشئ التطبيق الكائن الأصلي، ويبني Plug، ويختار طبقة App التي تملكه.

السؤال المفيد هو: من يقبل هذا الكائن، وفي أي طبقة يجلس، ومن يراقب نتيجته النهائية، وأي بيئة تشغيل أو نظام خلفي يمنح تلك النتيجة معناها؟

## Socket وPlug

```text
Application composition root
  |
  +--> Context, metadata, struct, health, resilience     core mechanisms
  |
  +--> Lifecycle
  |      telemetry(tel) -> resources(...) -> server(...) -> registrar
  |
  +--> External Web
  |      Handler on @go-like/core/web
  |      host on @go-like/core/web/node or @go-like/core/web/bun
  |
  +--> Internal calls
  |      Client, Server, Transport
  |      memory and Fetch transports in core; gRPC on @go-like/connectrpc
  |
  +--> State
  |      Config, Registry, Store, Cache sockets
  |      memory references in core; Consul, etcd, Vault, Kubernetes,
  |      ZooKeeper, mDNS, YAML, Redis, and file plugs
  |
  +--> Messages and jobs
  |      Broker and Job sockets
  |      memory broker in core; NATS, RabbitMQ, BullMQ, and Croner plugs
  |
  +--> Telemetry sockets
         LogHandler, TracerProvider, MeterProvider, Propagator
         filled by @go-like/otel, @go-like/pino/log, @go-like/winston/log,
         @go-like/prometheus/metric
```

يسجّل core كل وحدة عمل في موقع استدعاء ثابت. ولا يغلّف Plug الدالة `newClient` أو معالج Web ليضيف span. يُفرض اتجاه الاستيراد داخل core عبر `test/portable-lane.test.ts`: الطبقات الأدنى لا تستورد المدخل الجذري.

## الطبقات الثلاث

تطبّق `newApp(...options)` الخيارات بترتيب الوسائط. لا يمكن أن يظهر الكائن نفسه في `resources(...)` و`server(...)` معاً. تمرير حزمة `Telemetry` إلى أي من القائمتين خطأ أنواع و`TypeError` في وقت التشغيل.

| الطبقة  | الخيار                                  | البدء                                                                                                                     | الإيقاف                                                                                                  |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| القياس  | `telemetry(tel)` تستبدل الحزمة السابقة  | أولاً. معالجات السجل، ثم المتتبّع، ثم المقاييس. يُفحص كل `lifecycle.start` بحثاً عن إخفاق فوري. يتراجع الإخفاق عما بدأ مسبقاً.   | آخراً، بعد `afterStop`، على ميزانية `stopTimeout` خاصة به. يُصرَّف المتتبّع والمقاييس معاً، ثم معالجات السجل. |
| الموارد | `resources(...)` تستبدل القائمة السابقة | بعد `beforeStart`، وقبل أي خادم. بترتيب التصريح. يُنتظر كل `start(ctx)` ويجب أن يُحل عندما يصبح المورد قابلاً للاستخدام.       | بعد إيقاف كل خادم أُطلق، بترتيب التصريح العكسي. يُسجَّل إخفاق الإيقاف ويستمر إيقاف المورد التالي.            |
| الخوادم | `server(...)` تستبدل القائمة السابقة    | تُصدَر كل استدعاءات `start`، ثم فحص إخفاق فوري واحد. قد يبقى `start` معلّقاً إلى أن ينتهي الكائن الأصلي. `Endpointer` اختياري. | `stop` متزامن، ثم يُضم وعد `start` لكل خادم.                                                             |

الخطافات: يعمل `beforeStart` قبل طبقة الموارد. ويعمل `afterStart` بعد التسجيل. ويعمل `beforeStop` قبل إلغاء التسجيل. ويعمل `afterStop` بعد طبقة الموارد وقبل تصريف القياس. تفشل خطافات البدء فوراً. وتعمل خطافات الإيقاف بوصفها تنظيفاً.

يستخدم التسجيل طبقة الخوادم فقط. المورد اعتماد، وليس عنواناً يُعلَن.

```text
run()
  1  install signal() or another runtime option
  2  phase = starting
  3  admit telemetry
  4  open the start budget, if startTimeout is set
  5  beforeStart
  6  admit each resource and wait
  7  launch every server, then check for an immediate failure
  8  prepare endpoints and register, server tier only
  9  afterStart
 10  phase = ready; go_like.app.ready flips with the ready probe
 11  wait for stop or the first participant failure

stop()
  1  phase = stopping; the ready probe fails from this moment
  2  open the shared stop budget, if stopTimeout is set
  3  cancel the application Context
  4  join startup inside that budget
  5  beforeStop
  6  deregister
  7  cancel the server Context and stop launched servers concurrently
  8  join server start promises
  9  cancel the resource Context and stop owned resources in reverse order
 10  join resource start promises inside the same budget
 11  afterStop
 12  cancel the telemetry Context and stop the bundle on a fresh budget of the same length
```

`run()` لمرة واحدة. `stop()` متكافئ ويشترك في وعد واحد. لا يأخذ `App.stop()` أي Context. يفوز سبب الإيقاف الأول: `requested` لـ `App.stop()` و`signal()`، و`context_canceled` عندما ينتهي Context الأب، و`start_failed` عندما يفشل البدء، و`server_failed` عندما يفشل مشارك مقبول بعد الجاهزية. يُرمى إخفاق واحد كما هو. وتصبح عدة إخفاقات `AggregateError` واحداً بترتيب الطور، والقياس آخراً.

ليس للخوادم الشقيقة ضمان ترتيب عكسي. إذا وجب أن يتوقف عامل قبل طابوره، ضع الطابور في `resources(...)` والعامل في `server(...)`. توجد طبقة الموارد حتى ينتظر هذا التركيب القبول. يعلّق `Server` مكتوب يدوياً لا يُحل `start` الخاص به قبولَ الموارد؛ استخدم `newResourceServer` لكائن أصلي، أو ضع مشاركاً طويل العمر في `server(...)`.

## نطاقات Context

```text
parent
  -> appContext          canceled at the start of stop
       -> telemetryContext    canceled just before Telemetry.stop
       -> resourceContext     canceled just before the resource tier stops
       -> serverContext       canceled just before Server.stop
       -> startContext        appContext, plus startTimeout when configured
       -> stopContext         withoutCancel(appContext), plus the shared stopTimeout
       -> telemetryStop       a second stopTimeout, opened when the drain begins
```

يتلقى `start(ctx)` طويل التشغيل Context طبقته. يبقى ذلك Context حياً إلى أن تُطلب تلك الطبقة بالإيقاف، فلا يرى المورد إلغاءً بينما ما زالت الخوادم تُصرَّف. يستخدم القياس Context الخاص به للسبب نفسه: إلغاء `appContext` في بداية الإيقاف يجب ألا يصرّف القياس قبل الخوادم التي يراقبها.

## الميزانيات والملكية

يغطي `startTimeout` الخطافات، وقبول الموارد، وإعداد نقاط النهاية، والتسجيل، و`afterStart`. وهو لا يغطي قبول القياس، ولا يحوّل `start` الخاص بخادم إلى وعد جاهزية. القيمة الافتراضية `0` تعني عدم وجود حد. القيمة الافتراضية لـ `registrarTimeout` هي 10 ثوانٍ، وهي تحد استدعاءي التسجيل وإلغاء التسجيل.

`stopTimeout` هي ميزانية انتظار المستدعي التي تشترك فيها الخطافات وإلغاء التسجيل وطبقة الخوادم وطبقة الموارد. يفتح تصريف القياس ميزانية ثانية بالطول نفسه عندما يبدأ ذلك الطور، فيستطيع التصدير أن ينتهي بعد استنفاد الميزانية المشتركة. التصريف الذي لا يستقر يجعل `App.run()` ينتظر نحو ضعف `stopTimeout`. القيمة الافتراضية `0` تعني عدم وجود حد لأي منهما. عندما تكون الميزانية المشتركة مستنفدة مسبقاً، ما زالت استدعاءات `stop` اللاحقة تُصدَر. ولا يواصل core الانتظار، وانتهاء المهلة ليس حالة نهائية أصلية. تبقى مهلات Plug مع Plug: الافتراضي لإيقاف OpenTelemetry هو 25 ثانية، والافتراضي لتصريف Pino هو 25 ثانية، وليس لمعالج Winston مهلة تصريف خاصة به.

بعد أن يُحل `start`، يملك App المشارك. يحل `newResourceServer({ open, terminal, close })` الدالة `start` عندما تنتهي `open`، أو فوراً عندما تُغفل `open`. `close` هو تصريف المالك الوحيد ويُستدعى مع `withoutCancel` لأول Context إيقاف. إذا فشلت `open`، لا تُستدعى `close`. يرفض `start` ثانٍ بالرمز `GO_LIKE_RESOURCE_ALREADY_STARTED`. تسوية `terminal` نظيفة قبل الإيقاف تفشل App بالرمز `GO_LIKE_RESOURCE_CLOSED`. حل `Error` أو رفض يفشل App بذلك الخطأ. يُراقب وعد النهاية بصورة خاصة؛ وهو ليس حقلاً عاماً في Socket.

## الجاهزية

يسجّل `readyProbe(registry, name?)` فحصاً متزامناً، والاسم الافتراضي `"app"`. ينجح فقط بينما تكون `run()` في طور الجاهزية، وينقلب في اللحظة نفسها التي ينقلب فيها المقياس `go_like.app.ready`. خارج تلك النافذة يرمي `AppNotReadyError` (`GO_LIKE_APP_NOT_READY`) مع `phase` بقيمة `created` أو `starting` أو `stopping` أو `stopped`. بعد أن تستقر `run()`، يُزال الفحص. يبقى App الذي لم يُشغَّل في الحالة `created`.

يعرض `createHealthHandler(probes)` المسارين `/livez` و`/readyz`. تنجح الحيوية الفارغة. وتفشل الجاهزية الفارغة مغلقة، فيعيد معالج بلا `readyProbe` أو فحص جاهزية آخر الحالة 503 للمسار `/readyz`. يجب أن ينجح كل فحص جاهزية مسجّل. ولا يسجّل core فحص حيوية.

ما زال مستمع `newServer` الداخلي يجيب `GET` و`HEAD` على `/healthz` باستجابة 200 فارغة. تعني تلك الاستجابة أن المستمع الأحادي استقبل الطلب. وهي ليست سجل الفحوص.

## المستمعون والمنافذ المنشورة

الأمثلة التي تربط `127.0.0.1` ثم تستدعي ذلك العنوان هي الشكل المحلي الصحيح. يمكن لمنفذ Docker المنشور أن يقبل TCP عبر الوكيل قبل أن تخدم الحاوية البروتوكول. اصل إلى Redis وAMQP وetcd وHTTP الخاص بالتطبيق على شبكة Compose عبر DNS الخدمة عندما يكون ذلك هو الطوبولوجيا التي بدأتها.

لا يعني `Server.start(ctx)` على طبقة الخوادم الجاهزية. تعيد `Endpointer.endpoint(ctx)` عنواناً يمكن الإعلان عنه. ويعني `afterStart` أن Core بلغ ذلك الخطاف.

يستطيع `startRecoveringRabbitMqBroker` قبول مقبض وسيط قبل أن ينتهي إعداد الموصّل، فيستطيع HTTP الربط من دون انتظار AMQP. يبقى النشر مغلقاً إلى أن توجد جيل. ذلك قبول للمقبض، وليس مسار صحة.

## مسار الطلب

```text
External Web
  Request -> framework or Handler -> Response -> host writes the body

Internal unary
  Context + operation
    -> Client middleware
    -> direct address or Discovery snapshot
    -> Filters, then Selector
    -> Transport
    -> POST /<service>/<endpoint>
    -> Server middleware, Struct decode, handler, Struct encode
```

هوية العملية هي `service/endpoint`، مثل `appointment-policy.v1/check`. نقطة نهاية `ServiceInstance` عنوان نقل مبهم، مثل `memory://orders` أو `https://orders.example`.

## قابلية النقل بين بيئات التشغيل

تستخدم المداخل القابلة للنقل JavaScript القياسي وواجهات Web، أو قدرات يحقنها المستدعي. ولا يعد المدخل القابل للنقل بمستمع TCP، أو إشارات عملية، أو مراقبة ملفات، أو UDP متعدد الوجهات، أو عميل بائع.

| المدخل                                                                                        | أين يعمل                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| مداخل مفاهيم `@go-like/core`، بما فيها `/web` و`/transport/http` و`/transport/memory`         | قابل للنقل. يتصل `/transport/http` عبر Fetch. يحتاج الاستماع إلى مضيف محقون. |
| `@go-like/core/node` و`/transport/http/node` و`/web/node` و`/config/node`                     | واجهات Node. قد يعمل `/web/node` أيضاً حيث توجد تلك الواجهات.                |
| `@go-like/core/web/bun`                                                                       | مضيف Bun.                                                                   |
| `@go-like/mdns/registry/node` و`@go-like/zookeeper/registry/node` و`@go-like/file/store/node` | مضيف Node لذلك Plug. يبقى المدخل الشقيق قابلاً للنقل فوق مضيف أو مصنع محقون.  |
| `@go-like/connectrpc`                                                                         | معالج Fetch قابل للنقل.                                                     |
| `@go-like/connectrpc/node`                                                                    | خادم gRPC وعميله في Node.                                                   |
| NATS وRabbitMQ وRedis وBullMQ                                                                 | Node وBun، تبعاً للعميل الأصلي.                                               |

لا تستخدم صادرات الحزم شروط `bun` أو `node` الشرطية. استورد المسار الفرعي الذي تقصده. توفّر مكتبة TypeScript المسماة `DOM` الأنواع. وهي ليست polyfill لوقت التشغيل.

## التركيب

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { newNodeServer, port } from "@go-like/core/web/node"

const policy = defineService("policy", {
  check: {
    request: struct.object({ ok: struct.boolean() }),
    response: struct.object({ ok: struct.boolean() })
  }
})

const transport = newMemoryTransport()
const policyServer = newServer(serverTransport(transport), address("memory://policy"))
policy.registerHandler(policyServer, {
  check() {
    return { ok: true }
  }
})
const policyClient = newClient(withTransport(transport), withEndpoint("memory://policy"))
const webServer = newNodeServer((_request: Request) => new Response("ok"), port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
void app
```

لا تصبح `newApp` حاوية، ولا يصبح نقل الذاكرة شبكة. تبقى بيانات الاعتماد والمصانع وإيقاف الكائنات التي لم تُسلَّم إلى App في جذر التركيب.

تستخدم ملاحظات التصميم الأقدم أسماء مثل `ServerHandle` و`AppHandle`. التواقيع في هذه الصفحة هي المصدَّرة اليوم. يُصدَّر `Server` و`Endpointer` من `@go-like/core/lifecycle`، لا من المدخل الجذري.
