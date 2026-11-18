# الإعداد والسجل والمخزن وذاكرة التخزين المؤقت

تجيب هذه العقود الأربعة عن أسئلة مختلفة. عميل منظومة مشترك لا يدمج العقود.

| المجال          | السؤال                                        | Socket                              | العمر                  |
| --------------- | --------------------------------------------- | ----------------------------------- | ---------------------- |
| الإعداد          | أي لقطة ينبغي لهذه العملية أن تستخدم؟         | `ConfigSource`, `ConfigDecoder`     | العملية أو النشر       |
| السجل           | أي نسخ يمكن الوصول إليها الآن؟                 | `Registrar`, `Discovery`, `Watcher` | مستوى تحكم عابر        |
| المخزن          | أي سجل موجود عند هذا المفتاح وهذه المراجعة؟   | `Store`                             | حالة عمل أو حالة تشغيل |
| الذاكرة المؤقتة | هل يمكن إعادة حساب هذه القيمة القابلة للتخلص؟ | `Cache`                             | قابلة للتخلص           |

طابق رموز المزوّد مع [معالجة الأخطاء](/reference/errors) قبل إعادة تنفيذ طفرة فاشلة.

## الإعداد

يدمج `@go-like/core/config` المصادر في نشرة غير قابلة للتغيير. تتحقق `schema(...)` من تلك النشرة. `config.scan(ctx, schema)` استدعاء منفصل: يفحص وينمّط النتيجة معاً. مرّر المخطط إلى الاثنين.

```ts
import { background } from "@go-like/core/context"
import {
  envSource,
  fileSource,
  jsonDecoder,
  newConfig,
  objectSource,
  schema,
  source
} from "@go-like/core/config"
import { struct } from "@go-like/core/struct"

const settings = struct.object({
  service: struct.object({
    name: struct.string(),
    port: struct.number()
  })
})

const config = newConfig(
  source(objectSource("defaults", { service: { name: "appointments", port: 3000 } })),
  schema(settings)
)

await config.load(background())
const loaded = await config.scan(background(), settings)
await config.close(background())
void fileSource
void jsonDecoder
void envSource
void loaded
```

تقرأ `envSource` السجل الذي تمرره. وهي لا تقرأ `process.env` بذاتها. تقرأ `fileSource` مع `jsonDecoder` ملف JSON عبر `FileCapability`. `newNodeFileCapability` من `@go-like/core/config/node` هي ربط Node. `decodeYaml` من `@go-like/yaml/config` هي `ConfigDecoder` لـ YAML. وهي حزمة منفصلة لأنها تعتمد على `js-yaml`.

يحوّل `resolver` و`placeholderResolver` الكائن المدموج قبل النشر. تراقب `onReloadError` إعادة تحميل في الخلفية أبقت آخر لقطة مقبولة. وتراقب `onTerminalError` أول إخفاق مراقب لا يُستعاد. تقرأ `value(key)` و`watch` النشرة. الإعداد ليس `Server`. أغلقه من `afterStop`، أو حمّله في تسلسل التمهيد الموصوف في [الصحة وقابلية الرصد](/ar-Arab/guide/health-observability) قبل `newApp`.

يمكن لإخفاق إعادة التحميل أن يبقي آخر لقطة مقبولة. إخفاق المراقب النهائي حدث مختلف. أسماء المصادر هويات منطقية.

### مصادر المنظومة

يصدّر كل Plug من هذه المجموعة عميلاً واحداً من جذر الحزمة ومصدراً من مدخل Socket. مرّر العميل نفسه إلى كل Socket تستخدمه.

| عميل الجذر                                     | مدخل الإعداد                  | المصدر                              |
| ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `newConsulClient` من `@go-like/consul`         | `@go-like/consul/config`     | `consulSource(client, options)`     |
| `newEtcdClient` من `@go-like/etcd`             | `@go-like/etcd/config`       | `etcdSource(client, options)`       |
| `newVaultClient` من `@go-like/vault`           | `@go-like/vault/config`      | `vaultSource(client, options)`      |
| `newKubernetesClient` من `@go-like/kubernetes` | `@go-like/kubernetes/config` | `kubernetesSource(client, options)` |

يأخذ العميل `fetch` صريحاً. يختلف ذلك عن `@go-like/core/transport/http`، الذي يستخدم افتراضياً `globalThis.fetch`. تشترك إخفاقات HTTP والنقل والبروتوكول في عائلة أخطاء واحدة على جذر الحزمة. يقول حقل `operation` أي Socket أصدر الاستدعاء. راجع README الخاص بـ Plug لاستعادة المراقبة: استعلامات Consul الحاجبة، وضغط etcd، وإعادة سرد Kubernetes، وVault KV v2 ليست الآلية نفسها.

يوفّر `@go-like/core/fetch` الأنواع `Fetch` و`newFetchClient` ومساعد الحالة الذي يستخدمه مؤلفو Plug. تستطيع شيفرة التطبيق التي تحمّل الإعداد فقط أن تبقى على دالة إنشاء المصدر.

## السجل والاكتشاف

`@go-like/core/registry` هو Socket وآلة داخل العملية: `filterVersion` و`filterLabel` والمُختارات الخمس و`snapshotServiceInstance` و`selectEndpoint` و`newDiscoveryResolver`. `@go-like/core/registry/memory` هي `newMemoryRegistry`. `@go-like/core/registry/provider` عُدّة مؤلف Plug (`newSnapshotWatcher` و`newIdentityLocks` و`startHeartbeat`).

