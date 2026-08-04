# حجز مواعيد العيادة: من 0 إلى 1

هذا مسار إرشادي من 0 إلى 1 لمشروع صغير يتعلّم فيه القارئ go-like من خلال قاعدة عمل ملموسة، لا من خلال قائمة Todo عامة. يصف المشروع هدفاً ونقاط تحقق قابلة للتشغيل؛ ولا يدّعي أن شجرة الهدف موجودة بالفعل كتطبيق يمكن نسخه وتشغيله دفعة واحدة. المشروع خدمة لحجز مواعيد عيادة، فيها خدمة سياسة داخل العملية، ومستودع مرجعي للمواعيد، وCache مؤقت للتوافر، ونقاط Health، ودورة حياة واحدة صريحة للتطبيق.

يحتوي المستودع بالفعل على `examples/healthcare-appointments`، وهو تنفيذ البداية لهذا الدليل. تستخدم شيفرته الحالية معالجة `Message` بصيغة JSON الخام لخدمة السياسة. أما نسخة `Endpoint` و`Struct` typed أدناه فهي مسار ترقية موثّق مبني على exports العامة الحالية؛ ولم تُضف إلى المثال أثناء مرحلة التوثيق هذه. حافظ على هذا الفرق عند تسجيل نتائج التحقق.

## القاعدة الثابتة

يجب أن تحافظ الخدمة على خمس قواعد:

1. لا يمكن للطبيب امتلاك مواعيد نشطة متداخلة.
2. يؤدي إلغاء الموعد إلى إتاحة الفترة الزمنية من جديد.
3. تكرار طلب الموعد نفسه مع `appointment ID` نفسه idempotent.
4. إعادة استخدام `appointment ID` مع محتوى مختلف مرفوض.
5. لا يُستخدم التوافر المخزّن مؤقتاً إلا كتسريع؛ ويظل المستودع هو المرجع.

يطبّق مثال المستودع الحالي القواعد الأربع الأولى باستخدام مستودع داخل الذاكرة، ويتحقق من الحد الأقصى لمدة الموعد عبر خدمة سياسة داخلية. ولا يدّعي وجود قاعدة بيانات أو قفل موزع أو Cache دائم أو مصادقة أو مسار حجز إنتاجي.

## ما الذي ستبنيه؟

```text
clinic-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- contract.ts       # typed policy Endpoint and Structs
|   |-- service.ts        # domain invariant and canonical repository
|   |-- transport.ts      # policy Server and Client over Memory Transport
|   |-- cache.ts          # availability cache and invalidation policy
|   |-- http.ts           # Fetch routes and health delegation
|   `-- main.ts           # one composition root and one Core App
`-- test/
    |-- main.test.ts      # domain, typed call, HTTP, cache, health, cancellation
    `-- node-e2e.ts       # real bind, request, stop, and port release
```

يملك مثال مساحة العمل الموجود حالياً هذه الشجرة الأصغر:

```text
examples/healthcare-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- service.ts
|   |-- transport.ts      # current raw JSON policy boundary
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

الشجرة الثانية هي مصدر الحقيقة لما هو موجود بالفعل في checkout. أما الشجرة الأولى فهي الشكل المستهدف لمراحل الدليل.

## المتطلبات والأوامر

من جذر المستودع:

```sh
bun install --frozen-lockfile
```

الحزم هي اعتماديات workspace في هذا checkout. يسجّل المستودع Bun `1.3.14` وNode.js `26.x` وDeno `2.9.4` وTypeScript `7.0.2` وk6 `2.1.0` ضمن مصفوفة التحقق؛ أي إصدار patch ضمن Node.js 26.x مقبول. وتقول وثائق الحزم الحالية إن الحزم لم تُنشر بعد إلى npm.

شغّل مثال الأساس الموجود:

```sh
HOST=127.0.0.1 PORT=3000 bun run --cwd examples/healthcare-appointments start
```

تقوم شيفرة `start` ببناء حزم الجذر، وإنشاء Node bundle مجهز، وتشغيله. انتظر سطر `GO_LIKE_EXAMPLE_READY` قبل إرسال الطلبات. في طرفية أخرى:

```sh
NOW=$(($(date +%s) * 1000))
curl -i -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"

curl -i -sS -X DELETE \
  http://127.0.0.1:3000/v1/appointments/appointment-1
```

