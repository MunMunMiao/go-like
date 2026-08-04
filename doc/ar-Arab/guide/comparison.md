# مقارنة go-like بالأدوات الأخرى

تبدأ المقارنة العادلة من الملكية، لا من قائمة عددية للميزات. تحلّ NestJS وFastify وHono وElysia وKoa وtRPC أجزاء مختلفة من مكدس تطبيقات TypeScript. أما go-micro وgo-kratos فهما مرجعان لإطارَي Go، ولهما اختيارات مختلفة في النقل وتوليد الشيفرة. go-like مجموعة لبنات TypeScript لبناء دورة حياة صريحة، واستدعاءات داخلية أحادية، وعقود المزوّدات، وتركيب يعمل عبر بيئات تشغيل متعددة.

تفصل هذه الصفحة مستويات الدليل:

- **Source** يعني أن checkout الحالي يعرِض API أو حدّاً مذكوراً.
- **Pinned external** يعني أن المقارنة تستخدم الإصدار أو commit أو الوثائق الرسمية المسجّلة في سجل البحث. وهذا ليس benchmark جديداً ولا ادعاءً بأن فرع `main` غير المثبّت لم يتغير.
- **Declared** يعني أن مثالاً أو مسار اختبار موجود في المستودع. ولا يعني أن النتيجة نجحت.
- **Gap** يعني أن المستودع الحالي لا يثبت التزام توافق.

خط أساس مصدر go-like لهذا المسار هو commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. يسجّل البحث المحلي تعارضاً في commit الخاص بـ go-micro: يذكر أحد سجلات المقارنة `9d306dcfc1a912a8a9493f31fee0bb983475258d`، بينما فحص المذكرة التفصيلية ذات الإصدار الثابت go-micro `v6.9.0` عند `3c39d17fadaa9ec21b671be4afef3e63846406e6`. تعامل مع هذين كمدخلَي مقارنة يجب إعادة التحقق منهما، لا كضمان حالي من upstream.

## موقع go-like في المكدس

| الأداة    | المشكلة الأساسية                       | ما تملكه عادةً                                                                                                                                                           | ما تكمله go-like ولا تستبدله                                                               |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| NestJS    | إطار Node لتطبيقات مبني على الاصطلاحات | Modules وproviders وcontrollers وdecorators وapplication context ودورة حياة الإطار ومحوّل HTTP أو microservice                                                           | حدّ دورة حياة بنيوي أو عقد استدعاء داخلي حول تطبيق أصلي، إذا كُتب جسر صريح                 |
| Fastify   | خادم HTTP في Node وخطّ معالجة الطلبات  | جدول المسارات وhooks وplugins وencapsulation ومستمع Node وكائنات request/reply                                                                                           | محوّل دورة حياة أو مزوّد حول مورد يملكه Fastify                                            |
| Hono      | توجيه Middleware وفق Web Standards     | المسارات وmiddleware وsub-apps و`app.fetch` واختيار محوّل بيئة التشغيل                                                                                                   | Core App ودورة حياة الموارد وClient/Transport الداخلي والاكتشاف                            |
| Elysia    | إطار Web typed موجّه أولاً إلى Bun     | شجرة المسارات وتركيب schema وdecorators وhooks ومحوّل Bun أو Web Standard                                                                                                | دورة حياة Core ولبنات الخدمة الداخلية مع الإبقاء على سلوك Elysia الأصلي                    |
| Koa       | نواة Middleware صغيرة في Node          | مكدس middleware ومستمع Node؛ وغالباً يكون الموجّه خارجياً                                                                                                                | دورة الحياة وعقود الخدمات الداخلية من دون إدخال موجّه آخر                                  |
| tRPC      | طبقة إجراءات typed                     | مسارات router/procedure وinput/output parsers وcontext factory ومحوّلات HTTP/Fetch/WS                                                                                    | ملكية المزوّدات وسياسة اكتشاف الخدمات ودورة حياة App الصريحة                               |
| go-micro  | منظومة Go للخدمات المصغّرة والوكلاء    | Go Context وتجريدات service/client/transport/registry/broker ومنظومة المزوّدات ونطاقات إضافية للوكلاء/التدفق/MCP/A2A                                                     | تستعير go-like بعض المفردات، لا Go ABI ولا goroutines ولا توافق النقل                      |
| go-kratos | إطار Go للخدمات السحابية الأصلية       | دورة حياة App وGo Context ونقلا HTTP/gRPC وmiddleware وregistry وconfig وتوليد Protobuf والشيفرة                                                                         | تشترك go-like في مفردات دورة الحياة الصريحة، لكنها تختار TypeScript/Web ولا تدّعي gRPC/IDL |
| go-like   | لبنات TypeScript صريحة لبناء الخدمات   | Context ودورة حياة App/Server وحافة Fetch القياسية ونقل Message الداخلي الأحادي وClient/Server وRegistry/Discovery/Selector وConfig/Store/Cache/Broker/Health والمحوّلات | يظل التطبيق مالك المسارات الأصلية ومستويات البيانات الأصلية وسياسة العمل والمصادقة والنشر  |

