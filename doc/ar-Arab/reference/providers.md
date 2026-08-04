# مرجع الحزم والمزوّدات

تنظّم هذه الصفحة المعلومات حول السؤال الذي يحاول التطبيق حله، لا حول ترتيب مجلد `packages/`. استورد من أصغر حزمة عامة تملك العقد. ويُعرَض السلوك الخاص ببيئة التشغيل عبر مسار فرعي صريح. حزم المزوّدات ليست تطبيقات متبادلة تملك ضماناً كونياً واحداً.

## كيف تقرأ هذه الصفحة

- **العقد** يعني واجهة محمولة أو محايدة تجاه المزوّد.
- **المزوّد** يعني تطبيقاً يعتمد على الذاكرة أو ملف أو خدمة شبكة أو مكتبة أصلية.
- **محوّل دورة الحياة** يعني غلاف `Server` حول مورد أصلي أنشأه التطبيق.
- **الدليل** يحدد نوع سند المستودع: مصدر/تصدير، أو اختبارات معلنة، أو نتيجة أمر محلي مُبلّغ عنها. ولا يحوّل إصدار الحزمة إلى ادعاء بالنشر على npm أو بالتوفر في الإنتاج.

يحتوي جرد المصدر الحالي على 43 manifest لحزم `@go-like/*` غير خاصة، و23 مسار source عاماً، وكلها بالإصدار `0.0.1` في هذا checkout. أما مساحات العمل الـ44 ضمن `examples/*` فهي تطبيقات خاصة وليست حزم عامة.

## اختر حسب المهمة

| المهمة                       | ابدأ بـ                                | أضف عند الحاجة                                                         | ما لا تملكه go-like                                      |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| عرض Web API                  | `@go-like/web`, `@go-like/core`          | `@go-like/web/node` أو Fetch Handler أصلي لإطار ما                      | Router وmiddleware الإطار وauth وسياسة الاستجابة        |
| استدعاء خدمة داخلية          | `@go-like/client`, `@go-like/transport`  | `@go-like/transport-memory`, `@go-like/transport-http`, `@go-like/struct` | idempotency الخاصة بالعمل وIDL المولّد وfull-duplex RPC |
| اكتشاف مثيلات الخدمة         | `@go-like/registry`                     | مزوّد Registry وfilters وSelector                                      | اتساق lease/revision في backend أو service locator عام  |
| تحميل الإعداد                | `@go-like/config`                       | env/file/YAML أو مزوّد Config خارجي                                    | إعداد عام ضمني ومعاملات بين الموارد                     |
| تخزين bytes مرجعية           | `@go-like/store`                        | مزوّد Memory أو File أو Consul أو etcd أو Vault                        | قاعدة بيانات/ORM عامة أو ضمانات موحدة للمزوّد           |
| تخزين قيم مؤقتة قابلة للتخلص | `@go-like/cache`                        | مزوّد Memory أو Redis                                                  | المرجعية أو الاستمرارية أو CAS أو حالة العمل الدائمة    |
| نشر bytes أو استهلاكها       | `@go-like/broker`                       | Memory أو RabbitMQ أو NATS                                             | ack/nack/term عامة وDLQ وoffset دائم وexactly-once      |
| إضافة payloads typed للأحداث | `@go-like/event`                        | Codec يملكه التطبيق                                                    | schema registry أو replay أو سياسة التسوية              |
| تشغيل مجدول أو worker موجود  | `@go-like/core`                         | `@go-like/croner` أو `@go-like/bullmq` أو `@go-like/nats`                 | queue أو processor أو سياسة job أو اتصال broker         |
| إضافة العمليات التشغيلية     | `@go-like/health`, `@go-like/resilience` | Pino أو Winston أو OTel أو Prometheus                                  | القياس العام أو auth أو سياسة النشر                     |

## الحزم الأساسية