أوقف العملية الأمامية باستخدام `Ctrl-C`. لا تنشئ App مخفياً ثانياً لخدمة السياسة؛ فالمثال الحالي يضع Server الخاص بالسياسة وWeb Server في Core App نفسه.

الفحوص المركّزة للمثال الحالي:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

ويعلن المثال أيضاً غلاف E2E:

```sh
bun run --cwd examples/healthcare-appointments test:e2e
```

يبني هذا الأمر مهمة E2E للمثال ويشغّلها. إنه أمر للتنفيذ، وليس تصريحاً بأن checkout الحالي اجتازه.

## M0: ابدأ بقواعد المجال

وحدة المجال Context-first رغم أن القسم الحرج في المستودع داخل الذاكرة متزامن. يجعل ذلك الإلغاء واستبدال المزوّد المستقبلي ظاهرين عند الحدّ:

```ts
import type { Context } from "@go-like/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment extends BookAppointmentCommand {
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}
```

ينبغي للمستودع أن يفحص `ctx.err()` قبل تغيير الحالة. وتفعل `newMemoryAppointmentRepository()` الحالية ذلك، كما تخزّن بصمة مع كل موعد. وقاعدة التداخل هي:

```ts
function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}
```

تجعل هذه القاعدة المواعيد المتجاورة صحيحة، بينما تفشل المواعيد النشطة المتداخلة للطبيب الواحد. يغيّر الإلغاء الحالة المخزنة إلى `cancelled`؛ ويعيد الإلغاء الثاني السجل الملغى نفسه.

### اختبارات M0

اكتب هذه الاختبارات قبل إضافة HTTP أو Transport:

```ts
import { background } from "@go-like/context"
import { expect, test } from "bun:test"

// The concrete repository factory is the one in src/service.ts.
test("rejects an overlapping active slot", () => {
  const repository = newMemoryAppointmentRepository()
  const book = newBookAppointment(repository, () => 1_000)
  book(background(), {
    appointmentId: "a-1",
    doctorId: "doctor-1",
    patientId: "patient-1",
    startsAt: 2_000,
    endsAt: 3_000
  })

  expect(() =>
    book(background(), {
      appointmentId: "a-2",
      doctorId: "doctor-1",
      patientId: "patient-2",
      startsAt: 2_500,
      endsAt: 3_500
    })
  ).toThrow("doctor time conflict")
})
```

يحتوي `test/main.test.ts` الحالي على هذه الحالة، إضافة إلى إعادة استخدام الإلغاء، والإلغاء idempotent، وفحص معالج HTTP. وتظل هذه الاختبارات دليلاً من المستودع إلى أن يُشغّل الأمر أعلاه في بيئتك.

## M1: خدمة سياسة داخلية typed

يستخدم العقد الداخلي typed `@go-like/struct` و`@go-like/transport`. هذا تحقق وقت التشغيل على حدّ Message أحادي، وليس IDL ولا خدمة RPC مولّدة.

### `src/contract.ts`

```ts
import { struct, type Infer } from "@go-like/struct"
import { endpoint } from "@go-like/transport"

const CheckRequest = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const CheckResponse = struct.object({
  allowed: struct.boolean()
})

export type CheckRequest = Infer<typeof CheckRequest>
export type CheckResponse = Infer<typeof CheckResponse>

export const checkAppointment = endpoint(
  "appointment-policy",
  "AppointmentPolicy.Check",
  CheckRequest,
  CheckResponse
)
```

رموز المسار ASCII المرئية، ولا يجوز أن تحتوي `/` أو `*`. يحتوي `Endpoint` على مثيلي Struct للطلب والاستجابة وعلى رمزي المسار. ولا يصف عنوان شبكة ولا عميلاً مولّداً.

### `src/transport.ts`

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { checkAppointment, type CheckRequest, type CheckResponse } from "./contract"

const policyAddress = "memory://appointment-policy"

export interface AppointmentPolicy {
  readonly server: Server
  validate(ctx: Context, request: CheckRequest): Promise<CheckResponse>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  const server = newServer(
    serverTransport(transport),
    address(policyAddress),
    handler(checkAppointment, (_ctx, request) => {
      if (request.endsAt - request.startsAt > maximumDurationMs) {
        throw new Error("appointment duration exceeds policy")
      }
      return { allowed: true }
    })
  )

