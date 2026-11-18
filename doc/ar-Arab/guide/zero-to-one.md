# حجز مواعيد العيادة: من 0 إلى 1

يتبع هذا المسار قاعدة عمل واحدة عبر استدعاء سياسة داخلي، ومعالج Fetch، والصحة، وApp واحد. الشجرة القابلة للتشغيل هي `examples/healthcare-appointments`. تستخدم المقتطفات أدناه أسماء ذلك المثال. ذاكرة توافر مؤقتة قابلة للتخلص مرحلة إضافية تضيفها في جذر التركيب نفسه. وهي ليست مصدراً ثانياً للحقيقة.

## القاعدة الثابتة

1. لا يمكن أن يكون للطبيب مواعيد نشطة متداخلة.
2. يحرّر الإلغاء الخانة.
3. تكرار معرّف الموعد نفسه بالمحتوى نفسه متكافئ.
4. إعادة استخدام معرّف موعد بمحتوى مختلف مرفوضة.
5. عرض توافر مخزّن مؤقتاً، إذا أضفت واحداً، لا يفوّض الحجز بذاته.

ينفّذ المثال القواعد الأربع الأولى بمستودع في الذاكرة ويتحقق من مدة قصوى عبر `appointment-policy.v1/check`. وهو لا يدّعي قاعدة بيانات، أو قفلاً موزعاً، أو مصادقة، أو سير عمل عيادة إنتاجياً.

## التخطيط

```text
examples/healthcare-appointments/
  src/contract.ts    defineService and Structs
  src/service.ts     repository and booking rules
  src/transport.ts   memory Server and Client
  src/http.ts        Fetch handler
  src/main.ts        Node host and App
  test/main.test.ts
```

من جذر المستودع:

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

لا يثبت إصدار الحزمة `0.0.1` توفرها على npm. داخل هذا checkout الاعتماد الوحيد على go-like الذي يحتاجه المثال هو `@go-like/core`.

## M0: قواعد المجال

يملك `src/service.ts` الكائن `BookAppointmentCommand` والمستودع وفحص التداخل. Context هو الوسيط الأول حتى عندما لا يحجب المستودع في الذاكرة. يستطيع مخزن أو ذاكرة مؤقتة لاحقان استخدام التوقيع نفسه.

يرفض المثال معرّفاً سيئاً، ونافذة غير موجبة، وتداخلاً، ومعرّفاً أُعيد استخدامه بمحتوى مختلف. تنتمي اختبارات تلك الحالات إلى جوار المستودع، بلا App وبلا HTTP.

## M1: خدمة السياسة

يربط `src/contract.ts` العملية:

```ts
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

const command = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: command,
    response: struct.object({ allowed: struct.literal(true) })
  }
})
```

يضع `src/transport.ts` الطرفين على نقل ذاكرة واحد. العنوان `memory://appointment-policy.v1` ليس اسم العملية.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { appointmentPolicy } from "./contract"

const transport = newMemoryTransport()
const server = newServer(serverTransport(transport), address("memory://appointment-policy.v1"))
appointmentPolicy.registerHandler(server, {
  check(_ctx, command) {
    if (command.endsAt - command.startsAt > 7_200_000) {
      throw serviceError("appointment_policy_rejected", "appointment duration exceeds policy", 409)
    }
    return { allowed: true as const }
  }
})
const caller = appointmentPolicy.newClient(
  newClient(withTransport(transport), withEndpoint("memory://appointment-policy.v1"))
)
```

`src/http.ts` هو `contextHandler`. يمرر Context الطلب إلى الحجز والإلغاء. HTTP 400 جسم مشوّه. HTTP 409 حجز مرفوض. تلك الحالات اختيار معالج Web. إخفاق السياسة هو `ServiceError` بالحالة 409 على الاستدعاء الداخلي.

## M2: Cache التوافر

ذاكرة التخزين المؤقت في الذاكرة اختيارية ومحلية للعملية. المفاتيح والقيم بايتات. يبقى المستودع ملزِماً: الإصابة تتخطى قراءة، والغياب أو الانتهاء يقرأ من جديد، والحجز أو الإلغاء يحذف المفتاح. يجب ألا يتحول خطأ الذاكرة المؤقتة إلى حجز ناجح.

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` ليست `Server`. `@go-like/redis/cache` هو `Server`؛ وذلك يذهب إلى `resources(...)`.

## M3: الحيوية والجاهزية

أنشئ سجلاً واحداً، ووجّه App إليه، وأرسل `/livez` و`/readyz` بنفسك. من دون `readyProbe` يبقى `/readyz` على 503.

```ts
import { newApp, readyProbe, server } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler, type Handler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
const health = createHealthHandler(probes)

const handler: Handler = async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return appointmentHandler(request)
}

const app = newApp(readyProbe(probes), server(policyServer, web))
void handler
void app
```

## M4: مالك واحد لدورة الحياة

`src/main.ts` في المثال هو جذر التركيب: المستودع، وخدمة السياسة، والمعالج، و`newNodeServer`، و`signal()`، و`afterStart` الذي ينتظر `endpoint(ctx)` قبل كتابة `GO_LIKE_EXAMPLE_READY`. أضف `readyProbe` عندما تعرض `/readyz`. أغلق عميل السياسة في `afterStop` إذا عاش بعد خادم الذاكرة.

```ts
import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
  })
)
await app.run()
```

يطلق `server(...)` المشاركَين معاً. خادم السياسة داخل العملية، فلا يحتاج إلى طبقة الموارد. ذاكرة Redis المؤقتة أو مخزن الملفات يحتاجان إليها.

## M5: ما تثبته الاختبارات

يمارس `test/main.test.ts` قواعد الذاكرة والاستدعاء الداخلي. اختبار وحدة ناجح لا يثبت Docker، أو tarball منشوراً، أو نظام حجز إنتاجياً. سجّل الأمر إذا ادّعيت نتيجة. راجع [التحقق](/ar-Arab/reference/verification).

## استكشاف الأخطاء

| العَرَض                          | ما يُفحص                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `Cannot find package`          | شغّل `bun install --frozen-lockfile`. الاستيرادات هي `@go-like/core/...`. |
| HTTP 404                       | المعالج لا يعرف ذلك المسار. مسارات الصحة لا تُركَّب لك.                      |
| HTTP 400                       | فشل جسم JSON في فحص المعالج نفسه.                                       |
| HTTP 409                       | رفض المستودع أو السياسة الأمر.                                           |
| يفشل الاستدعاء النمطي في التحقق | الطلب أو الاستجابة لا يطابق Struct.                                       |
| لا يصل العميل إلى الخادم        | يجب أن يشترك العميل والخادم في نسخة `newMemoryTransport()` واحدة.       |
| لا تعود `app.run()`             | تنتظر حتى الإيقاف. ينهيها `signal()` أو `app.stop()`.                    |
| `EADDRINUSE`                   | المنفذ محجوز.                                                           |
| اختفت قيمة الذاكرة المؤقتة     | ذاكرة العملية المؤقتة محلية للعملية. TTL و`delete` يزيلانها أيضاً.        |
| `/readyz` يعيد 503             | سجّل فحص جاهزية، بما في ذلك `readyProbe(probes)`.                        |
