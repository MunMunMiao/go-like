# go-like

go-like مجموعة من لبنات البناء الصغيرة والصريحة المكتوبة بـ TypeScript لخدمات الخلفية التي تعمل على Bun وNode.js وDeno. تمنح التطبيق عقوداً لإلغاء العمل عبر `Context`، ودورة حياة التطبيق والموارد، ومعالجات Fetch القياسية، واستدعاءات الخدمات الداخلية الأحادية، واكتشاف الخدمات واختيارها، والإعداد، والمخازن، وذاكرات التخزين المؤقت، والوسطاء، والصحة، والمرونة، ومحوّلات التسجيل والقياس الاختيارية.

go-like مكملة عمداً لإطار التطبيق. يظل إطارك مالكاً للمسارات وmiddleware وسياسة الطلب وWeb Streams وترقيات WebSocket وتركيب الاعتماديات وسلوك العمل. ويظل مزوّدك مالكاً لاتصاله الأصلي ونموذج الإقرار أو retry أو lease أو البروتوكول. توفر go-like عقوداً ضيقة وملكية واضحة لدورة الحياة حيث تكون هذه الحدود مفيدة.

> [!IMPORTANT]
> يستخدم هذا checkout حزم `workspace:*` بالإصدار `0.0.1`. لا يثبت رقم manifest توفر الحزم على npm؛ تحقّق من النشر بصورة مستقلة قبل التثبيت خارج workspace.

> [!NOTE]
> شجرة `doc/` الإنجليزية هي المصدر المرجعي لمسار التوثيق هذا. مصدر الحزمة وmanifests والاختبارات المركّزة هي مرجع API. وجود اختبار أو script لـ E2E في المستودع يعني تغطية معلنة؛ ولا يعني نتيجة ناجحة إلى أن يُنفّذ الأمر وتُسجّل حالة خروجه فعلياً.

## اختر مسارك

| القارئ                 | ابدأ هنا                                       | ثم اقرأ                                                                                 | تصبح جاهزاً عندما...                                                               |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| جديد على go-like       | [البدء](/ar-Arab/guide/getting-started)        | [البنية](/ar-Arab/guide/architecture)، [مشروع العيادة](/ar-Arab/guide/zero-to-one)      | تستطيع تشغيل خدمة Web واحدة، وتمرير Context، وعرض health، وإيقافها                 |
| مهندس TypeScript متمرس | [البنية](/ar-Arab/guide/architecture)          | [استدعاءات الخدمات](/ar-Arab/guide/service-call)، [المقارنة](/ar-Arab/guide/comparison) | تستطيع تسمية مالك كل مورد وحدّه النهائي                                            |
| قارئ Go أو Kratos      | [البدء](/ar-Arab/guide/getting-started)        | [الترحيل](/ar-Arab/guide/migration)، [استدعاءات الخدمات](/ar-Arab/guide/service-call)   | تستطيع ربط مفاهيم Context وServer من دون افتراض gRPC أو توافق Go ABI               |
| مستخدم إطار عمل        | [المقارنة](/ar-Arab/guide/comparison)          | [الترحيل](/ar-Arab/guide/migration)، [البنية](/ar-Arab/guide/architecture)              | تستطيع إبقاء الموجّه الأصلي وإضافة حد دورة الحياة أو الاستدعاء الذي تحتاج إليه فقط |
| مهندس مزوّد أو منصة    | [مرجع المزوّدات](/ar-Arab/reference/providers) | [التحقق](/ar-Arab/reference/verification)، [الحزم](/ar-Arab/reference/packages)         | تستطيع تحديد بيئة التشغيل والbackend والملكية وحدود الدليل لمزوّد ما               |

## اختر مساراً للمبتدئ أو الخبير