  return Object.freeze({
    server,
    async validate(ctx: Context, request: CheckRequest): Promise<CheckResponse> {
      return await client.call(ctx, checkAppointment, request, withAddress(policyAddress))
    },
    close(ctx: Context): Promise<void> {
      return client.close(ctx)
    }
  })
}
```

يستخدم المثال الملتزم حالياً معالج سياسة `Message` خاماً و`serviceError(...)` مع الحالة `409`. وهذا حد أدنى صالح. تغيّر النسخة typed أعلاه codec الطلب والاستجابة، لكنها لا تغيّر نموذج الملكية الأساسي: مثيل Memory Transport واحد، وServer داخلي واحد، وClient واحد، وإغلاق صريح.

### مرّر Context

ينبغي لحالة الاستخدام الخاصة بالحجز أن تمرر Context الطلب نفسه إلى Client الخاص بالسياسة والمستودع:

```ts
async function validatedBook(ctx: Context, command: CheckRequest): Promise<Appointment> {
  await policy.validate(ctx, command)
  return repository.book(ctx, command)
}
```

استبدال `ctx` بـ `background()` سيلغي المهلة والإلغاء وتسلسل Context الخاص بالطلب. وهذا تراجع في الصحة، لا تبسيط غير مؤذٍ.

### اختبارات M1

اختبر كل ما يأتي:

| الاختبار               | النتيجة المتوقعة                        |
| ---------------------- | --------------------------------------- |
| valid typed request    | `allowed: true` وموعد محجوز             |
| overlong request       | فشل السياسة قبل تغيير المستودع          |
| invalid field type     | فشل فك الطلب typed                      |
| invalid response shape | فشل ترميز الاستجابة typed عند حد Server |
| canceled Context       | تلاحظ السياسة والمستودع الإلغاء نفسه    |
| client close           | تنظيف Client المقيم في Transport صريح   |

يتحقق اختبار السياسة الحالي في المثال بالفعل من الرفض قبل تغيير المستودع، ومن النجاح عبر `Client -> Memory Transport -> Server`. أما الاختبار typed فهو امتداد مقترح.

## M2: Cache التوافر

يفيد Cache في إسقاط قراءة، لا في مرجعية الحجز. تعرض حزمة Cache الدوال `get` و`put` و`delete` التي تأخذ Context أولاً؛ وتوفر `@go-like/cache-memory` الدالة `newMemoryCache()`، بينما توفر `@go-like/cache` الدالة `expiresIn(...)`:

```ts
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

const availabilityCache = newMemoryCache()

async function readAvailability(ctx: Context, doctorId: string) {
  const key = `availability/${doctorId}`
  const cached = await availabilityCache.get(ctx, key)
  if (cached !== null) {
    return JSON.parse(new TextDecoder().decode(cached)) as Availability
  }

  const authoritative = repository.readAvailability(ctx, doctorId)
  await availabilityCache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
  return authoritative
}

async function invalidateAvailability(ctx: Context, doctorId: string): Promise<void> {
  await availabilityCache.delete(ctx, `availability/${doctorId}`)
}
```

إن `repository.readAvailability(...)` دالة يملكها التطبيق في هذا الدليل، وليست export من go-like. يجب أن يلغي الحجز والإلغاء المفتاح بعد التغيير المرجعي. إذا فشل الإبطال، فأبلغ عنه واختر سياسة اتساق صريحة؛ ولا تعامل Cache سراً على أنه مصدر حقيقة الحجز.

### اختبارات M2

- يقرأ miss المستودع ويملأ Cache؛
- لا يقرأ hit المستودع مرة أخرى؛
- يحذف الحجز أو الإلغاء الإسقاط؛
- يعود value منتهٍ إلى المستودع؛
- لا يحوّل فشل Cache القراءة المرجعية الصحيحة إلى نتيجة حجز زائفة؛
- يفقد Memory Cache حالة العملية عند إعادة التشغيل عن قصد.

## M3: الحيوية والجاهزية

أنشئ Registry في جذر التركيب، ووجّه مسارين إلى `createHealthHandler(...)`:

```ts
import { createHealthHandler } from "@go-like/web/health"
import { newProbeRegistry } from "@go-like/health"
import type { Handler } from "@go-like/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policy.server.endpoint(ctx)
})

const healthHandler = createHealthHandler(probes)
const appointmentHandler: Handler = newAppointmentHandler(book, cancel)