لذلك لا تحاول go-like الفوز بمقارنة «أكبر إطار». السؤال هو: هل يحتاج التطبيق إلى جعل هذه الحدود صريحة وقابلة للتركيب؟

## مصفوفة الملكية

| الاهتمام               | NestJS                                  | Fastify                           | Hono / Elysia / Koa                               | tRPC                                     | go-like                                                                  |
| ---------------------- | --------------------------------------- | --------------------------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| جدول المسارات الخارجية | Controllers وdecorators                 | Fastify instance                  | Framework instance أو external router             | Procedure router، وليس REST routes عادية | External framework أو التطبيق                                            |
| ABI لمعالج Web         | تجريد request/reply يملكه المحوّل       | Node request/reply                | Fetch القياسي محوري في Hono ومحوّلات Web Standard | Fetch/Node/Express/Fastify adapters      | `(Request) => Response \| Promise<Response>` القياسي                     |
| دورة حياة التطبيق      | Application context وhooks              | `ready` و`listen` و`close` وhooks | يختلف محوّل بيئة التشغيل ودورة الإطار             | مسؤولية المضيف/المحوّل                   | `newApp` و`App.run` و`App.stop` وhooks وServers بنيوية                   |
| دورة حياة المورد       | Hooks الحاوية/الإطار                    | Plugin وserver hooks              | مسؤولية التطبيق/بيئة التشغيل                      | مسؤولية التطبيق/المحوّل                  | عقود `Server.start(ctx)` / `stop(ctx)` الصريحة وملكية المكيّف            |
| تركيب الاعتماديات      | Nest container/providers                | Plugin decoration وencapsulation  | Context/env والتركيب؛ لا حاوية DI عامة            | Context factory صريح وتركيب router       | Constructors وخيارات وظيفية صريحة؛ لا حاوية DI                           |
| النقل الداخلي          | Microservice transports ومحوّلات الإطار | ليس تجريداً لاكتشاف الخدمات       | ليس تجريداً لاكتشاف الخدمات                       | Procedure adapters وWebSocket اختياري    | `Transport` و`Client` و`Listener` و`Socket` و`Message` الأحادية          |
| الاكتشاف والاختيار     | خاص بالنقل أو خارجي                     | خارجي                             | خارجي                                             | خارجي                                    | `Registry` و`Discovery` و`Watcher` وFilters وسياسات Selector الخمس       |
| إعادة المحاولة         | خاص بالإطار أو المزوّد                  | خاص بالتطبيق/الإضافة              | خاص بالتطبيق                                      | خاص بالmiddleware/المحوّل                | محاولة واحدة افتراضياً؛ و`withRetry` يتطلب تفويضاً وعدد محاولات إجمالياً |
| التدفق                 | خيارات الإطار/المزوّد                   | خيارات Node/Web stream            | Web Streams الأصلية وواجهات الإطار                | يعتمد على المحوّل HTTP/WS                | التدفق العام أصلي في Web؛ وRPC الداخلي أحادي                             |
| القياس العام           | تكامل الإطار/المزوّد                    | منظومة Plugins                    | منظومة Middleware                                 | Middleware/adapters                      | أغلفة صريحة؛ لا تثبيت لمزوّد عام                                         |

