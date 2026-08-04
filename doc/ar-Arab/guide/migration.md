# الترحيل والتبنّي

القاعدة الأكثر أماناً للترحيل هي: **أبقِ مستوى البيانات كما هو، وتبنَّ الحدّ الذي تستطيع شرحه**.

احتفظ بإطار Web أو العامل أو المجدول أو وسيط الرسائل أو المسجّل أو مزوّد القياس الموجود لديك. أضف عقداً صريحاً من go-like حول مشكلة حقيقية في دورة الحياة أو في استدعاء الخدمات. تحقّق من هذا الحدّ قبل إضافة مزوّد آخر.

## ترحيل على مراحل

1. أبقِ عملية الإقلاع الحالية وشيفرة المسارات/مستوى البيانات كما هي.
2. حدّد مالكاً واحداً: مستمعاً، أو عاملاً، أو مجدولاً، أو اشتراكاً في وسيط رسائل، أو وجهة للسجلات، أو مزوّد قياس.
3. أضف محوّلاً بنيوياً لـ `Server` أو استخدم محوّلاً موجوداً في go-like. عرّف القبول، والإيقاف، والمهلة، ومراقبة الحالة النهائية.
4. أضف `@go-like/context` عند حدود الإلغاء أو الموعد النهائي الفعلية. مرّره بوصفه الوسيط الأول للعملية.
5. أضف فحوص `liveness` و`readiness` باستخدام `@go-like/health` و`@go-like/web/health`.
6. أضف استدعاءً داخلياً أحادياً typed باستخدام `@go-like/transport-memory` في الاختبارات.
7. انقل هذا الاستدعاء إلى `@go-like/transport-http` أو `@go-like/transport-http/node` فقط عندما تحتاج إلى وسيلة نقل فعلية أو مضيف Node أصلي.
8. أضف Registry أو Config أو Store أو Cache أو Broker أو السجلات أو المقاييس أو التتبّع، قدرة واحدة في كل مرة.
9. سجّل المزوّد وبيئة التشغيل والمالك ومسار الدليل لكل حدّ جديد.

لا تبدأ بإعادة كتابة الخدمة كلها. فائدة العقود الصغيرة هي أن تظل وحدة الترحيل صغيرة.

## مصفوفة ترحيل الأطر

| النظام الموجود | ما يبقى أصلياً                                                            | ما يُعتمد أولاً                                                           | الحدّ الحالي                                                                                              |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| NestJS         | Modules, controllers, decorators, DI, interceptors, pipes, adapter        | `Server` بنيوي مخصص حول التطبيق الموجود، أو حدّ Client/Server داخلي منفصل | لا يوجد في هذا المستودع محوّل NestJS لـ go-like ولا تكامل DI تلقائي                                        |
| Fastify        | Routes, plugins, hooks, request/reply, native listener                    | غلاف دورة حياة مخصص، أو جسر Fetch منفّذ صراحةً                            | لا يوجد تحويل مثبت حالياً من Fastify request/reply إلى go-like Handler                                     |
| Hono           | Routes, middleware, sub-apps, `app.fetch`                                 | `newNodeServer(app.fetch, ...)` ثم `newApp(...)`                          | التكامل المباشر مع Fetch موضّح في `examples/hono`                                                         |
| Elysia         | Route tree, schema, decorators, derives, hooks, Bun/Web Standard behavior | `app.fetch` الأصلي مع مضيف/دورة حياة Core عند الحاجة                      | أبقِ دلالات `.listen()` الخاصة بـ Bun؛ لا تعدّها API من go-like عابرة لكل بيئات التشغيل                    |
| H3             | H3 router and native handler conversion                                   | مسار Fetch Handler الموجود في مثال H3 الحالي                              | `app.fetch` في H3 2.x هو الشكل الموضّح حالياً؛ وتحتاج إرشادات `toWebHandler` الأقدم إلى مثال مثبت الإصدار |
| Koa            | Middleware and external router                                            | غلاف مخصص للمالك، أو استدعاء خدمة داخلي                                   | لا تقبل `@go-like/web` كائن Koa الخاص بـ Node request/reply من دون جسر على مستوى التطبيق                   |
| tRPC           | Router, procedure middleware, input/output parsers, adapter               | دورة حياة Core حول المضيف، أو حدّ نقل داخلي منفصل                         | إن `Endpoint` في go-like ليس موجّه إجراءات tRPC                                                            |

### مثال Hono

هذا هو شكل التكامل الموضّح في المستودع:

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/web/node"

const web = new Hono().get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

const app = newApp(name("users"), server(newNodeServer(web.fetch, port(3000))), signal())