| مدخل Plug                          | دالة الإنشاء                              | ملاحظات                                          |
| ---------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `@go-like/consul/registry`         | `newConsulRegistry(client, options)`     | `ConsulClient` نفسه المستخدم في الإعداد والمخزن. |
| `@go-like/etcd/registry`           | `newEtcdRegistry(client, options)`       | يبقى lease والمعاملة على etcd.                  |
| `@go-like/kubernetes/registry`     | `newKubernetesRegistry(client, options)` | تبقى هوية EndpointSlice وRBAC على العنقود.      |
| `@go-like/zookeeper/registry`      | `newZookeeperRegistry(options)`          | قابل للنقل فوق `ZookeeperClientFactory`.        |
| `@go-like/zookeeper/registry/node` | `newNodeZookeeperClientFactory()`        | يستورد `node-zookeeper-client`.                 |
| `@go-like/mdns/registry`           | `newMDNSRegistry(options)`               | قابل للنقل فوق `MDNSHost` محقون.                |
| `@go-like/mdns/registry/node`      | `newNodeMDNSHost`                        | يستخدم `node:dgram`.                            |

ينتج المراقب لقطات استبدال كاملة. يعني `GO_LIKE_WATCHER_OVERFLOW` أن أحداثاً أُسقطت؛ أعد البناء من لقطة كاملة. يعني `GO_LIKE_NO_AVAILABLE_ENDPOINT` أن اللقطة الحالية، بعد المرشحات، لا تملك وجهة ترسل إليها الاستدعاء.

يسجّل `registrar(registry)` على `newApp` نقاط نهاية طبقة الخوادم بعد إعدادها ويلغي تسجيلها عند الإيقاف. الموارد لا تُسجَّل. القيمة الافتراضية لـ `registrarTimeout` هي 10 ثوانٍ.

## المخزن

`@go-like/core/store` هو Socket سجل البايتات: `get` و`put` و`delete` و`list`، مع `ifAbsent` و`ifRevision` و`prefix` و`limit` و`cursor` و`expiresIn`. الشرط غير المتحقّق هو `GO_LIKE_STORE_CONFLICT`. اقرأ السجل الحالي وقرّر من جديد. المراجعات مبهمة. `@go-like/core/store/memory` هي `newMemoryStore`، محلية للعملية فقط.

| Plug                       | المدخل                             | الدور                                                                             |
| -------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `@go-like/consul/store`    | `newConsulStore(client, options?)` | KV تحت جذر معزول. لقراءة العودة غير اليقينية ولتركيب TTL مع CAS رموزهما الخاصة.   |
| `@go-like/etcd/store`      | `newEtcdStore(client)`             | المراجعات والضغط وعقود lease. يعني `GO_LIKE_ETCD_STORE_CLEANUP` أن الطفرة التزمت. |
| `@go-like/vault/store`     | `newVaultStore(client, options)`   | KV v2. مؤشّر القائمة محلي للعملية.                                                 |
| `@go-like/file/store`      | `newFileStore(host, directory)`    | قابل للنقل فوق `FileStoreHost`. وهو أيضاً `Server` في طبقة الموارد.                |
| `@go-like/file/store/node` | `newNodeFileStoreHost`             | مضيف دليل في Node. المخزن أيضاً `Server` في طبقة الموارد.                          |

تستخدم مخازن Consul وetcd وVault أخطاء الجذر المشتركة لإخفاقات HTTP والنقل والبروتوكول. تبقى نتائج المخزن وحدها (طفرة غير يقينية، وضغط، وفقدان lease، وتنظيف، وتركيب أعلام غير مدعوم، ومؤشّر لقطة) على مدخل المخزن.

تبقى أخطاء تلف مخزن الملفات والقفل والحالة على `@go-like/file/store`. القفل القديم ليس سلطة لحذفه. إخفاق مجموع التحقق ليس سلطة للكتابة فوق اللقطة.

## ذاكرة التخزين المؤقت

`@go-like/core/cache` هو `get` و`put` و`delete` للبايتات، مع `expiresIn`. المفتاح الغائب أو المنتهي هو `null`. `@go-like/core/cache/memory` هي `newMemoryCache`. وهي ليست `Server` ولا تبقى بعد العملية.

يصدّر `@go-like/redis/cache` الدالة `newRedisCache`. الكائن المعاد هو `Cache` و`Server` في طبقة الموارد: يُحل `start` عندما يصبح العميل قابلاً للاستخدام، ويغلقه `stop`. ضعه في `resources(...)`. الرمزان العامان هما `GO_LIKE_CACHE_REDIS_OPERATION` و`GO_LIKE_CACHE_REDIS_PROTOCOL`. إخفاق الذاكرة المؤقتة سبب لاستخدام المخزن الملزِم، وليس سبباً لإعادة محاولة كتابة عمل.

## اختيار Plug

- منظومة واحدة وعدة Sockets: عميل جذر واحد، ومسار فرعي لكل Socket.
- الاختبارات وأمثلة العملية الواحدة: مداخل `memory` في core.
- الملفات على القرص: `@go-like/file`، لا مسار فرعي في core.
- YAML: `@go-like/yaml/config`.
- أي شيء يجب أن يكون قائماً قبل أن تقبل الخوادم العمل، وينفّذ `Server`: `resources(...)`.