تصف الصفوف الخمسة الأولى مواقع معمارية، لا ترتيب جودة. قد تكون ملكية إطار لجدول المسارات مفيدة عندما تكون مشكلة تركيب المسارات هي الأساس. لكنها ببساطة اختيار ملكية مختلف عن ترك go-like المسارات للتطبيق.

## دورة الحياة وContext

يعرّف مصدر go-like الحالي ما يأتي:

```ts
interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}
```

عقد `Server` بنيوي. يمكن لعامل أصلي أو مستمع أو مجدول أو اشتراك Broker أو وجهة سجلات أو مزوّد قياس الانضمام إلى Core إذا استطاع محوّل أن يصف بصدق سلوك القبول والحالة النهائية.

كما أن go-like `Context` بنيوي ويستخدم `AbortSignal` داخلياً. يعرِض `deadline()` و`done()` و`err()` و`value(key)`، مع مُنشئات مثل `background` و`withCancel` و`withCancelCause` و`withTimeout` و`withDeadline` و`withoutCancel` و`withValue`.

يشبه ذلك أسلوب Go الصريح الذي يضع Context أولاً، لكنه ليس متوافقاً ABI مع `context.Context`. ولا يوفّر goroutines أو channels أو gRPC. سؤال الترحيل الصحيح هو «أين يعبر الإلغاء والملكية هذا الحد؟»، لا «أي اسم نوع متطابق؟».

لا تضمن Core إيقاف Servers الأشقاء بترتيب عكسي. فهي تستدعي `stop(ctx)` للأشقاء بالتوازي، ثم تنتظر Promises الخاصة بـ `start` وتجمع حالات الفشل. قد يملك Nest application context أو شبكة Plugins في Fastify أو دورة حياة Elysia أو محوّل المضيف ترتيباً وحالة نهائية مختلفين. قارن المالك الفعلي، لا تسمية «graceful».

## النقل واستدعاءات الخدمات

يتكوّن مسار الاستدعاء الداخلي في go-like عمداً من أجزاء منفصلة:

```text
Client
  -> Discovery snapshot, optional
  -> ordered Filter callbacks, optional
  -> Selector.select
  -> opaque ServiceEndpoint URL
  -> Transport.dial or resident logical owner
  -> send(Message)
  -> @go-like/server route and unary handler
  -> recv(Message)
  -> feedback and owner release
```

يربط `Endpoint` typed تحقق `Struct` من الطلب والاستجابة بحدّ `Message` الموجود. وليس هو IDL ولا بروتوكولاً مولّداً. يتجاوز `withAddress(...)` كلاً من Discovery وSelector، ما يجعل مسار Memory Transport داخل العملية اختباراً أولياً مفيداً.

لا تتطابق خيارات نقل microservice في NestJS أو محوّلات إجراءات tRPC أو نقولات أطر Go مع هذا الرسم البياني بالضرورة. فقد يملك كل منها هوية مسار أو نموذج تسلسل أو pool اتصالات أو طبقة retry مختلفة. يجب أن تسجل المقارنة هذه الفروق بدلاً من تعليم كل مربعات «RPC» بأنها الميزة نفسها.

## نطاق retry والتدفق

المقارنة السلبية الأهم تتعلق بالدلالات:

- تنفّذ استدعاءات go-like محاولة واحدة بالضبط افتراضياً.
- يتطلب `withRetry(...)` قيمة `authorization: "idempotent" | "caller-approved"`، وقيمة موجبة لـ `maxAttempts`، ودالة `shouldRetry`.
- التفويض إعلان من المستدعي، وليس برهاناً على idempotency.
- قد تختار retry نقطة نهاية جديدة، لأن كل محاولة تعود إلى discovery والاختيار.
- لا تعاد محاولة استجابة استُلمت بالفعل ثم تبعتها مشكلة في feedback أو التنظيف.

