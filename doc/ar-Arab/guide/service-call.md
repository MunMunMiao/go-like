# استدعاءات الخدمات

الاستدعاء الداخلي للخدمة تبادل Fetch واحد. اسم العملية وعنوان النقل قيمتان مختلفتان. يضيف الاستدعاء النمطي تحقق Struct على جسم JSON. أما RPC المولّد من Protobuf فمسار منفصل؛ راجع [التدفق](/ar-Arab/guide/streaming).

## هوية العملية والعنوان

تسمّي `defineService("appointment-policy.v1", { check })` العملية `appointment-policy.v1/check`. ويسمّي `withEndpoint("memory://appointment-policy.v1")` و`address("memory://appointment-policy.v1")` الوجهة التي تذهب إليها البايتات. يخزّن `ServiceInstance` في السجل عناوين النقل في `endpoints`. تختار المرشحات والمُختارات من بين تلك العناوين. وهي لا تختار العملية.

## Memory Transport النمطي

استخدم `newMemoryTransport()` واحدة للطرفين. وهي محلية للعملية وخاصة بالنسخة. هذا هو الشكل في `examples/healthcare-appointments`:

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { name, newApp, server } from "@go-like/core"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService, serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const math = defineService("math", {
  add: {
    request: struct.object({ left: struct.number(), right: struct.number() }),
    response: struct.object({ sum: struct.number() })
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://math"))
math.registerHandler(rpc, {
  add(_ctx, request) {
    if (!Number.isFinite(request.left) || !Number.isFinite(request.right)) {
      throw serviceError("math_rejected", "operands must be finite", 400)
    }
    return { sum: request.left + request.right }
  }
})

const client = newClient(withTransport(transport), withEndpoint("memory://math"))
const api = math.newClient(client)
const app = newApp(name("math"), server(rpc))
const running = app.run()
await rpc.endpoint(background())
try {
  const result = await api.add(background(), { left: 2, right: 3 })
  console.log(result.sum)
} finally {
  await client.close(background())
  await app.stop()
  await running
}
```

يربط `service.registerHandler` كل معالج نمطي قبل البدء. وتتحقق `service.newClient(client).add(ctx, value)` من الطلب والاستجابة. `client.close(ctx)` تنظيف يملكه التطبيق. في عملية حقيقية، أغلق العميل من `afterStop` واترك `app.run()` يملك العمر.

`newHTTPTransport()` هو عميل Fetch القابل للنقل. وهو لا يستمع. يستخدم مستمع Node الدالة `newNodeHTTPTransport()` من `@go-like/core/transport/http/node` على الخادم وعلى عميل Node معاً. تمرير `newHTTPTransport()` إلى `newServer` يجتاز فحص الأنواع ثم يفشل عند الاستماع بالرمز `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`.

يصدّر كل من `@go-like/core/server` و`@go-like/core/client` الاسمين `middleware` و`use`. استورد أحدهما بوصفه namespace عندما يحتاج الملف إلى كليهما.

## محاولة واحدة

ينفّذ الاستدعاء الافتراضي محاولة واحدة. يبني العميل `POST` مع `content-type: application/json`، ويتصل أو يعيد استخدام نقل، ويقرأ الاستجابة. يصبح جسم JSON ليس من فئة 2xx ويطابق غلاف خطأ الخدمة كائناً `ServiceError`. تعرّف عليه بـ `isServiceError` من `@go-like/core/transport` قبل قراءة `code` أو `status` أو `metadata`. `ServiceError.code` يملكه التطبيق. وهو ليس رمزاً من عائلة `GO_LIKE_*`.

يأخذ `client.call` الخام `{ service, endpoint, headers, body }` ويعيد Fetch `Response`. يقرأ المستدعي الجسم أو يلغي قراءته.

تنتقل البيانات الوصفية على Context. يوفّر `@go-like/core/metadata` الدوال `newClientContext` و`fromServerContext` و`propagateToClientContext`. النشر صريح. ولا تُنسخ البيانات الوصفية الواردة إلى القفزة التالية إلا إذا فعل المعالج ذلك.

## الاكتشاف والمرشحات والاختيار

يراقب `newDiscoveryResolver` من `@go-like/core/registry` خدمة واحدة ويحتفظ بلقطة استبدال كاملة. اللقطة الفارغة ملزمة: يفشل الاختيار بالرمز `GO_LIKE_NO_AVAILABLE_ENDPOINT` بدلاً من إعادة استخدام النسخ السابقة.

```ts
import { newClient, withDiscovery, withEndpoint, withSelector } from "@go-like/core/client"
import { newP2CSelector } from "@go-like/core/registry"

const client = newClient(
  withDiscovery(registry),
  withEndpoint("discovery:///pricing"),
  withSelector(newP2CSelector())
)
void client
```

تأخذ `withDiscovery` كائن `Discovery`. يبني العميل محلّلاً خاصاً. استدعِ `newDiscoveryResolver(discovery)` فقط عندما تحتاج شيفرة التطبيق إلى لقطات خارج عميل. محلّلان على Discovery واحدة لا يشتركان في المراقبين.

المرشحات خالصة ومرتّبة. `filterVersion` و`filterLabel` هما المدمجان، ويُمرَّران لكل استدعاء عبر `withFilter`. المُختارات هي `newRoundRobinSelector` و`newWeightedRoundRobinSelector` و`newRandomSelector` و`newP2CSelector` و`newEWMASelector`. يأخذ P2C وEWMA تغذية راجعة متزامنة بعد المحاولة. تلك الحالة منفصلة عن `circuitBreakerMiddleware`، الذي يربط قاطعاً بعملية.

تنتظر `withBlock()` أول لقطة غير فارغة. قائمة عناوين `withEndpoint` المباشرة لقطة ثابتة وما زالت تمر عبر المُختار. تسمّي `withEndpoint("discovery:///name")` الخدمة المراد مراقبتها.

## إعادة المحاولة تفويض بإعادة التنفيذ

تتطلب `withRetry` من `@go-like/core/client` ما يأتي:

- `authorization`: القيمة `"idempotent"` أو `"caller-approved"`؛
- `maxAttempts`: عدداً صحيحاً موجباً، يحسب المحاولة الأولى؛
- `shouldRetry(ctx, error, attempt)` تعيد قيمة منطقية.

التفويض إعلان من المستدعي. ولا يفحص core الآثار الجانبية. تعيد كل محاولة الدخول إلى الاكتشاف والاختيار. الاستجابة التي استُلمت مسبقاً، ثم تبعها إخفاق في التغذية الراجعة أو التنظيف، لا تُعاد.

`retry` و`exponentialBackoff` في `@go-like/core/resilience` الفكرة نفسها لشيفرة التطبيق خارج العميل. يفتح `newCircuitBreaker` و`circuitBreakerMiddleware` عند إخفاقات يعرّفها المستدعي. `circuitOpen` هو الحارس الذي يُرمى بينما القاطع مفتوح. ويرفض `newTokenBucketLimiter` و`rateLimitMiddleware` الاستدعاءات الزائدة.

## التنظيف

- أغلق العملاء ومراقبي الإعداد في `afterStop`، أو اقبل اتصالاً أصلياً بـ `newResourceServer`.
- أبقِ Context الطلب للاستدعاء. استبداله بـ `background()` يسقط الإلغاء والـ span الحالي.
- طابق الإخفاقات بالحارس، أو بـ `isServiceError`، أو بـ `code` موثّق. اترك الرسالة للتشخيص. الفهرس في [معالجة الأخطاء](/reference/errors).
