# الحزم

تحتوي مساحة العمل على **20** حزمة `@go-like/*` عامة، كل منها بالإصدار `0.0.1` في هذا checkout. جذر مساحة العمل خاص. ولا يثبت الإصدار توفر الحزم على npm. أدلة `examples/*` الأربعة والأربعون تطبيقات خاصة.

هناك **75** مدخلاً عاماً: 41 على `@go-like/core` و34 على Plugs والمولّد. تصدير `./package.json` المولَّد في `dist/package.json` بيانات وصفية، وليس مدخلاً آخر.

`@go-like/core` بلا اعتماد طرف ثالث في وقت التشغيل. تعتمد كل حزمة أخرى عدا `@go-like/protoc-gen-like` اعتماداً نظيراً على إصدار core نفسه. ولا يعتمد المولّد على core. سلوك Plug وحدوده في README الخاص به. هذه الصفحة هي الجرد.

## الحزم العشرون

| الحزمة                     | المداخل                                  | ما تملأه                                                  |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `@go-like/core`            | 41                                       | Sockets، والآليات، ومراجع الذاكرة، وارتباطات بيئة التشغيل |
| `@go-like/otel`            | `.`                                      | المتتبّع، والمقياس، ومعالج السجل، والناشر                 |
| `@go-like/pino`            | `./log`                                  | `LogHandler`                                             |
| `@go-like/winston`         | `./log`                                  | `LogHandler`                                             |
| `@go-like/prometheus`      | `./metric`                               | `MeterProvider` و`Handler` للجمع                         |
| `@go-like/consul`          | `.`، `./registry`، `./config`، `./store` | عميل مشترك، وسجل، وإعداد، ومخزن                          |
| `@go-like/etcd`            | `.`، `./registry`، `./config`، `./store` | عميل مشترك، وسجل، وإعداد، ومخزن                          |
| `@go-like/vault`           | `.`، `./config`، `./store`               | عميل مشترك، وإعداد، ومخزن                                |
| `@go-like/kubernetes`      | `.`، `./registry`، `./config`            | عميل مشترك، وسجل، وإعداد                                 |
| `@go-like/zookeeper`       | `./registry`، `./registry/node`          | سجل فوق مصنع عميل؛ ومصنع Node                            |
| `@go-like/mdns`            | `./registry`، `./registry/node`          | سجل فوق `MDNSHost`؛ ومضيف Node                           |
| `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                          |
| `@go-like/nats`            | `./broker`، `./jetstream`                | وسطاء Core وJetStream                                    |
| `@go-like/rabbitmq`        | `./broker`                               | وسيط                                                     |
| `@go-like/redis`           | `./cache`                                | ذاكرة مؤقتة و`Server` في طبقة الموارد                    |
| `@go-like/bullmq`          | `./job`                                  | `JobQueue` و`Server` في طبقة الموارد                     |
| `@go-like/croner`          | `./job`                                  | `Schedule`                                               |
| `@go-like/file`            | `./store`، `./store/node`                | مخزن و`Server` في طبقة الموارد؛ ومضيف Node               |
| `@go-like/connectrpc`      | `.`، `./node`                            | معالج Fetch؛ وخادم gRPC وعميله في Node                   |
| `@go-like/protoc-gen-like` | `.`                                      | إضافة Buf و`bin`. بلا Socket                              |

العدّ: 41 + 4 + 8 + 6 + 10 + 6 = 75. مداخل Plug والمولّد هي الأربعة والثلاثون بعد 41 الخاصة بـ core.

## مداخل core

| المدخل                              | الدور    | أول الصادرات                                                                              |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `@go-like/core`                     | App      | `newApp`، `telemetry`، `resources`، `server`، `registrar`، `readyProbe`، خطافات، ميزانيات |
| `@go-like/core/node`                | ربط Node | `signal`                                                                                  |
| `@go-like/core/lifecycle`           | Socket   | `Server`، `Endpointer`، `newResourceServer`                                               |
| `@go-like/core/context`             | Socket   | `background`، `withCancel`، `withTimeout`، `waitForContext`                               |
| `@go-like/core/metadata`            | آلية     | `newMetadata`، ومساعدات Context للعميل والخادم                                            |
| `@go-like/core/struct`              | آلية     | `struct`، `StructError`، `encodeJson`، `decodeJson`، `jsonCodec`                          |
| `@go-like/core/health`              | Socket   | `newProbeRegistry`                                                                        |
| `@go-like/core/resilience`          | Socket   | `retry`، `newCircuitBreaker`، `newTokenBucketLimiter`                                     |
| `@go-like/core/telemetry`           | Socket   | `newTelemetry`، `withTelemetry`، وثوابت الاصطلاح الدلالي                                     |
| `@go-like/core/telemetry/provider`  | عُدّة Plug | `beginUnit`، `logCorrelation`، `resourceFromContext`                                      |
| `@go-like/core/log`                 | Socket   | `log`، `info`، `error`، `LogHandler`                                                      |
| `@go-like/core/trace`               | Socket   | `inSpan`، `newTraceContextPropagator`                                                     |
| `@go-like/core/metric`              | Socket   | `newCounter`، `newHistogram`، `newGauge`، `newUpDownCounter`                              |
| `@go-like/core/testing`             | اختبارات | `newTelemetryRecorder`، `<concept>Conformance`                                            |
| `@go-like/core/transport`           | Socket   | `defineService`، `serviceError`، `isServiceError`، `ServerStream`                         |
| `@go-like/core/transport/provider`  | عُدّة Plug | مصانع أخطاء النقل، `newServerContext`                                                     |
| `@go-like/core/transport/memory`    | مرجع     | `newMemoryTransport`                                                                      |
| `@go-like/core/transport/http`      | مرجع     | `newHTTPTransport`                                                                        |
| `@go-like/core/transport/http/node` | ربط Node | `newNodeHTTPTransport`                                                                    |
| `@go-like/core/server`              | آلية     | `newServer`، `address`، `advertise`، `rateLimitMiddleware`                                |
| `@go-like/core/client`              | آلية     | `newClient`، `withEndpoint`، `withDiscovery`، `withRetry`، `circuitBreakerMiddleware`     |
| `@go-like/core/web`                 | Socket   | `Handler`، `contextHandler`، `requestContext`، `createHealthHandler`                      |
| `@go-like/core/web/node`            | ربط Node | `newNodeServer`، `hostname`، `port`، `nodeShutdownTimeout`                                |
| `@go-like/core/web/bun`             | ربط Bun  | `newBunServer`، `hostname`، `port`، `bunShutdownTimeout`                                  |
| `@go-like/core/registry`            | Socket   | مُختارات، ومرشحات، `newDiscoveryResolver`، `selectEndpoint`                                |
| `@go-like/core/registry/provider`   | عُدّة Plug | `newSnapshotWatcher`، `startHeartbeat`                                                    |
| `@go-like/core/registry/memory`     | مرجع     | `newMemoryRegistry`                                                                       |
| `@go-like/core/config`              | Socket   | `newConfig`، `objectSource`، `envSource`، `fileSource`، `jsonDecoder`                     |
| `@go-like/core/config/provider`     | عُدّة Plug | `newSourceWatcher`، `admitConfigObject`                                                   |
| `@go-like/core/config/node`         | ربط Node | `newNodeFileCapability`                                                                   |
| `@go-like/core/fetch`               | Socket   | `Fetch`، `newFetchClient`                                                                 |
| `@go-like/core/cache`               | Socket   | `Cache`، `expiresIn`                                                                      |
| `@go-like/core/cache/memory`        | مرجع     | `newMemoryCache`                                                                          |
| `@go-like/core/store`               | Socket   | `Store`، `ifAbsent`، `ifRevision`، `StoreConflictError`                                   |
| `@go-like/core/store/provider`      | عُدّة Plug | محلّلات الخيارات، ومصنع التعارض                                                             |
| `@go-like/core/store/memory`        | مرجع     | `newMemoryStore`                                                                          |
| `@go-like/core/broker`              | Socket   | `Broker`، `newBrokerServer`، `eventBroker`                                                |
| `@go-like/core/broker/provider`     | عُدّة Plug | `deliver`، `publish`                                                                      |
| `@go-like/core/broker/memory`       | مرجع     | `newMemoryBroker`                                                                         |
| `@go-like/core/job`                 | Socket   | `newScheduleServer`، `newIntervalSchedule`، `JobQueue`                                    |
| `@go-like/core/job/provider`        | عُدّة Plug | `runJob`، `enqueue`، `dispatchJob`                                                        |

يصدّر كل من `@go-like/core/server` و`@go-like/core/client` الاسمين `middleware` و`use`. استورد أحدهما بوصفه namespace عندما يحتاج الملف إلى كليهما. خيارات `context` و`endpoint` و`server` و`metadata` في المدخل الجذري هي خيارات App. استورد الجذر بوصفه namespace عندما تتصادم تلك الأسماء مع OpenTelemetry أو مع `defineService`.

لا تستورد شيفرة التطبيق المسارين `/provider` أو `/testing` إلا في الاختبارات وتنفيذات Plug.

## مسارات بيئة التشغيل

استورد المسار الفرعي الذي تقصده. الصادرات ليست مشروطة بـ `bun` أو `node`.

- Node: `@go-like/core/node` و`@go-like/core/transport/http/node` و`@go-like/core/web/node` و`@go-like/core/config/node` و`@go-like/mdns/registry/node` و`@go-like/zookeeper/registry/node` و`@go-like/file/store/node` و`@go-like/connectrpc/node`.
- مضيف Bun: `@go-like/core/web/bun`.
- تتبع NATS وRabbitMQ وRedis وBullMQ عملاءها الأصليين على Node وBun.

## ما يتركه هذا الفهرس

مراجع الذاكرة محلية للعملية. README الخاص بـ Plug هو الحد لعقود lease والإقرار وTTL والمعاملات. يربط [المزوّدات](/ar-Arab/reference/providers) تلك الملفات. وتسرد [الأخطاء](/reference/errors) الرموز العامة. ويربط [الترحيل](/ar-Arab/guide/migration) المحدّدات التاريخية بهذا الجدول.