- **المبتدئ:** [البدء](/ar-Arab/guide/getting-started) ثم [مشروع العيادة](/ar-Arab/guide/zero-to-one). لا تنتقل إلى provider خارجي قبل تشغيل Handler وفهم إشارة `GO_LIKE_EXAMPLE_READY`.
- لا يشمل ذلك gRPC القياسي داخل المتصفح، أو تدفق طلبات Fetch ثنائي الاتجاه، أو health/reflection القياسيين، أو مصادقة عامة، أو Event Store/replay، أو ORM، أو تنسيق العناقيد.
- **مستخدم إطار:** [المقارنة](/ar-Arab/guide/comparison) ثم [الترحيل](/ar-Arab/guide/migration) لإبقاء router الأصلي وإضافة الحد الأدنى.

## النموذج الذهني

أصغر نموذج مفيد يتكون من خمسة أسماء:

- **Context** هو الوسيط الأول الصريح للعمل القابل للإلغاء. يحمل موعداً نهائياً، ونتيجة إلغاء على نمط `AbortSignal`، وسبباً اختيارياً، وقِيَماً.
- **Server** كائن دورة حياة بنيوي يملك `start(ctx)` و`stop(ctx)`. وهو يملك حدّ مورد واحداً مقبولاً للعمل.
- **App** يركّب Servers وhooks والتسجيل وقبول البدء والإيقاف الرشيق. ولا يتحول إلى حاوية dependency injection.
- **Handler** هو دالة Web القياسية `(Request) => Response | Promise<Response>`. ولا يكون Handler خادماً مستمعاً بذاته.
- **Endpoint** عملية داخلية typed ومسمّاة. وهي مختلفة عن عنوان شبكة مثل `memory://pricing` أو `https://pricing.example`.

مسار Web الخارجي ومسار الخدمات الداخلي منفصلان:

```text
External Web request
  Request
    -> framework router or application handler
    -> @go-like/web Handler
    -> Web host, such as @go-like/web/node
    -> @go-like/core App / Server lifecycle

Internal unary call
  @go-like/client
    -> Discovery, Filter, Selector, or direct address
    -> @go-like/transport Client
    -> Message send / recv
    -> @go-like/server unary handler
    -> response Message
```

## ما الذي لا تتولاه go-like عمداً؟

لا يدّعي حد المنتج الحالي ما يأتي:

- لا يشمل ذلك gRPC القياسي داخل المتصفح، أو تدفق طلبات Fetch ثنائي الاتجاه، أو health/reflection القياسيين، أو مصادقة عامة، أو Event Store/replay، أو ORM، أو تنسيق العناقيد.
- Fetch request-streaming/bidi; gRPC قياسي بالأنماط الأربعة عبر `/native`.
- موجّهاً خارجياً أو DSL لـ middleware خاصاً بإطار؛
- حاوية dependency injection عامة أو service locator؛
- JWT أو OAuth أو OIDC أو claims أو ACL أو تفويض التطبيق تلقائياً؛
- Event Store أو استعلام تاريخ أو محرك replay أو نموذج تسوية دائم عاماً للرسائل؛
- مزوّدات OpenTelemetry أو exporters أو context managers أو instrumentation عامة تلقائية؛
- معنى موزع أو دائم أو بين العمليات لمزوّدات الذاكرة؛
- نشر npm أو اعتماداً إنتاجياً أو حالة hosted CI أو ضماناً لجاهزية الإنتاج لمجرد وجود manifest أو script.

يظل تدفق Web العام هو `Request`/`Response` القياسي في Fetch وWeb Streams. وليس RPC داخلياً ثنائي الاتجاه الكامل. راجع [التدفق](/ar-Arab/guide/streaming) لمعرفة الحدّ.

## الجرد العام

تحتوي manifests المصدر الحالية على **45 حزمة `@go-like/*` غير خاصة**، وكلها بالإصدار `0.0.1` في هذا checkout، إضافة إلى **25 مسار source عاماً**. وتدخل `@go-like/struct` في هذا الجرد العام، وهي عقد وقت التشغيل الذي تستخدمه استدعاءات `Endpoint` typed. ولا تعد exports metadata من `dist/package.json` حزم إضافية أو APIs مصدرية.