| الحزمة               | استخدمها من أجل                                       | أهم API عامة                                                                                                                                                                                                      | ملاحظة بيئة التشغيل والملكية                                                             |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@go-like/context`    | الإلغاء والمهل والأسباب والقيم الصريحة                | `background`, `todo`, `withCancel`, `withCancelCause`, `withDeadline`, `withDeadlineCause`, `withTimeout`, `withTimeoutCause`, `cause`, `withoutCancel`, `withValue`, `afterFunc`, `canceled`, `deadlineExceeded` | عقد مصدر محمول. يستخدم `Context` داخلياً `AbortSignal`؛ وليس Go ABI ولا حقيبة DI         |
| `@go-like/core`       | تركيب دورة حياة التطبيق والموارد                      | `newApp`, `server`, `registrar`, `beforeStart`, `afterStart`, `beforeStop`, `afterStop`, `startTimeout`, `stopTimeout`, `context`, `id`, `name`, `version`, `metadata`, `endpoint`, `newContext`, `fromContext`   | `Server` و`App` بنيويان ومحمولان. يجري إيقاف الأشقاء بالتوازي                            |
| `@go-like/metadata`   | بيانات وصفية متعددة القيم غير قابلة للتغيير ونشر صريح | أنواع metadata ودوال نشرها                                                                                                                                                                                        | نطاقا metadata في Client وServer منفصلان؛ والـ metadata ليست هوية موثوقة                 |
| `@go-like/struct`     | تحقق Struct وقت التشغيل لنقاط النهاية typed وJSON     | `struct`, `Infer`, `Struct`, `StructError`, `setErrorMap`                                                                                                                                                         | حزمة عامة حالية. تحقق وقت التشغيل، وليست Protobuf أو IDL أو شيفرة مولّدة                 |
| `@go-like/health`     | سجل فحوص liveness وreadiness                          | `newProbeRegistry`, `ProbeRegistry`, `Probe`, `ProbeReport`                                                                                                                                                       | تنجح liveness الفارغة؛ وتفشل readiness الفارغة افتراضياً؛ مهلة الفحص الافتراضية 1,000 ms |
| `@go-like/resilience` | retry صريح وcircuit breaker وrate limiting غير حاجب   | `retry`, `exponentialBackoff`, `newCircuitBreaker`, `newTokenBucketLimiter`, `circuitOpen`                                                                                                                        | يصرّح المستدعي بتفويض retry؛ لا idempotency تلقائية ولا مهمة limiter في الخلفية          |

## حزم Web والاستدعاء الداخلي

| الحزمة                        | استخدمها من أجل                                                             | أهم API عامة                                                                                                                                                                                                 | ما لا تملكه                                                                    |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `@go-like/web`                 | Web Handler القياسي وجسر Context للطلب                                      | `Handler`, `ContextHandler`, `contextHandler`                                                                                                                                                                | Routes وWebSockets وسياسة SSE وlistener والمصادقة                              |
| `@go-like/web/health`          | مسارات Health Handler                                                       | `createHealthHandler`                                                                                                                                                                                        | تسجيل probes أو تركيب مسارات الإطار                                            |
| `@go-like/web/node`            | Listener في Node حول Fetch Handler                                          | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout`                                                                                                                                                   | TLS/HTTP2 في HTTP Transport الداخلي؛ استخدم `@go-like/transport-http/node` لذلك |
| `@go-like/client`              | استدعاءات داخلية أحادية وdiscovery وselection وmiddleware وretries وpooling | `newClient`, `withTransport`, `withAddress`, `withDiscovery`, `withSelector`, `withFilter`, `withBlock`, `withRetry`, `middleware`, `use`, `circuitBreakerMiddleware`, `closeTimeout`, `poolSize`, `poolTtl` | Routes الإطار وسلامة replay في العمل وحدود sockets الفعلية                     |
| `@go-like/server`              | خادم Message داخلي أحادي وتوجيه routes                                      | `newServer`, `transport`, `address`, `advertise`, `handler`, `middleware`, `use`, `listenOption`, `rateLimitMiddleware`                                                                                      | Fetch routes الخارجية وتفويض العمل الخاص بالبروتوكول                           |
| `@go-like/transport`           | Transport SPI وحدّ Message                                                  | `Transport`, `Client`, `Listener`, `Socket`, `Message`, `TransportInfo`, `Endpoint`, `endpoint`, `chain`, `serviceError`                                                                                     | سلك فعلي إن لم يُختَر مزوّد؛ ولا وعد بـ full-duplex داخلي                      |
| `@go-like/transport-memory`    | Transport أحادي داخل العملية                                                | `newMemoryTransport`                                                                                                                                                                                         | سلوك بين العمليات أو persistence أو network fallback أو TLS                    |
| `@go-like/transport-http`      | HTTP Transport داخلي مبني على Fetch                                         | `newHTTPTransport`, `executor`, `maxMessageBytes`                                                                                                                                                            | Listener محمول كامل بلا `HTTPHost` محقون؛ ولا عناصر TLS أصلية في Node          |
| `@go-like/transport-http/node` | HTTP Transport داخلي أصلي في Node                                           | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`                                                                                                                                                           | Listener في Deno أو سياسة أمان تلقائية                                         |

## حزم Config

| الحزمة أو المسار الفرعي     | استخدمه من أجل                    | الدالة الرئيسية                                                                                                        | الحدّ                                                                       |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@go-like/config`            | مدير Config ومصادر object         | `newConfig`, `source`, `objectSource`, `schema`, `resolver`, `placeholderResolver`, `onReloadError`, `onTerminalError` | لقطات غير قابلة للتغيير ودورة حياة watcher مقبولة؛ ليس Core Server بحد ذاته |
| `@go-like/config/env`        | مصدر صريح لسجل البيئة             | `envSource`                                                                                                            | يقبل record محقوناً؛ ولا يقرأ globals الضمنية لبيئة التشغيل                 |
| `@go-like/config/file`       | مصدر ملف وعقد JSON decoder        | `fileSource`, `jsonFileDecoder`                                                                                        | يحتاج إلى capability صريحة للملف                                            |
| `@go-like/config/node`       | capability ملف في Node            | `newNodeFileCapability`                                                                                                | مسار فرعي خاص ببيئة Node                                                    |
| `@go-like/config/yaml`       | فك YAML إلى ConfigObject          | `decodeYaml`                                                                                                           | فك الترميز ليس مراقبة مصدر ولا نشر مخطط                                     |
| `@go-like/config-consul`     | مصدر إعداد Consul عبر HTTP        | `consulSource`, `jsonConsulDecoder`                                                                                    | سلوك blocking-query واتساق خاصان بـ Consul                                  |
| `@go-like/config-etcd`       | مصدر إعداد عبر etcd gateway       | `etcdSource`, `jsonEtcdDecoder`                                                                                        | revision وcompaction وبروتوكول gateway                                      |
| `@go-like/config-kubernetes` | مفتاح واحد من ConfigMap أو Secret | `kubernetesSource`, `jsonKubernetesDecoder`                                                                            | دلالات resource-version/relist؛ ولا معاملة بين الموارد                      |
| `@go-like/config-vault`      | مصدر Vault KV v2                  | `vaultSource`                                                                                                          | مصادقة Vault وTLS وسياسة token ودلالات KV                                   |

