# go-like

go-like مجموعة من لبنات البناء الصريحة المكتوبة بـ TypeScript لخدمات الخلفية على Bun وNode.js. `@go-like/core` هي لوحة Socket بلا اعتماديات وقت تشغيل: Context، ودورة حياة التطبيق، والاستدعاءات الداخلية، والإعداد، والاكتشاف، والسجلات، وذاكرة التخزين المؤقت، والرسائل، والمهام، والصحة، وقاعدة القياس عن بعد. تسع عشرة حزمة أخرى هي Plugs. يملأ Plug واحداً أو أكثر من Sockets بعميل من المنظومة ينشئه التطبيق. `@go-like/protoc-gen-like` مولّد Protobuf في وقت البناء ولا يعتمد على core.

يبقى التطبيق جذر التركيب. فهو ينشئ الكائنات الأصلية، ويمررها إلى دوال إنشاء Plug، ويثبّت النتائج على `newApp`. لا يوجد سجل عام للخوادم أو أدوات التسجيل أو مزوّدات القياس عن بعد.

> [!IMPORTANT]
> هذا checkout مساحة عمل خاصة بالإصدار `0.0.1`. لا يثبت إصدار manifest توفر الحزم على npm. تستخدم الأمثلة حزم workspace ويُقصد تشغيلها من checkout ما لم يُؤكد إصدار منشور بصورة مستقلة.

> [!NOTE]
> شجرة `doc/` الإنجليزية هي المصدر المرجعي لمسار التوثيق هذا. مصدر الحزمة وmanifests والاختبارات المركّزة هي مرجع API. وجود اختبار أو script لـ E2E في المستودع يعني تغطية معلنة؛ ولا يعني نتيجة ناجحة إلى أن يُنفّذ الأمر وتُسجّل حالة خروجه فعلياً.

## اختر مسارك

| القارئ                 | ابدأ هنا                                      | ثم اقرأ                                                                                 | تصبح جاهزاً عندما                                                                |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| جديد على go-like       | [البدء](/ar-Arab/guide/getting-started)       | [البنية](/ar-Arab/guide/architecture)، [مشروع العيادة](/ar-Arab/guide/zero-to-one)      | تستطيع تشغيل خدمة Web واحدة، وتمرير Context، وعرض الصحة، وإيقافها               |
| مهندس TypeScript متمرس | [البنية](/ar-Arab/guide/architecture)         | [استدعاءات الخدمات](/ar-Arab/guide/service-call)، [المقارنة](/ar-Arab/guide/comparison) | تستطيع تسمية المالك والطبقة والحد النهائي لكل مورد                              |
| قارئ Go أو Kratos      | [البدء](/ar-Arab/guide/getting-started)       | [المصطلحات](/reference/terminology)، [استدعاءات الخدمات](/ar-Arab/guide/service-call)   | تستطيع ربط مفاهيم Context وServer من دون افتراض gRPC أو توافق Go ABI            |
| مستخدم إطار عمل        | [المقارنة](/ar-Arab/guide/comparison)         | [الترحيل](/ar-Arab/guide/migration)، [البنية](/ar-Arab/guide/architecture)              | تستطيع إبقاء الموجّه الأصلي وإضافة حد دورة الحياة أو الاستدعاء الذي تحتاج إليه فقط |
| مؤلف Plug              | [فهرس المزوّدات](/ar-Arab/reference/providers) | [التحقق](/ar-Arab/reference/verification)، [الادعاءات](/reference/claims)                | تستطيع تحديد Socket وبيئة التشغيل والملكية وحدود الدليل لـ Plug                 |

## مسار التعلّم المرجعي

المسار المرجعي من أربع صفحات تحت `doc/guide/` متدرّج عمداً:

1. [البدء](/ar-Arab/guide/getting-started) يشغّل Fetch Handler قياسياً، ومضيف Node، وإشارة قبول، وApp واحداً.
2. [حجز مواعيد العيادة](/ar-Arab/guide/zero-to-one) يحوّل دورة الحياة إلى مجال ملموس، واستدعاء داخلي أحادي، وCache، وصحة، واختبار، وتمرين إيقاف.
3. [المقارنة](/ar-Arab/guide/comparison) تشرح أين تختلف go-like عمداً عن NestJS وFastify وHono وElysia وKoa وtRPC وgo-micro وgo-kratos.
4. [الترحيل](/ar-Arab/guide/migration) يربط حزم ما قبل الترحيل بتخطيط الحزم العشرين.

[الحزم](/ar-Arab/reference/packages) جرد لـ 20 حزمة و75 مدخلاً عاماً. [المزوّدات](/ar-Arab/reference/providers) تشير إلى README لكل Plug في المنظومة.

## النموذج الذهني

ثلاث قواعد تسري في المكتبة:

1. **Context أولاً.** كل عملية إدخال/إخراج تأخذ `ctx: Context` وسيطاً أولاً. يحمل Context الإلغاء، والموعد النهائي، وAppInfo، وبيانات الطلب الوصفية، وحالة القياس عن بعد الحالية.
2. **تركيب صريح.** ينشئ التطبيق كل تنفيذ ويمرره. لا تسجّل Plugs نفسها تسجيلاً عاماً.
3. **مسار واحد لكل عمل.** اشترك بـ `newBrokerServer`، وجدوِل بـ `newScheduleServer`، واستهلك طابوراً بـ `JobQueue.worker`، وأرفق مورداً أصلياً بـ `newResourceServer`، وانشر الجاهزية بـ `readyProbe` مع `createHealthHandler`.

```text
Application main.ts
  construct plugs from native objects the application created
  newTelemetry({...})  newConfig(...)  newServer(...)  newClient(...)
        |
        v
@go-like/core  newApp(...)
  telemetry(tel)     admitted first, drained last
  resources(...)     started in order, each start awaited, stopped in reverse
  server(...)        started together, stopped together
  registrar(r)       after the server tier is admitted
  readyProbe(...)    ready only between startup completion and stop
```

خمسة أسماء تكفي لقراءة بقية الموقع:

- **Socket** عقد بنيوي يعلنه core (`Server` و`LogHandler` و`Registry` و`Broker` و`Store` وغيرها). ينفّذ Plug العقد. ولا يغلّف موقع استدعاء في core.
- **Context** هو النطاق الصريح للعمل القابل للإلغاء.
- **Server** هو `start(ctx)` و`stop(ctx)`. في `resources(...)` يُحل `start` عندما يصبح المورد قابلاً للاستخدام. في `server(...)` قد يبقى `start` معلّقاً إلى أن ينتهي الكائن الأصلي.
- **App** يقبل تلك الطبقات والخطافات والتسجيل والإيقاف. وهو ليس حاوية dependency injection.
- **Handler** هو دالة Web القياسية `(Request) => Response | Promise<Response>`. ولا يكون Handler خادماً مستمعاً بذاته.

يبقى Web الخارجي واستدعاءات الخدمات الداخلية منفصلين. RPC المولّد من Protobuf مسار اختياري إضافي: يصدر `@go-like/protoc-gen-like` غراء يضع Context أولاً، ويكيّف `@go-like/connectrpc` كلاً من Connect وgRPC-Web إلى Fetch، ويستضيف `@go-like/connectrpc/node` معيار gRPC. راجع [التدفق](/ar-Arab/guide/streaming).

## ما يبقى على التطبيق

يترك حد المنتج الحالي ما يأتي للتطبيق أو للمكتبة الأصلية:

- المسارات، وmiddleware الإطار، وWeb Streams، وترقيات WebSocket؛
- سياسة العمل، وبيانات الاعتماد، والتفويض؛
- الإقرار الأصلي، وعقود lease، وإعادة المحاولة، وتفاصيل البروتوكول؛
- بناء OpenTelemetry SDK، وإعداد أداة التسجيل، واختيار المصدّر؛
- الاستمرارية، والمعاملات، وأي معنى بين العمليات لتنفيذ مرجعي في الذاكرة؛
- النشر على npm، أو حالة hosted CI، أو ادعاء جاهزية إنتاج يُستنتج من manifest.

