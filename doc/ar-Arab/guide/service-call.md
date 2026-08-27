# استدعاءات الخدمات

الاستدعاء الداخلي الأحادي في go-like تركيب صغير وواضح. يمرر `@go-like/client` لقطة `Discovery` إلى `Selector`، ثم ينفذ تبادلاً واحداً من `send` و`recv` عبر `Transport`. وتستخدم عملية الإنشاء خيارات وظيفية:

```ts
import { newClient, withDiscovery, withFilter, withSelector, withTransport } from "@go-like/client"
import { filterLabel, filterVersion, type Filter } from "@go-like/registry"

const client = newClient(
  withDiscovery(discovery),
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

يصدر API الجذري لـ Registry النوع `Filter` والدالتين `filterVersion(...)` و`filterLabel(...)`، بينما يرفق `withFilter(...)` المرشحات بالاستدعاء. تعمل المرشحات بترتيب التصريح قبل `Selector.select`. لا يحتاج العميل المخصص للاستدعاء المباشر إلا إلى `newClient(withTransport(serviceTransport))`؛ ثم يستخدم `withAddress(...)` لتجاوز `Discovery` و`Selector`. أما العميل المستند إلى Discovery فيفتح مراقباً واحداً لكل خدمة عند الحاجة ويختار من أحدث لقطة مكتملة. ينفذ كل استدعاء محاولة واحدة افتراضياً؛ وبعد إثبات أن الإعادة آمنة، يضبط `withRetry(...)` عدداً محدوداً من المحاولات وتصنيف حالات الفشل وتأخيراً اختيارياً، وتعيد كل محاولة مسموحة الاختيار من أحدث لقطة. عند الانتهاء يجب استدعاء `client.close(ctx)`؛ ويحد `closeTimeout(...)` تنظيف عميل `Transport` المنطقي فقط، بينما يملك Transport وبيئة التشغيل إعادة استخدام الاتصال الفعلي.

يربط `@go-like/server` المعالجات بطبقة النقل ويعرض العنوان الفعلي المرتبط. تشمل خياراته `transport(...)` و`address(...)` و`handler(service, endpoint, fn)` و`middleware(...)` و`listenOption(...)`؛ ويمرر الخيار الأخير قيم `ListenOption` الخاصة بالمزوّد إلى `Transport.listen`. يعيد `endpoint(ctx)` نقطة النهاية الفعلية نفسها التي يستخدمها `start(ctx)`. وينشر Core App المكوّن عبر `newApp(registrar(registry), server(serviceServer))` نقطة النهاية هذه ضمن `ServiceInstance` ثم يسحبها عند الإيقاف. هذا هو مسار دورة الحياة الموصى به؛ ولا يحتاج المستخدم إلى رمز تسجيل أو readiness DSL أو أداة تسجيل خاصة بالخادم.

تضيف كل محاولة أحادية قيمة `TransportInfo` في جهة العميل، وتتضمن الهدف الفعلي وعملية `service/endpoint` الثابتة وترويسات النقل الحقيقية، إلى Context الممرر إلى Transport. ويضيف الخادم قيمة `TransportInfo` المناظرة قبل استدعاء معالج العمل. يرمّز العميل والخادم البيانات الوصفية متعددة القيم في Context داخل الغلاف المحدود والقياسي `Go-Like-Metadata`، وتحمله مزوّدات Transport كترويسة Message معتمة. ولا تنسخ `propagateToClientContext(...)` البيانات الوصفية الخاصة بالخادم إلى سياق العميل إلا عبر قائمة سماح صريحة من نوع `exact` أو `prefix`.

تتبع واجهة النقل المشتركة أدوار go-micro نفسها: `Transport` و`Client` و`Listener` و`Socket`. تنفذ `@go-like/transport-http` اتجاهي العميل والخادم عبر آلية Fetch القياسية، وتظل أخطاء البروتوكول والنقل والخدمة قابلة للتمييز. لا تُعاد الاستجابة إلى المستدعي إلا بعد اكتمال إرسال التغذية الراجعة (`feedback`) التي يملكها الاستدعاء وإغلاق (`close`) عميل Transport المنطقي. إذا اكتمل التبادل وفشلت إحدى خطوتي التنظيف، يحفظ `AggregateError` الأصلي الاستجابة في `cause` وأخطاء التغذية الراجعة ثم الإغلاق، بالترتيب، في `errors`، ولا تؤدي هذه الأخطاء اللاحقة إلى إعادة محاولة الاستدعاء.