تستخدم مزوّدات Config الخارجية Fetch قياسياً محقوناً. ولـ credentials وredirects سلوك أمان خاص بكل مزوّد؛ وتظل `http` مقابل `https` قراراً للتطبيق أو للنشر، ما لم يرفضه المزوّد.

## حزم Registry

| الحزمة                        | استخدمها من أجل                      | الدالة الرئيسية                                                                                                                                    | ملاحظة بيئة التشغيل/backend                                        |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@go-like/registry`            | العقد وsnapshot وfilters وselectors  | `filterVersion`, `filterLabel`, `newRandomSelector`, `newRoundRobinSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | لقطات استبدال كاملة؛ وfeedback الاختيار صريح                       |
| `@go-like/registry/provider`   | مساعدات مؤلفي المزوّد وتشخيص التسجيل | `providerOptions`, `notifyRegistrationError`, مساعدات snapshot/provider                                                                            | مسار فرعي للمزوّد، وليس نقطة الدخول المعتادة للتطبيق               |
| `@go-like/registry-consul`     | تسجيل Consul واكتشافه                | `newConsulRegistry`                                                                                                                                | health-filtered وblocking-query وTTL وسلوك critical أصلي في Consul |
| `@go-like/registry-etcd`       | تسجيل etcd واكتشافه                  | `newEtcdRegistry`                                                                                                                                  | Leases وrevisions وwatch/relist وcompaction                        |
| `@go-like/registry-kubernetes` | اكتشاف EndpointSlice وتسجيل اختياري  | `newKubernetesRegistry`                                                                                                                            | Kubernetes EndpointSlice وowner references؛ ولا TTL مختلق          |
| `@go-like/registry-mdns`       | اكتشاف multicast محلي                | `newMDNSRegistry`                                                                                                                                  | المزوّد الجذري محمول عمداً؛ وUDP host في `/node`                   |
| `@go-like/registry-mdns/node`  | capability multicast UDP في Node     | `newNodeMDNSHost`                                                                                                                                  | مسار فرعي صريح لبيئة Node                                          |
| `@go-like/registry-zookeeper`  | تسجيل ZooKeeper المؤقت واكتشافه      | `newZookeeperRegistry`                                                                                                                             | Node.js وBun موثقان؛ وDeno غير مدعوم صراحةً                        |