استخدم [مرجع الحزم](/ar-Arab/reference/packages) لاختيار عقد أو مزوّد، ثم [مرجع المزوّدات](/ar-Arab/reference/providers) لمقارنة backend ودلالات بيئة التشغيل. يسجّل [الترحيل والتبنّي](/ar-Arab/guide/migration) مسارات التبنّي العملية ويذكّر بما لا يثبته المستودع.

## حدّ التحقق

أفاد تدقيق عقد المستودع بالنتائج المحلية الآتية على commit خط أساس التوثيق `9385dbf5b6a7d913be56a80ade359e1bf9be8675`: نجحت `bun run typecheck` و`bun run test:unit` و`bun run fmt:check`، وشملت الجذر والحزم والأمثلة ونطاق اختبارات الوحدة المعلن. وأفاد التدقيق بـ 2,736 اختبار وحدة، و1,514 ملفاً منسقاً، وتدقيق استيراد ناجحاً لكل 66 مدخلاً مصدّراً معلناً.

لكن ذلك التقرير **لم يثبت** `build` أو `doc:build` أو E2E لمزوّدات Docker أو التنفيذ عبر بيئات التشغيل أو مستهلكي tarball منشوراً أو النشر على npm أو hosted CI أو اعتماداً إنتاجياً أو soak لمدة 60 دقيقة. اقرأ [التحقق](/ar-Arab/reference/verification) قبل تحويل ادعاء مصدر أو script إلى ادعاء إصدار.

## الخطوات التالية

- [البدء](/ar-Arab/guide/getting-started): ثبّت من checkout أو استخدمه، وشغّل Web Handler، وافهم أول نقطة قبول في دورة الحياة.
- [البنية](/ar-Arab/guide/architecture): ادرس المسارات والملكية ونطاقات Context وترتيب دورة الحياة وقابلية النقل بين بيئات التشغيل.
- [حجز مواعيد العيادة](/ar-Arab/guide/zero-to-one): اتبع قاعدة عمل واحدة من طلب HTTP إلى استدعاء policy داخلي أحادي، ثم health والاختبارات والإيقاف.
- [استدعاءات الخدمات](/ar-Arab/guide/service-call): ابدأ بـ typed Memory Transport، ثم أضف discovery والاختيار وretry والتنظيف بصورة مقصودة.
- [الإعداد وRegistry وStore وCache](/ar-Arab/guide/config-registry-store): اختر عقود الحالة من دون طمس ضماناتها.
- [Broker والأحداث](/ar-Arab/guide/broker-events): حافظ على دلالات التسليم والإقرار والمستهلك الدائم والمهام الأصلية.
- [الصحة وقابلية الرصد](/ar-Arab/guide/health-observability): أضف readiness والمقاييس والتتبّع والسجلات من دون تثبيت بنية عامة خفية.
- [المقارنة](/ar-Arab/guide/comparison) و[الترحيل](/ar-Arab/guide/migration): قارن الملكية مع أطر الطرف الثالث وتبنَّ go-like تدريجياً.
- [الحزم](/ar-Arab/reference/packages) و[المزوّدات](/ar-Arab/reference/providers) و[التحقق](/ar-Arab/reference/verification): استخدم المسار المرجعي عندما تكون API أو حدود الدليل مهمة.

يوفّر `@go-like/protoc-gen-like` شيفرة Protobuf RPC مولّدة تضع `Context` أولاً، باستخدام Protobuf-ES. يوفّر `@go-like/transport-grpc-buf` عبر Fetch استدعاءات Connect/gRPC-Web الأحادية وتدفق استجابات الخادم؛ ويضيف `/native` معيار gRPC بالأنماط الأربعة، بما فيها تدفق طلبات العميل والتدفق ثنائي الاتجاه. هذا مسار مستقل عن Transport SPI الأحادي.

[قيود الإلغاء والإيقاف](/reference/claims#stream-cancellation-limits): Connect 2.1.2, Bun 1.4.2 Fetch, Deno 2.9.5/2.9.7.