await app.run()
```

يحافظ مثال Hono الحالي على ملكية Hono للمسارات، ويمرّر Fetch Handler الأصلي إلى مضيف Node. ولا يضيف جدول مسارات من go-like ولا حزمة جسر خاصة بـ Hono.

### Elysia وH3

طبّق الحدّ نفسه على إطار يعرِض Fetch Handler قياسياً:

```text
framework route table
  -> framework native Fetch handler
  -> @go-like/web/node (when using the Node host)
  -> @go-like/core App
```

تحقّق من محوّل بيئة التشغيل في الإطار قبل استيراد مسار فرعي خاص بـ Node. لا يتطابق سلوك الاستماع في محوّل Bun لـ Elysia مع محوّل Web Standard. كما تحتاج إصدارات H3 وواجهات تحويل المعالجات فيه إلى مثال مثبت الإصدار. لا تستخدم وجود مثال واحد لتعد بدعم كل تركيبة من إصدار الإطار وبيئة التشغيل.

## ترحيل خدمة Go

إذا كنت قادماً من Go أو Kratos، فهاجر المفاهيم لا الأسماء:

| مفهوم Go          | مفهوم go-like                                                                                                       | الاختلاف المهم                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `context.Context` | `Context` من `@go-like/context`                                                                                     | `done()` هو `AbortSignal` أو `null`، وليس قناة Go                  |
| Server lifecycle  | `Server` البنيوي في Core                                                                                           | قد يستمر `start(ctx)` طوال عمر الخدمة، ولا يعني الجاهزية           |
| App runner        | `newApp` و`App.run` و`App.stop`                                                                                    | لا يستقبل `App.stop()` سياق المستدعي ويعيد Promise مشتركة واحدة    |
| RPC client        | `@go-like/client`                                                                                                   | الاستدعاءات الداخلية هي `Message` أحادية؛ وإعادة المحاولة اختيارية |
| Transport         | `@go-like/transport`                                                                                                | المزوّدات وحقول headers في `Message` عقود TypeScript/Web           |
| Registry          | `@go-like/registry`                                                                                                 | يعيد المراقبون لقطات استبدال كاملة                                 |
| Selector          | `newRoundRobinSelector`, `newRandomSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | الملاحظات الراجعة متزامنة وتعتمد على السياسة                       |
| Protobuf/IDL      | لا مقابل له في go-like                                                                                              | `Endpoint` + `Struct` تحقق وقت التشغيل، وليس شيفرة مخطط مولّدة     |
| gRPC stream       | لا يوجد مقابل حالي في go-like                                                                                       | تدفق Web العام منفصل عن النقل الداخلي الأحادي                      |

الخطوة التدريجية الأولى هي استدعاء typed إلى عنوان مباشر عبر Memory Transport:

```ts
const transport = newMemoryTransport()
const server = newServer(
  serverTransport(transport),
  address("memory://pricing"),
  handler(pricingEndpoint, pricingHandler)
)
const client = newClient(withTransport(transport))

const result = await client.call(ctx, pricingEndpoint, request, withAddress("memory://pricing"))
```

لا تقدّم Discovery أو مزوّد Registry حقيقياً أو HTTP Transport إلا بعد اختبار هذا الحدّ. هكذا تحافظ على عقد المجال أثناء استبدال الوجهة وتركيب الملكية.

## اعتماد Kubernetes

أبقِ Kubernetes أصلياً:

- تظل Deployments وServices وDNS وIngress وRBAC وprobes واستراتيجية rollout وHPA وnetwork policy مسؤوليات للمنصة؛
- يقرأ `@go-like/config-kubernetes` مفتاحاً واحداً من ConfigMap أو Secret واحد ضمن namespace واحد، عبر قدرة Fetch محقونة؛
- يستخدم `@go-like/registry-kubernetes` سجلات EndpointSlice عندما يكون الاكتشاف المباشر حاجة حقيقية؛
- لا يُعدّ EndpointSlice هو DNS الخاص بـ Kubernetes Service، ولا يوفّر TTL عاماً للتسجيل؛
- لملكية Pod الاختيارية وإلغاء التسجيل الصريح دلالات فشل مختلفة.

ابدأ بالصحة والإعداد قبل الاختيار المباشر من EndpointSlice. إذا كان للتطبيق بالفعل اسم DNS ثابت لـ Service، فقد يكون `withAddress(...)` مع HTTP Transport أبسط وأكثر صدقاً من إضافة مزوّد Registry.

## اعتماد الوسطاء والمهام

أبقِ التسوية وسياسة المهام أصليتين:

| مستوى البيانات الموجود | ما يبقى أصلياً                                                   | ما تضيفه go-like من أجله                                                               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| NATS Core              | Connection, subscription, queue group, `Msg`, drain              | `newNatsCoreServer` و`newNatsCoreBroker` ودورة الحياة وحدّ البايتات                   |
| NATS JetStream         | Stream, durable consumer, `JsMsg`, ack/nak/term, redelivery, DLQ | `newNatsJetStreamServer` و`newNatsJetStreamBroker` ودورة الحياة                       |
| RabbitMQ               | Connection, topology, confirm policy, channel                    | دورة حياة subscriber المستعار أو المستعيد، والتسوية الأصلية الآمنة أمام تغيّر الأجيال |
| BullMQ                 | Queue, Worker, processor, retry/backoff, Redis                   | `newBullMqWorkerServer` حول Worker رسمي متوقف مؤقتاً                                  |
| Croner                 | Cron expression, time zone, callback, overlap policy             | `newCronerServer` حول وظائف Cron أصلية موقوفة مؤقتاً                                  |
| Memory Broker          | خريطة topics داخل العملية ودلالات الاختبار                       | `newBrokerServer` وevent codec اختياري                                                |

لا تنقل ack/nak/term في NATS، أو التسوية الدائمة في JetStream، أو تأكيدات RabbitMQ، أو عمليات retry في BullMQ إلى تجريد عام لـ go-like Broker. هذه الدلالات هي بالضبط سبب بقاء الكائن الأصلي للمزوّد ظاهراً.

## ترحيل الحالة

اختر مجال حالة واحداً في كل مرة:

- Config للقطات إعداد العملية غير القابلة للتغيير وإعادة التحميل؛
- Registry لقابلية الوصول المؤقتة إلى الخدمات؛
- Store للسجلات المرجعية والإصدارات وCAS وTTL والصفحات؛
- Cache للقيم القابلة للتخلص التي يمكن إعادة حسابها.

من اختبارات الترحيل المفيدة أن تكتب ما يحدث بعد إعادة تشغيل العملية، وقراءة قديمة، وتعطّل المزوّد، وضغط watcher، وتعارض CAS، وcache miss. إذا اختلفت الإجابة، فلا ينبغي لهذه المجالات أن تشترك في واجهة repository عامة واحدة.

## إضافة قابلية الرصد

أضف المزوّد الأصلي أولاً، ثم غلّف الحدّ:

```text
application creates logger / Registry / MeterProvider / TracerProvider
  -> go-like wrapper records bounded operation facts
  -> application-owned exporter or destination
  -> explicit Core lifecycle adapter closes the admitted resource
```

لا يستخدم `@go-like/prometheus` السجل العام. ولا يثبّت `@go-like/otel` مزوّدات أو مصدّرات عامة. كما أن محوّلات Pino وWinston لا تستبدل إعداد المسجّل الأصلي. أبقِ labels وattributes محدودة، وطبّق إخفاءً منفصلاً على السجلات التي يملكها التطبيق.

## قائمة قبول الترحيل

قبل دمج حدّ واحد، تحقّق من الآتي:

- يوجد مالك واحد مسمّى بوضوح؛
- يتلقى المالك `Context` الصحيح ولا يستبدله بـ `background()`؛
- القبول أثناء الإقلاع والجاهزية شيئان مختلفان؛
- يوثّق سلوك مهلة stop بوصفه حدّ انتظار؛
- تبقى مراقبة الحالة النهائية الأصلية حيثما كانت متاحة؛
- لا تختلط معالجات Web الخارجية بالمعالجات الداخلية الأحادية؛
- يطابق تفويض retry عملية العمل؛
- تملك credentials وmetadata والسجلات وسمات trace سياسة إخفاء؛
- تبقى دلالات المزوّد الخاصة ظاهرة؛
- نجح أمر unit/typecheck المركّز في checkout المستهدف؛
- نُفّذ أمر E2E ذي الصلة ببيئة التشغيل أو المزوّد أو الحزمة المنشورة أو المثال وسُجّل، أو وُسِم صراحةً بأنه لم يُنفّذ.

## حدّ الدعم الحالي

يحتوي المستودع على أمثلة مباشرة لـ Fetch بلا إطار، وHono، وElysia، وH3، وMemory Transport، والاستدعاءات الداخلية typed، والصحة، والوسطاء، والعاملين، ومحوّلات قابلية الرصد. لكنه لا يثبت جسوراً تلقائية لـ NestJS أو Fastify، ولا توافقاً مع gRPC/Protobuf/IDL، ولا تدفقات داخلية full-duplex، ولا مصادقة عامة، ولا تنسيقاً للنشر. كل ذلك يحتاج إلى محوّلات واختبارات والتزامات منتج منفصلة.