يمثل Registry حالة قابلية الوصول، لا بيانات العمل الدائمة. قد يحتفظ المزوّد بآخر snapshot أثناء إعادة بناء watcher مؤقت، لكن snapshot الفارغ المرجعي يجب أن يفشل مغلقاً.

## حزم Store وCache

| الحزمة                    | استخدمها من أجل                   | الدالة الرئيسية                                                                                                    | الحدّ                                                                        |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `@go-like/store`           | عقد السجل والخيارات               | `expiresIn`, `ifAbsent`, `ifRevision`, `prefix`, `limit`, `cursor`, `writeOptions`, `deleteOptions`, `listOptions` | revisions وCAS وTTL وpagination؛ وتختلف قدرات المزوّد                        |
| `@go-like/store/provider`  | مساعدات write/delete/list للمزوّد | `writeOptions`, `deleteOptions`, `listOptions`, ومساعدات snapshot وconflict                                        | موجّه للمزوّد؛ وليس backend دائماً بحد ذاته                                  |
| `@go-like/store-memory`    | اختبارات Store داخل العملية       | `newMemoryStore`, `clock`                                                                                          | لا durability بعد restart ولا حالة بين العمليات                              |
| `@go-like/store-file`      | Store محلي في ملف                 | `newFileStore`                                                                                                     | حالة محلية لمالك واحد؛ استخدم `/node` لمضيف Node                             |
| `@go-like/store-file/node` | capability ملف في Node            | `newNodeFileStoreHost`                                                                                             | مسار فرعي صريح لـ Node                                                       |
| `@go-like/store-consul`    | Store KV في Consul                | `newConsulStore`                                                                                                   | جلسات Consul وتركيبات TTL/CAS وسلوك mutation غير اليقيني                     |
| `@go-like/store-etcd`      | Store KV في etcd                  | `newEtcdStore`                                                                                                     | Gateway وlease وrevision وcompaction وسلوك mutation غير اليقيني              |
| `@go-like/store-vault`     | Store Vault KV v2                 | `newVaultStore`                                                                                                    | لا يَعِد بدلالات TTL/CAS موحدة لـ Store                                      |
| `@go-like/cache`           | عقد قيم مؤقتة/TTL                 | `expiresIn`, `putOptions`                                                                                          | لا CAS ولا revision ولا durability ولا authority                             |
| `@go-like/cache-memory`    | Cache داخل العملية                | `newMemoryCache`, `clock`                                                                                          | لا persistence؛ انتهاء كسول؛ مناسب للاختبارات والتسريع المحلي                |
| `@go-like/cache-redis`     | Cache مبني على Redis              | `newRedisCache`                                                                                                    | اتصال Redis أصلي ومعالجة credentials في URL ومتطلبات بيئة التشغيل تبقى ظاهرة |

## حزم Broker وevent والعمل