يسجّل بحث المقارنة حول Go افتراضات وقدرات مختلفة: ليست `DefaultRetries` في go-micro عبارة بسيطة من نوع «خمس طلبات إجمالاً»، إذ يمكن لحدود الحلقة أن تنتج ست دورات عندما يبقى السماح بالretry صحيحاً؛ كما يختلف شكل public stream وتنفيذ `CloseSend` الافتراضي باختلاف المزوّد. ويجمع go-kratos توليد Protobuf/gRPC مع أشكال تدفق HTTP، حيث يختلف SSE وWebSocket في الاتجاه وسلوك الإغلاق. هذه اختيارات للمزوّد والمعمارية، وليست أعلاماً ناقصة في go-like.

في go-like:

```text
Web framework or Fetch Handler
  -> Web Streams, SSE, or WebSocket behavior owned by the application/framework

go-like internal Client/Transport
  -> one unary Message request and one unary Message response
  -> no full-duplex RPC Stream SPI
```

إن `ReadableStream` في Web ليس قناة RPC داخلية. لا تقارن جسم HTTP متدفقاً بتبادل نقل متعدد الإطارات من `send` و`recv` وكأنهما ميزة واحدة.

## مقارنة بيئات التشغيل

| سؤال بيئة التشغيل                                                 | دليل go-like                                                                                  | نتيجة المقارنة                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| هل يستطيع الكود المشترك استخدام Fetch و`AbortSignal`؟             | تستخدم Web وproviders مختارة للنقل/الإعداد Web APIs قياسية أو Fetch محقوناً                   | يمكن تحقيق أهداف قابلية نقل مشابهة، لكن الأنواع لا تملأ سلوك بيئة التشغيل |
| هل يستطيع package واحد ربط مستمع Node ومستمع Deno؟                | المسارات الخاصة بالبيئة صريحة؛ `@go-like/web/node` و`@go-like/transport-http/node` مسارا Node | لا تكتب «كل الحزم تعمل بلا تغيير في كل مكان»                              |
| هل يمكن لـ Fetch محمول استخدام PEM TLS وmTLS وALPN وHTTP/2 مخصصة؟ | يملك مسار نقل Node السلوك الأصلي؛ ولا يعرِض مسار Fetch الجذري كل عناصر التحكم                 | قارن قدرات المضيف ومسارات الاستيراد، لا أسماء الحزم فقط                   |
| هل يحتفظ التطبيق بموجّه الإطار؟                                   | تمرر أمثلة Hono وElysia وH3 معالجات Fetch الأصلية                                             | go-like تكمل ملكية مسارات الإطار ولا تستبدلها                             |
| هل يثبت إصدار الحزمة نشرها؟                                       | الجذر والحزم private/`0.0.1`؛ وتقول وثائق المستودع إنها لم تُنشر بعد                          | لا ادعاء بتوفر npm أو نضج المنظومة                                        |

يحتوي المستودع الحالي على أمثلة مصدر مباشرة لـ Hono وElysia وH3 وFetch بلا إطار. ولا يحتوي على جسر حالي لـ NestJS أو Fastify ولا على compatibility suite لهما. هذه جماهير ترحيل، لا تكاملات مباشرة مدعومة.

## مقارنة مفصلة حسب الأداة

### NestJS

NestJS إطار تطبيقات مبني على الاصطلاحات. تشكل modules وproviders وcontrollers وdecorators وinterceptors وpipes وhooks التطبيق حاوية متماسكة ونموذج طلب موحداً. لا توفّر go-like حاوية modules متوافقة مع Nest ولا جسراً للـ controllers.