const webHandler: Handler = (request) => {
  const path = new URL(request.url).pathname
  if (path === "/livez" || path === "/readyz") return healthHandler(request)
  return appointmentHandler(request)
}
```

المساران الافتراضيان هما `/livez` و`/readyz`. تكون liveness الفارغة سليمة؛ وتفشل readiness الفارغة مغلقة. يجعل فحص `policy` أعلاه الجاهزية معتمدة على قبول المستمع الداخلي، من دون الادعاء بأن قاعدة بيانات خارجية تعني دائماً حيوية العملية.

ينبغي لخدمة إنتاجية أن تضيف إلى readiness التبعيات المطلوبة فعلاً لحركة المرور فقط. أسماء الفحوص معرّفات عامة، وpayloads الصحة منظّفة عمداً.

## M4: مالك واحد لدورة الحياة

ينبغي لجذر التركيب إنشاء الموارد مرة واحدة ووضعها تحت App واحد:

```ts
import process from "node:process"
import { afterStart, afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

const policy = newAppointmentPolicy()
const httpServer = newNodeServer(webHandler, hostname("127.0.0.1"), port(3000))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=healthcare-appointments\n")
  }),
  afterStop((ctx) => policy.close(ctx))
)

await app.run()
```

إن hook `afterStop` حد ترتيب صريح لـ policy Client. ويوقف Core نفسه Servers الأشقاء بالتوازي. إذا احتجت إلى ترتيب تبعيات أكثر تعقيداً، فركّب الموارد التابعة في Server واحد أو في hook صريح بدلاً من الاعتماد على ترتيب التصريح.

إن `signal()` هو محوّل عملية Node/Bun. ويمكن أن تبقى وحدات المجال والعقد typed وMemory Transport والصحة محمولة؛ أما الاستيراد من `@go-like/core/node` فاختيار مقصود لبيئة التشغيل.

## M5: خطة الاختبار والدليل

| الطبقة     | الاختبار                                                    | هدف الدليل                                    |
| ---------- | ----------------------------------------------------------- | --------------------------------------------- |
| Domain     | overlap وcancellation reuse وidempotency وconflicting ID    | سلوك `src/service.ts` ونتيجة اختبار الوحدة    |
| Context    | لا يغيّر الحجز الملغى المستودع ولا يستدعي policy            | اختبار Context مركّز                          |
| Typed call | Struct decode/encode وpolicy rejection وresponse validation | حد `@go-like/client` و`@go-like/server`       |
| Cache      | miss وhit وTTL وinvalidation وfailure fallback              | اختبارات `newMemoryCache()`                   |
| Health     | empty liveness وempty readiness وfailing probe و405/404     | `newProbeRegistry()` و`createHealthHandler()` |
| HTTP       | `POST` و`DELETE` وinvalid JSON وconflict status             | اختبار Fetch Handler القياسي                  |
| Lifecycle  | قبول policy وWeb Server تحت App واحد؛ وإغلاق Client صراحةً  | سلوك Core App وServer النهائي                 |
| Node E2E   | bind حقيقي وrequest وsignal وstop وتحرير المنفذ             | غلاف E2E للمثال والفحوص المتبقية              |

في مثال المستودع الحالي، الأوامر المركّزة هي:

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/healthcare-appointments test:e2e
```

ولمسار الأمثلة كله:

```sh
bun run test:e2e:examples
```

يبني مسار E2E الكامل الحزم ويستخدم runner المستودع. أما مزوّدات Docker ومستهلكو بيئات التشغيل المختلفة فهما نطاقان منفصلان. سجّل commit المرشح، وإصدارات بيئة التشغيل، وحالة الخروج، والملخص، وأي عمليات أو حاويات متبقية؛ فوجود script لا يعني نجاحاً.

## المراحل

| المرحلة | الناتج القابل للتسليم                      | انتقل عندما...                                                        |
| ------- | ------------------------------------------ | --------------------------------------------------------------------- |
| M0      | مستودع المجال واختبارات القاعدة            | يكون سلوك التداخل والإلغاء حتمياً                                     |
| M1      | Typed policy Endpoint فوق Memory Transport | يكون الاستدعاء Client/Server/Transport حقيقياً لا استدعاء دالة مباشرة |
| M2      | إسقاط Cache مع إبطال                       | لا يستطيع فشل Cache استبدال المرجعية                                  |
| M3      | `/livez` و`/readyz`                        | تفهم readiness الفارغة والفحوص الفاشلة                                |
| M4      | App واحد وsignal وتنظيف Client صريح        | يملك كل مورد مقبول مالكاً واحداً                                      |
| M5      | دليل Unit وNode E2E                        | تُسجّل النتائج مع الأمر وحالة الخروج                                  |

