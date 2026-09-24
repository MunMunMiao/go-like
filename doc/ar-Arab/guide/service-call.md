# استدعاءات الخدمات

الاستدعاء الداخلي الأحادي في go-like تركيب صغير وواضح. يمرر `@go-like/client` لقطة `Discovery` إلى `Selector`، ثم ينفذ تبادلاً واحداً من `send` و`recv` عبر `Transport`. وتستخدم عملية الإنشاء خيارات وظيفية:

```ts
import {
  newClient,
  withDiscovery,
  withFilter,
  withSelector,
  withService,
  withTransport
} from "@go-like/client"
import { filterLabel, filterVersion, type Filter } from "@go-like/registry"

const client = newClient(
  withDiscovery(discovery),
  withService("orders"),
  withSelector(selector),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const reply = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: { header: {}, body: requestBytes }
  },
  withFilter(...filters)
)
```

يصدر API الجذري لـ Registry النوع `Filter` والدالتين `filterVersion(...)` و`filterLabel(...)`، بينما يرفق `withFilter(...)` المرشحات بالاستدعاء. تعمل المرشحات بترتيب التصريح قبل `Selector.select`. للوجهة المباشرة، أنشئ العميل عبر `newClient(withTransport(serviceTransport), withAddress(serviceAddress))`؛ لا يستخدم `withAddress(...)` Discovery، لكنه يمر عبر Selector نفسه الذي تستخدمه اللقطات المكتشفة. أما العميل المستند إلى Discovery فيستخدم `withService(serviceName)` و`withDiscovery(discovery)` معاً، ويفتح مراقباً واحداً لكل خدمة عند الحاجة ويختار من أحدث لقطة مكتملة. ينفذ كل استدعاء محاولة واحدة افتراضياً؛ وبعد إثبات أن الإعادة آمنة، يضبط `withRetry(...)` عدداً محدوداً من المحاولات وتصنيف حالات الفشل وتأخيراً اختيارياً، وتعيد كل محاولة مسموحة الاختيار من أحدث لقطة. عند الانتهاء يجب استدعاء `client.close(ctx)`؛ ويحد `closeTimeout(...)` تنظيف عميل `Transport` المنطقي فقط، بينما يملك Transport وبيئة التشغيل إعادة استخدام الاتصال الفعلي.

يربط `@go-like/server` المعالجات بطبقة النقل ويعرض العنوان الفعلي المرتبط. أنشئ الخادم بخيارات `transport(...)` و`address(...)` و`middleware(...)` و`listenOption(...)`، ثم سجّل المسار قبل التشغيل عبر `server.registerHandler(...)`؛ ويمرر الخيار الأخير قيم `ListenOption` الخاصة بالمزوّد إلى `Transport.listen`. يعيد `endpoint(ctx)` نقطة النهاية الفعلية نفسها التي يستخدمها `start(ctx)`. وينشر Core App المكوّن عبر `newApp(registrar(registry), server(serviceServer))` نقطة النهاية هذه ضمن `ServiceInstance` ثم يسحبها عند الإيقاف. هذا هو مسار دورة الحياة الموصى به؛ ولا يحتاج المستخدم إلى رمز تسجيل أو readiness DSL أو أداة تسجيل خاصة بالخادم.

تضيف كل محاولة أحادية قيمة `TransportInfo` في جهة العميل، وتتضمن الهدف الفعلي وعملية `service/endpoint` الثابتة وترويسات النقل الحقيقية، إلى Context الممرر إلى Transport. ويضيف الخادم قيمة `TransportInfo` المناظرة قبل استدعاء معالج العمل. يرمّز العميل والخادم البيانات الوصفية متعددة القيم في Context داخل الغلاف المحدود والقياسي `Go-Like-Metadata`، وتحمله مزوّدات Transport كترويسة Message معتمة. ولا تنسخ `propagateToClientContext(...)` البيانات الوصفية الخاصة بالخادم إلى سياق العميل إلا عبر قائمة سماح صريحة من نوع `exact` أو `prefix`.

لا يكتمل الاستدعاء إلا بعد feedback وإعادة عميل Transport المنطقي إلى pool أو إغلاقه عند الحاجة. يُعاد استخدام العميل الناجح افتراضياً؛ اضبط `poolSize(0)` لتعطيل الاحتفاظ به. تحفظ مشكلة التنظيف بعد وصول الاستجابة هذه الاستجابة في `AggregateError.cause` وترتّب الأخطاء في `errors`، ولا تبرر إعادة الاستدعاء. أغلق المالك عبر `client.close(ctx)` عند الانتهاء.
