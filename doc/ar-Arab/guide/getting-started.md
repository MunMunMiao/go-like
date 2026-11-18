# البدء

يأخذ هذا الدليل أقصر طريق مفيد عبر go-like:

1. شغّل Fetch Handler قياسياً على مضيف Node داخل App واحد.
2. سجّل الجاهزية حتى يستطيع `/readyz` أن ينجح.
3. أضف Context طلب صريحاً عندما يؤدي Handler عملاً قابلاً للإلغاء.
4. انتقل إلى [مشروع حجز مواعيد العيادة](/ar-Arab/guide/zero-to-one) عندما تتضح دورة الحياة هذه.

go-like ليست الموجّه. يمكن أن يأتي Handler من شيفرة Web عادية، أو من Hono أو Elysia أو H3، أو من إطار آخر يعرض شكل Fetch القياسي.

## قبل التثبيت

جذر المستودع خاص ويسجّل إصدار الحزمة `0.0.1`. لا يثبت هذا الإصدار توفر الحزم على npm. من checkout:

```sh
bun install --frozen-lockfile
```

لا يستخدم المستودع إصدارات بيئة التشغيل أو الأدوات بوصفها أهلية للتنفيذ. يتحقق كل مسار تحقق مختار من أن أدواته المطلوبة تستطيع العمل، ويسجّل البيئة المرصودة.

عندما يُؤكد إصدار منشور بصورة مستقلة، تعتمد خدمة Node Web صغيرة على حزمة واحدة:

```sh
bun add @go-like/core
```

السجلات والمقاييس والتتبّعات والأنظمة الخلفية للمنظومة هي Plugs منفصلة. أضف واحداً فقط عندما ينشئ التطبيق ذلك العميل الأصلي.

## خدمة Web واحدة

يعيش `Handler` في `@go-like/core/web`. ويعيش مضيف Node في `@go-like/core/web/node`. وتعيش إشارات العملية في `@go-like/core/node`. الشكل الآتي هو API العام الحالي. مرّر `signal()` بنفسك: لا يثبّت core معالجات إشارات. مرّر `readyProbe(probes)` على السجل نفسه الذي يستخدمه معالج الصحة، وإلا بقي `/readyz` مغلقاً.

```ts
import { name, newApp, readyProbe, server, version } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { signal } from "@go-like/core/node"
import { contextHandler, createHealthHandler, requestContext } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"

const probes = newProbeRegistry()
probes.register("ready", "warmup", async () => {
  // Check a process-local dependency here. Return to pass, throw to fail.
})

const health = createHealthHandler(probes)
const handler = contextHandler(async (ctx, request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return Response.json({
    path: pathname,
    hasContext: requestContext(request) !== null && ctx.err() === null
  })
})

const web = newNodeServer(handler, port(3000))
export const app = newApp(
  signal(),
  name("hello-web"),
  version("v1"),
  readyProbe(probes),
  server(web)
)

await app.run()
```

يُحل `run()` بعد توقف App. يسلّم `Ctrl-C` الإشارة `SIGINT`. يربط `signal()` أول `SIGTERM` أو `SIGQUIT` أو `SIGINT` باستدعاء `App.stop()` المتكافئ نفسه، ويضبط `process.exitCode` على `128` مضافاً إليه رقم الإشارة. وتُترك الإشارة اللاحقة لبيئة التشغيل.

تنجح الحيوية الفارغة. وتفشل الجاهزية الفارغة مغلقة. ينجح `readyProbe` فقط بعد اكتمال البدء وقبل بدء الإيقاف. راجع [الصحة وقابلية الرصد](/ar-Arab/guide/health-observability).

### نقطة التحقق الأولى

- يملك Handler مسار URL.
- يملك `web` مقبس الاستماع.
- يقبل `app` ذلك الخادم، ثم يوقفه.
- يحد `stopTimeout`، عند ضبطه، المدة التي ينتظرها `run()`. وهو بذاته لا يُنهي مقبساً أصلياً يتجاهل الإيقاف.

## أضف Context للطلب

يكيّف `contextHandler` الدالة `(ctx, request)` إلى Fetch `Handler`. يخزّن المضيف Context الطلب على `Request`. وتقرأه `requestContext(request)`. يحمل Context معلومات AppInfo، وعندما يُثبَّت القياس عن بعد، span باسم `http.server`. ويُلغى عند انتهاء الطلب أو إجهاضه.

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

للعمل الذي يستمر بعد أن يعيد Handler جسماً، راقب أيضاً `request.signal`. ينهي `contextHandler` سياق Context عندما يعيد Handler الكائن `Response`.

## استخدم إطار Fetch موجوداً

تمرر أمثلة Hono وElysia وH3 دالة Fetch الخاصة بالإطار إلى `newNodeServer` وتضع ذلك المضيف في `server(...)`. يحتفظ الإطار بالمسارات وmiddleware.

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/core/web/node"

const app = new Hono()
app.get("/hello", (c) => c.json({ ok: true }))

const web = newNodeServer(app.fetch, port(3000))
await newApp(signal(), name("hono"), server(web)).run()
```

النسخ القابلة للتشغيل هي `examples/hono` و`examples/elysia` و`examples/h3` و`examples/vanilla-web`.

## تعلّم بالترتيب

1. هذه الصفحة: مضيف واحد، وApp واحد، وفحص جاهزية واحد.
2. [حجز مواعيد العيادة](/ar-Arab/guide/zero-to-one): ثابت مجال واستدعاء داخلي أحادي.
3. [البنية](/ar-Arab/guide/architecture): طبقة الموارد، وطبقة الخوادم، والميزانيات.
4. [استدعاءات الخدمات](/ar-Arab/guide/service-call)، ثم [الإعداد والسجل والمخزن وذاكرة التخزين المؤقت](/ar-Arab/guide/config-registry-store).
5. [الصحة وقابلية الرصد](/ar-Arab/guide/health-observability) عندما تضيف سجلات أو مقاييس أو تتبّعات.

## أوامر checkout

من جذر المستودع، بعد `bun install --frozen-lockfile`:

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

تتحقق هذه الأوامر من الأنواع وتشغّل اختبارات الوحدة في المثال. وهي لا تشغّل Docker ولا تثبت النشر على npm.

## إخفاقات التشغيل الأول

| ما تراه                                         | ما يعنيه عادة                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| يعيد `/readyz` الحالة 503                       | لا يملك السجل فحص جاهزية ناجحاً. سجّل واحداً، بما في ذلك `readyProbe(probes)` إذا كان يجب أن يُحتسب App نفسه.           |
| تخرج العملية عند `SIGTERM` من دون تصريف         | أُغفل `signal()`.                                                                                                   |
| `TypeError: pass telemetry with telemetry(...)` | مُرّرت حزمة `Telemetry` إلى `server(...)` أو `resources(...)`. استخدم `telemetry(tel)`.                              |
| المنفذ مستخدم مسبقاً                             | عملية أخرى تحجزه. خطأ المضيف هو خطأ الاستماع في بيئة التشغيل.                                                       |
| `Cannot find package`                           | لم يُشغَّل تثبيت workspace، أو ما زال الاستيراد يستخدم محدّداً من قبل الترحيل. راجع [الترحيل](/ar-Arab/guide/migration). |