لا تضف Registry أو Redis أو Vault أو broker حقيقياً أو authentication أو retries قبل وضوح هذه المراحل. فكل إضافة منها تدخل نموذج ملكية أو فشل جديداً ينبغي إدخاله عمداً.

## استكشاف الأخطاء

### `Cannot find package "@go-like/..."`

غالباً ما تعمل خارج workspace أو تعتمد على حزمة غير منشورة. شغّل `bun install --frozen-lockfile` من جذر المستودع ونفّذ script من workspace مثل `bun run --cwd examples/healthcare-appointments start`.

### يعيد الطلب `404`

لا يعرِض المثال الحالي إلا `POST /v1/appointments` و`DELETE /v1/appointments/{appointmentId}`. تحقّق من method والمسار وسطر `GO_LIKE_EXAMPLE_READY`. تنتمي مسارات الصحة إلى امتداد الدليل M3، لا إلى المثال الملتزم الحالي.

### يعيد الطلب `400`

يتطلب المثال IDs نصية وقيم `startsAt`/`endsAt` رقمية. يجب أن يكون `startsAt` في المستقبل بالنسبة إلى الساعة المحقونة، وأن يكون `endsAt` أكبر من `startsAt`. تحقّق من أن حساب shell أنتج أرقاماً لا نصوصاً مقتبسة.

### يعيد الطلب `409`

إما أن فترة الطبيب تتداخل مع موعد نشط، أو أُعيد استخدام appointment ID بمحتوى مختلف، أو رفضت خدمة السياسة مدة الموعد. تُستدعى السياسة قبل تغيير المستودع، لذلك لا ينبغي لرفضها أن ينشئ سجلاً.

### يبلّغ الاستدعاء typed عن جسم طلب أو استجابة غير صالح

تحقّق من أن Client وServer يستخدمان مثيلي `Endpoint` وStruct نفسيهما، وأن Content-Type للطلب هو `application/json` بالضبط. ينفّذ `handler(contract, fn)` تحقق JSON وStruct عند حد Server.

### لا يستطيع Memory Client الوصول إلى Server

ينشئ `newMemoryTransport()` خريطة عناوين خاصة بكل مثيل. يجب أن يشترك Client وServer في مثيل Transport نفسه وفي عنوان `memory:` المرتبط نفسه تماماً. لا يربط URL المتطابق في مثيلين منفصلين من Memory Transport بينهما.

### يبدو أن `app.run()` عالق

قد يبقى `Server.start(ctx)` طويل العمر في الانتظار طوال مدة الخدمة. هذا متوقع. يحل `app.run()` بعد الإيقاف والتنظيف النهائي، لا فور ربط listener. استخدم `afterStart` أو `server.endpoint(ctx)` لإشارة القبول.

### يعيد stop timeout أو خطأً مجمعاً

تضع المهلة حداً لانتظار تنظيف المستدعي. ولا تثبت أن مورداً أصلياً توقف، كما أن Servers الأشقاء تتوقف بالتوازي. افحص الخطأ الأساسي وحاجز النهاية في المحوّل وأدلة العملية أو socket المتبقية قبل اعتبار الإيقاف نظيفاً.

### اختفت بيانات Cache

إن `@go-like/cache-memory` محلي للعملية وقابل للتخلص. استخدم Store صريحاً للسجلات المرجعية، ووثّق durability والملكية الفعليتين بدلاً من معاملة Cache كقاعدة بيانات.

## خلاصة الحدّ

يعلّم هذا المشروع مساراً حقيقياً داخل go-like مع بقائه صغيراً:

```text
Request
  -> standard Fetch Handler
  -> Context-first appointment use case
  -> typed Client call
  -> Memory Transport
  -> unary Server policy handler
  -> canonical appointment repository
  -> disposable availability Cache
  -> Response

App.stop()
  -> deregistration if configured
  -> concurrent Server stop
  -> explicit Client / provider cleanup
  -> terminal result
```

ولا يعلّم gRPC أو Protobuf أو توليد IDL أو تدفقات داخلية full-duplex أو locking موزعاً أو messaging دائماً أو authentication إنتاجياً. هذه قرارات تصميم منفصلة خارج نطاق هذا المشروع الصغير.