| الحزمة أو المسار الفرعي         | استخدمه من أجل                                   | الدالة الرئيسية                                                                | الحدّ                                                           |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `@go-like/broker`                | عقد Broker للـ bytes/topics                      | `newBrokerServer`                                                              | لا ack/nack/term أو DLQ أو retry أو offset دائم محمول           |
| `@go-like/broker/provider`       | تسجيل النهاية الطرفية للمزوّد                    | `registerSubscriberTerminal`, `subscriberTerminal`                             | حفظ دورة الحياة الموجّه للمزوّد                                 |
| `@go-like/broker-memory`         | Broker داخل العملية بمواضيع exact                | `newMemoryBroker`                                                              | خاص بالمثيل، broadcast، ومن دون تسوية دائمة                     |
| `@go-like/broker-rabbitmq`       | Broker RabbitMQ المستعار أو المؤكِّد أو المستعيد | `newRabbitMqBroker`, `newConfirmRabbitMqBroker`, `newRecoveringRabbitMqBroker` | قناة/اتصال `amqplib` ودلالات التسوية الأصلية                    |
| `@go-like/event`                 | Codec typed فوق Broker                           | `eventBroker`                                                                  | يبقى التسليم الأصلي ظاهراً؛ لا replay ولا schema registry       |
| `@go-like/nats`                  | دورة حياة NATS ونقاط دخول broker الأصلية         | `newNatsCoreServer`, `natsCoreDrainTimeout`                                    | اتصال Core ودلالات الاشتراك تبقى أصلية                          |
| `@go-like/nats/broker`           | NATS Core Broker                                 | `newNatsCoreBroker`                                                            | `Msg` أصلي وqueue group وdrain ودلالة at-most-once              |
| `@go-like/nats/jetstream`        | دورة حياة ConsumerMessages في JetStream          | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`                          | سلوك close/stop/closed الأصلي لـ ConsumerMessages               |
| `@go-like/nats/jetstream/broker` | Broker bytes typed فوق JetStream                 | `newNatsJetStreamBroker`                                                       | تبقى `JsMsg` و`PubAck` وack/nak/term وredelivery وDLQ أصلية     |
| `@go-like/croner`                | دورة حياة وظائف Croner الموجودة                  | `newCronerServer`                                                              | schedule وcallback وoverlap والدلالة النهائية السلبية لـ Croner |
| `@go-like/bullmq`                | دورة حياة BullMQ Worker الموجود                  | `newBullMqWorkerServer`, `bullMqWorkerShutdownTimeout`                         | queue وRedis وprocessor وretry/backoff وstalled jobs وهوية job  |

## حزم التسجيل وقابلية الرصد

| الحزمة               | استخدمها من أجل                              | الدالة الرئيسية                                                                                                                                                                     | ما لا تملكه                                                      |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `@go-like/pino`       | أغلفة Pino للطلبات/الوسطاء ودورة حياة drain  | `logClient`, `logUnaryMiddleware`, `logWebHandler`, `logBroker`, `newPinoServer`, `pinoDrainTimeout`                                                                                | إنشاء logger وسياسة الوجهة والإخفاء والإعداد العام               |
| `@go-like/winston`    | أغلفة Winston ودورة حياة الإيقاف             | أغلفة logging و`newWinstonServer`                                                                                                                                                   | logger/transports ودلالات finish/close الأصلية                   |
| `@go-like/otel`       | أغلفة OpenTelemetry الصريحة للتتبّع/المقاييس | `newOtelServer`, `traceClient`, `traceUnaryMiddleware`, `traceWebHandler`, `traceBroker`, `measureClient`, `measureClientMiddleware`, `measureUnaryMiddleware`, `newRequestMetrics` | المزوّدات العامة والمصدّرات ومدير السياق والقياس التلقائي        |
| `@go-like/prometheus` | مقاييس الطلبات وscrape Handler في Prometheus | `newRequestMetrics`, `measureClient`, `measureUnaryMiddleware`, `measureWebHandler`, `measureBroker`, `createPrometheusHandler`                                                     | Registry العام وcollectors خارج Registry المقدّم والمهام الخلفية |

## الجرد الكامل لمسارات المصدر العامة

هذه هي مسارات المصدر العامة الـ23 الصريحة التي تعلنها manifests الحزم الحالية. قد تضيف الحزم المولّدة export باسم `./package.json` يحوي metadata فقط؛ وهذا ليس حزمة إضافية ولا API مصدر.

|   # | المسار الفرعي                   | أهم الصادرات                                               | الجمهور                       |
| --: | ------------------------------- | ---------------------------------------------------------- | ----------------------------- |
|   1 | `@go-like/broker/provider`       | `registerSubscriberTerminal`, `subscriberTerminal`         | مؤلفو المزوّدات               |
|   2 | `@go-like/cache/provider`        | `putOptions`                                               | مؤلفو المزوّدات               |
|   3 | `@go-like/config/env`            | `envSource`                                                | مؤلفو التطبيقات               |
|   4 | `@go-like/config/file`           | `fileSource`, `jsonFileDecoder`                            | مؤلفو التطبيقات               |
|   5 | `@go-like/config/node`           | `newNodeFileCapability`                                    | مؤلفو بيئة Node               |
|   6 | `@go-like/config/yaml`           | `decodeYaml`                                               | مؤلفو التطبيقات               |
|   7 | `@go-like/core/lifecycle`        | `waitForContext`                                           | مؤلفو دورة الحياة/المزوّدات   |
|   8 | `@go-like/core/node`             | `signal`                                                   | تكامل عمليات Node/Bun         |
|   9 | `@go-like/nats/broker`           | `newNatsCoreBroker`                                        | تطبيقات NATS Core             |
|  10 | `@go-like/nats/jetstream`        | `newNatsJetStreamServer`, `natsJetStreamCloseTimeout`      | تطبيقات JetStream             |
|  11 | `@go-like/nats/jetstream/broker` | `newNatsJetStreamBroker`                                   | تطبيقات Broker في JetStream   |
|  12 | `@go-like/registry/provider`     | خيارات المزوّد ومساعدات snapshot                           | مؤلفو المزوّدات               |
|  13 | `@go-like/registry-mdns/node`    | `newNodeMDNSHost`                                          | تطبيقات mDNS في Node          |
|  14 | `@go-like/store/provider`        | خيارات write/delete/list وsnapshots                        | مؤلفو المزوّدات               |
|  15 | `@go-like/store-file/node`       | `newNodeFileStoreHost`                                     | تطبيقات Store الملفية في Node |
|  16 | `@go-like/struct/codec`          | `encodeJson`, `decodeJson`                                 | مؤلفو العقود typed            |
|  17 | `@go-like/struct/runtime`        | مساعدات introspection وparsing                             | مؤلفو runtime/المزوّدات       |
|  18 | `@go-like/transport/headers`     | ثوابت headers `Go-Like-*`                                   | مؤلفو Transport/المزوّدات     |
|  19 | `@go-like/transport/json`        | `encodeJsonBody`, `decodeJsonBody`, `jsonContentType`      | مؤلفو Transport typed/raw     |
|  20 | `@go-like/transport/provider`    | codecs وأخطاء Message وmetadata وServiceError              | مؤلفو المزوّدات               |
|  21 | `@go-like/transport-http/node`   | `newNodeHTTPTransport`, `allowHTTP1`, `clientAuth`         | تطبيقات HTTP في Node          |
|  22 | `@go-like/web/health`            | `createHealthHandler`                                      | تطبيقات Web                   |
|  23 | `@go-like/web/node`              | `newNodeServer`, `hostname`, `port`, `nodeShutdownTimeout` | تطبيقات مضيف Web في Node      |

تحتوي إعدادات TypeScript الحالية على path mappings قديمة لـ `@go-like/otel/testing` و`@go-like/web/node/testing`، لكنها ليست exports حالية في manifests الحزم. لا توثّقها كنقاط دخول عامة حتى يوحّد المستودع هذه mappings مع الواقع.

## مصفوفة قرار بيئة التشغيل

| المدخل أو عائلة المزوّد                                            | المصدر المحمول                | أصلي في Bun/Node                           | ادعاء Deno                         | صياغة الدليل                                         |
| ------------------------------------------------------------------ | ----------------------------- | ------------------------------------------ | ---------------------------------- | ---------------------------------------------------- |
| Context وCore root وHealth وMetadata وResilience وStruct           | نعم                           | لا حاجة إلى import أصلي                    | مسارات runtime مختارة معلنة        | عقد مصدر؛ تحقق من المصفوفة المنفذة قبل صياغة release |
| Web root وWeb health                                               | نعم                           | يحتاج إلى Host منفصل                       | حد Handler قياسي                   | Handler محمول؛ لكنه ليس listener                     |
| Memory Transport وMemory Store وMemory Cache وMemory Broker        | مصدر داخل العملية             | لا خدمة خارجية                             | المعنى نفسه داخل العملية           | ليس موزعاً ولا دائماً ولا بين العمليات               |
| HTTP root ومزوّدات Config/Registry/Store المبنية على Fetch         | Fetch محقون                   | تختار بيئة التشغيل Fetch                   | مدعوم بالمصدر حيث يوجد مسار الحزمة | محمول بالمصدر أو بمسار runtime معلن، لا بتكافؤ شامل  |
| المسارات الفرعية `/node`                                           | لا                            | خاصة بـ Node، مع إمكان تشغيل بعضها على Bun | لا entrypoint لـ Deno              | الاستيراد الصريح يغيّر رسم بيئة التشغيل              |
| NATS وRabbitMQ وBullMQ وRedis وPino وWinston وSDKs الأصلية لـ OTel | يعتمد على المزوّد             | fixtures Node/Bun أو دليل خاص بالحزمة      | لا تستنتج دعم Deno                 | اقرأ README الخاص بالمزوّد ونطاق E2E                 |
| ZooKeeper                                                          | لا دعم Deno في README المزوّد | Node/Bun                                   | غير مدعوم صراحةً                   | لا تعمّم من Registry root                            |

## قواعد اختيار الدوال

- استخدم `contextHandler` عند حافة Web عندما تحتاج إلى Context، بدلاً من حقيبة طلب خاصة بالإطار.
- استخدم `newApp` و`server(...)` عندما تضم العملية أكثر من مورد مقبول، أو عندما يجب أن تكون ملكية الإشارة والإيقاف صريحة.
- استخدم `endpoint(...)` typed و`handler(contract, fn)` عندما ينبغي للطرفين مشاركة تحقق Struct وقت التشغيل. استخدم `handler(service, endpoint, fn)` الخام عندما يملك التطبيق عقد bytes مختلفاً.
- استخدم `withAddress(...)` قبل Discovery. فهذا أسهل للاختبار ويجعل هوية الوجهة صريحة.
- استخدم `withDiscovery(...)` و`withSelector(...)` و`withFilter(...)` و`withBlock()` فقط عندما تحتاج الخدمة إلى سلوك مستوى التحكم الذي تضيفه.
- استخدم `withRetry(...)` بعد كتابة تفويض replay وعدد المحاولات الإجمالي الأقصى وpredicate الفشل وidempotency الخاصة بالعمل.
- استخدم `newMemoryStore` للاختبارات الحتمية، لا لادعاء durability.
- استخدم `newMemoryCache` للتسريع القابل للتخلص، لا بوصفه مرجع المواعيد أو المدفوعات.
- استخدم `newBrokerServer` لربط اشتراك واحد بـ Core، لا للحصول على queue worker عام أو API تسوية عامة.
- استخدم `newOtelServer` أو `newPinoServer` أو `newWinstonServer` أو Prometheus Handler بعد أن ينشئ التطبيق المزوّد أو Registry الأصلي.

## الاستبعادات الصريحة

لا ينبغي توثيق أي حزمة في الجرد العام الحالي على أنها تملك gRPC أو Protobuf أو توليد شيفرة IDL أو عملاء RPC مولّدين أو تدفقات داخلية full-duplex أو Event Store/history/replay أو مصادقة/تفويضاً عاماً أو سلوك ORM أو service locator عاماً أو تنسيقاً للعناقيد. قد يستخدم مزوّد أو تطبيق مكتبة منفصلة لإحدى هذه المسؤوليات، لكن ذلك سيكون خارج عقد go-like الحالي.