## الجرد العام

تنشر مساحة العمل **20** حزمة `@go-like/*`، كلها بالإصدار `0.0.1` في هذا checkout، و**75** مدخلاً عاماً. تساهم `@go-like/core` بـ 41 مدخلاً. وتنتمي المداخل الأربعة والثلاثون الأخرى إلى Plugs والمولّد. وليست exports البيانات الوصفية في `dist/package.json` واجهات مصدرية إضافية.

استخدم [مرجع الحزم](/ar-Arab/reference/packages) لاختيار مدخل، و[فهرس المزوّدات](/ar-Arab/reference/providers) لفتح README الخاص بـ Plug. يسجّل [سجل الادعاءات](/reference/claims) مستوى الدليل وراء الصياغة العامة.

## حدّ التحقق

أفاد تدقيق عقد تاريخي للمستودع بالنتائج المحلية على commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`: نجحت `bun run typecheck` و`bun run test:unit` و`bun run fmt:check`. وأحصى ذلك التقرير 2,736 اختبار وحدة، و1,514 ملفاً منسقاً، وتدقيق استيراد ناجحاً لـ 66 مدخل تصدير مصدري. يصف ذلك العدّ شجرة ما قبل الترحيل. الجرد الحالي 75 مدخلاً. ولم يثبت التدقيق `build` أو `doc:build` أو E2E لمزوّدات Docker أو مستهلكي tarball المنشور أو النشر على npm أو hosted CI أو soak لمدة 60 دقيقة.

اقرأ [التحقق](/ar-Arab/reference/verification) قبل تحويل ادعاء مصدر أو script إلى ادعاء إصدار.

## الخطوات التالية

- [البدء](/ar-Arab/guide/getting-started): شغّل Web Handler وأول نقطة تحقق في دورة الحياة.
- [البنية](/ar-Arab/guide/architecture): الطبقات، ونطاقات Context، وترتيب البدء والإيقاف، والجاهزية، والميزانيات.
- [حجز مواعيد العيادة](/ar-Arab/guide/zero-to-one): قاعدة عمل واحدة من HTTP إلى استدعاء policy داخلي، ثم الصحة والإيقاف.
- [استدعاءات الخدمات](/ar-Arab/guide/service-call): Memory Transport نمطي، ثم الاكتشاف والاختيار وإعادة المحاولة.
- [الإعداد والسجل والمخزن وذاكرة التخزين المؤقت](/ar-Arab/guide/config-registry-store): أربعة عقود، وعميل مشترك واحد لكل منظومة.
- [الوسيط والأحداث والمهام](/ar-Arab/guide/broker-events): البايتات، والمرمّزات، والجداول، والطوابير.
- [الصحة وقابلية الرصد](/ar-Arab/guide/health-observability): الفحوص، و`newTelemetry`، وأربعة Plugs للقياس.
- [المقارنة](/ar-Arab/guide/comparison) و[الترحيل](/ar-Arab/guide/migration): الملكية مقابل الأدوات الأخرى، وتحويل الاستيراد.
- [الحزم](/ar-Arab/reference/packages)، و[المزوّدات](/ar-Arab/reference/providers)، و[الأخطاء](/reference/errors)، و[المصطلحات](/reference/terminology)، و[التحقق](/ar-Arab/reference/verification).

سُجّل تصريف gRPC المُدار مع مستهلك بطيء على Node 26.12.1 وBun 1.4.4 في [مصفوفة تصريف gRPC الأصلي](/reference/claims#native-grpc-drain-status). وتبقى ملاحظات إلغاء Fetch السابقة في Connect 2.1.2 وBun 1.4.2 في [سجل الادعاءات](/reference/claims#stream-cancellation-limits).