حدّ التكامل المعقول هو محوّل يملكه التطبيق يطبّق `Server` البنيوي حول تطبيق Nest أو المضيف. وسيحتاج المحوّل إلى تعريف وقت قبول Nest للمستمع، وكيف يترجم `stop(ctx)` إلى إغلاق Nest، وما يحدث بعد انقضاء المهلة. لا يثبت المستودع الحالي مثل هذا الجسر، لذلك يجب ألا تعرض الوثائق استدعاءً مباشراً من نوع `newNodeServer(nestApp, ...)`.

### Fastify

يملك Fastify جدول المسارات وplugin encapsulation وhooks ومستمع Node. وتعد شبكة Plugins فيه مقارنة مفيدة لنطاق الاعتماديات، لكن `decorate` ليست حاوية providers عامة على طريقة Nest. لا تحوّل go-like ABI الخاص بـ Fastify `request`/`reply` إلى Fetch Handler تلقائياً، ولا يوجد جسر Fastify حالي مختبر في المستودع.

أبقِ مسارات وPlugins Fastify أصلية. وإذا اعتُمد go-like، فاكتب `Server` بنيوياً صريحاً حول مالك Fastify أو اعرض حد Fetch منفّذاً بصورة منفصلة. لا تسمِّ حقن الطلبات الخاص بـ Fastify أو إيقافه الأصلي عقد Transport أو Client في go-like.

### Hono

Hono هو أوضح مثال موضّح على التكامل المكمل. ينشئ المثال الحالي المسارات في Hono، ويمرر `app.fetch` إلى `newNodeServer`، ويضع ذلك المضيف في Core App. تبقى ملكية المسارات والـ middleware لدى Hono؛ وتملك go-like حد دورة حياة المضيف عندما يختار التطبيق ذلك.

### Elysia

يوفر Elysia نموذج تركيب للمسارات والمخططات موجهاً أولاً إلى Bun، كما يعرِض Web Standard Handler في مسار المحوّل ذي الصلة. احتفظ بشجرة مسارات Elysia وdecorators وderives وhooks وstreams وسلوك Bun الخاص. يمكن لـ go-like أن تملك App وحداً صريحاً للمورد، لكنها لا تجعل `.listen()` API عابرة لبيئات التشغيل في go-like.

### Koa

Koa نواة Middleware صغيرة في Node ولا تتضمن موجّهاً. وهذا يجعله مثالاً مفيداً لإطار يترك عمداً مزيداً من تركيب التطبيق خارج النواة. لا ينبغي لـ go-like سد هذه الفجوة بإضافة موجّه. أبقِ Middleware Koa وأي موجّه خارجي أصليين، ثم أضف حد دورة حياة أو استدعاء داخلياً حيث توجد حاجة حقيقية.

### tRPC

tRPC يملك router typed للإجراءات وmiddleware الإجراءات. ويمكنه استخدام محوّلات Fetch أو Node أو Express أو Fastify أو WebSocket، لكنه ليس Registry ولا Selector ولا pool اتصالات ولا مدير دورة حياة تطبيق. إن `Endpoint` typed في go-like ربط Struct أصغر وقت التشغيل فوق Message أحادية، وليس DSL لإجراءات منافساً ولا IDL مولّداً.

### go-micro وgo-kratos

يفيدان هذان المشروعان Go بوصفهما مرجعين معماريين لـ Context-first calls ودورة حياة الخدمة وRegistry وDiscovery وSelector ومفردات النقل. لكنهما ليسا هدفَي توافق:

- تشترك `context.Context` في Go و`Context` في go-like في نية الإلغاء الصريح، لكن تمثيلهما وقت التشغيل مختلف.
- لا ينبغي تعليم نموذج Registry watcher في go-micro على أنه stream أحداث مطابق للقطات الاستبدال الكاملة في go-like.
- يختار go-kratos Protobuf/gRPC والشيفرة المولّدة، بينما تصرّ go-like صراحةً على أنها لا تدّعي ذلك.
- تعتمد افتراضات go-micro وgo-kratos في المزوّدات وحلقات retry وسلوك half-close في stream والاختيار الافتراضي على الإصدار. استخدم جدول commits الثابتة في سجل البحث وأعد التحقق قبل نشر مقارنة جديدة مرتبطة بإصدار.

## ماذا تختار؟

| إذا كانت مشكلتك الأساسية هي...                   | ابدأ بـ...            | أضف go-like عندما...                                                              |
| ------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------- |
| Controllers وmodules وdecorators وDI             | NestJS                | تحتاج إلى حد صريح حول مورد موجود أو استدعاء خدمة داخلي، ومستعد لكتابة المحوّل     |
| مسارات HTTP في Node وhooks وplugin encapsulation | Fastify               | تحتاج إلى تركيب دورة حياة يتجاوز المضيف أو إلى عقود خدمة داخلية                   |
| مسارات Web Standards عبر بيئات التشغيل           | Hono                  | تحتاج إلى دورة حياة App/Server أو استدعاءات داخلية أو ملكية للمزوّدات             |
| تركيب مخططات ومسارات موجّه إلى Bun               | Elysia                | تحتاج إلى حدود صريحة لدورة الحياة والنقل مع الإبقاء على Elysia                    |
| Middleware بسيط في Node                          | Koa مع موجّه          | تحتاج إلى عقد دورة الحياة أو الاستدعاء الداخلي الناقص، لا إلى موجّه آخر           |
| إجراءات typed                                    | tRPC                  | تحتاج أيضاً إلى اكتشاف خدمة صريح أو ملكية للمزوّد أو دورة حياة Core               |
| مكدس الخدمات المصغّرة في Go                      | go-micro أو go-kratos | تبني تركيباً منفصلاً في TypeScript، لا منفذاً متوافقاً على مستوى الشيفرة المصدرية |
| لبنات بناء خدمات TypeScript عبر بيئات التشغيل    | go-like               | استخدم فقط الحزم والمزوّدات التي تحلّ الحد المطلوب                                |

قد يكون الجواب الصحيح هو استخدام النظامين معاً. تكون go-like مفيدة عندما يزيل نموذج الملكية الصريح غموضاً فعلياً؛ وإضافة كل الحزم إلى تطبيق إطار مكتمل أصلاً تهزم هدف اللبنات الصغيرة.

## مراجع الدليل

يمكن تتبع ادعاءات go-like في هذه الصفحة إلى شجرة المستودع ونقاط دخول الحزم الحالية:

- `README.md` لنطاق المنتج والاستبعادات الصريحة؛
- `packages/core/src/app.ts` لـ `App` و`Server` وسلوك البدء والإيقاف والمهلة؛
- `packages/web/src/context.ts` لـ Handler القياسي وجسر Context؛
- `packages/client/src/index.ts` لخيارات Client وpooling وretry ومسار المحاولة؛
- `packages/server/src/index.ts` للمعالجات الداخلية الأحادية وتوجيه المسارات؛
- `packages/transport/src/types.ts` و`packages/transport/src/endpoint.ts` لحدود Message وtyped Endpoint؛
- `packages/registry/src/types.ts` و`packages/registry/src/selector.ts` للقطات والمرشحات والمحدّدات وfeedback.

ويخزّن سجل البحث أيضاً مدخلات المقارنة الخارجية المثبتة التالية:

- [commit مقارنة go-micro المسجّل في المستودع](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)؛
- [commit مقارنة go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)؛
- [commit مقارنة go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)؛
- [وثائق دورة حياة NestJS](https://docs.nestjs.com/fundamentals/lifecycle-events)، و[مرجع خادم Fastify](https://fastify.dev/docs/latest/Reference/Server/)، و[واجهة Hono البرمجية](https://hono.dev/docs/api/hono)، و[دورة حياة Elysia](https://elysiajs.com/essential/life-cycle)، و[Koa](https://koajs.com/)، و[موجّهات tRPC](https://trpc.io/docs/server/routers).

هذه الروابط مراجع للمقارنة، وليست ادعاءً بأن مرحلة التوثيق هذه جلبت كل صفحة upstream أو أعادت التحقق منها. أعد فحص وسوم الإصدارات أو commits قبل تغيير عبارة حساسة للإصدار في المقارنة.
