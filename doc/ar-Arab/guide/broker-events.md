# الوسيط والأحداث والمهام

الرسائل والعمل المجدول ثلاثة Sockets.

- **Broker** ينشر البايتات ويشترك فيها على موضوع، ويحتفظ بكائن التسليم الأصلي لدى المزوّد.
- **Event** مرمّز فوق تلك البايتات. يعيش على `@go-like/core/broker` باسم `eventBroker`. وهو ليس حزمة منفصلة، ولا سجل تاريخ، ولا محرك إعادة تشغيل.
- **Job** جدول (`Schedule`) أو طابور (`JobQueue`). يملأ Croner الجدول. ويملأ BullMQ الطابور.

يسجّل core الأحداث `messaging.publish` و`messaging.process` و`job.run` و`job.enqueue` عندما يستدعي Plug عُدّة المزوّد. ولا تفتح معالجات التطبيق تلك الـ spans بنفسها.

## الوسيط

```ts
import { newBrokerServer, type BrokerMessage } from "@go-like/core/broker"
import type { Context } from "@go-like/core/context"

declare function handle(ctx: Context, event: { readonly message: BrokerMessage }): Promise<void>
declare const broker: Parameters<typeof newBrokerServer>[0]

const consumer = newBrokerServer(broker, "appointments.created", async (ctx, event) => {
  await handle(ctx, event)
})
void consumer
```

يملك `newBrokerServer` إيقاف الاشتراك المقبول. وهو لا يغلق اتصالاً أو تدفقاً أو مستهلكاً دائماً مستعاراً إلا إذا قال عقد ذلك Plug ذلك. سلسلة الموضوع هي وسم الاشتراك المستخدم في القياس عن بعد. في JetStream، يختار مصنع الرسائل أي الرسائل تصل. والوسم لا يختار.

`event.native` هو كائن المزوّد (`Msg` أو `JsMsg` أو تسليم AMQP). تبقى ack وnack وterm وdead-letter على ذلك الكائن. وليس لدى core طريقة تسوية مشتركة.

يصدّر `@go-like/core/broker/memory` الدالة `newMemoryBroker` للاختبارات. ويصدّر `@go-like/core/broker/provider` الدوال `deliver` و`publish` و`registerSubscriberTerminal` لمؤلفي Plug.

| Plug                       | دالة الإنشاء                                                      | الملكية الأصلية                                                      |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@go-like/nats/broker`     | `newNatsCoreBroker(connection, ...options)`                      | تصريف الاشتراك. يحد `natsCoreDrainTimeout` الانتظار، ثم يلغي الاشتراك. |
| `@go-like/nats/jetstream`  | `newNatsJetStreamBroker(jetstream, messagesFactory, ...options)` | مكرّر المستهلك. يحد `natsJetStreamCloseTimeout` الإغلاق، ثم الإيقاف.    |
| `@go-like/rabbitmq/broker` | `newRabbitMqBroker(channel)`                                     | كائن التسليم الخاص بالقناة.                                         |
| `@go-like/rabbitmq/broker` | `startRecoveringRabbitMqBroker(...)`                             | يقبل المقبض قبل جاهزية الموصّل. يبقى النشر مغلقاً إلى أن يوجد جيل.    |

اتصال NATS فتحه التطبيق ينتمي إلى طبقة الموارد:

```ts
import { newApp, resources, server } from "@go-like/core"
import { newResourceServer } from "@go-like/core/lifecycle"
import { newBrokerServer } from "@go-like/core/broker"
import { newNatsJetStreamBroker } from "@go-like/nats/jetstream"

const nats = newResourceServer({
  terminal: connection.closed(),
  close: () => connection.drain()
})
const subscription = newBrokerServer(
  newNatsJetStreamBroker(jetstream, messagesFactory),
  "telemetry.raw.v1",
  async (_ctx, event) => {
    // Settlement stays on the JetStream message: event.native.ack(), nak(), or term().
    void event.native
  }
)
const app = newApp(resources(nats), server(subscription))
void app
```

`connection` و`jetstream` و`messagesFactory` هي الكائنات التي حصل عليها التطبيق من عميل NATS. المقتطفات أعلاه شكل الملكية؛ وفي README الخاص بـ Plug بناء العميل.

## الأحداث النمطية

```ts
import { eventBroker } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

const payload = struct.object({ id: struct.string() })
const events = eventBroker(newMemoryBroker(), jsonCodec(payload))
```

ترمّز `events.publish`. وتفك `event.decode()` نسخة دفاعية واحدة. إخفاق المرمّز إخفاق Struct أو بروتوكول، وليس تسليماً ناجحاً.

## المهام

يملك `newScheduleServer(schedule, name, handler)` من `@go-like/core/job` المؤقّت والتداخل والتصريف. `newIntervalSchedule(ms)` هو جدول core. `newCronerSchedule(pattern, options)` من `@go-like/croner/job` جدول Croner خالص: وهو لا يشغّل مؤقّت Croner الخاص. مرّره إلى `newScheduleServer`.

تعيد `JobQueue.worker(handlers)` كائن `Server` لطبقة الخوادم. الطابور نفسه، عندما يحتاج إلى اتصال، ينتمي إلى `resources(...)` حتى يبدأ العامل فقط بعد أن يصبح الطابور قابلاً للاستخدام ويتوقف قبل أن يُغلق الطابور.

```ts
import { newApp, resources, server } from "@go-like/core"
import { newIntervalSchedule, newScheduleServer } from "@go-like/core/job"
import { newBullMqJobQueue } from "@go-like/bullmq/job"

const jobs = newBullMqJobQueue(bullQueue)
const worker = jobs.worker({
  report: async (_ctx, job) => {
    await writeReport(job.payload)
  }
})
const scheduler = newScheduleServer(newIntervalSchedule(60_000), "report", async (ctx) => {
  await jobs.enqueue(ctx, "report", { window: "hourly" }, { id: "report-hourly" })
})
const app = newApp(resources(jobs), server(worker, scheduler))
void app
```

`bullQueue` هو `Queue` من BullMQ الذي أنشأه التطبيق، و`writeReport` شيفرة تطبيق. يتبنّى `newBullMqJobQueue` الطابور: تنتظر `start` حتى يصبح جاهزاً، وتغلقه `stop` مرة واحدة. يعني `GO_LIKE_BULLMQ_UNEXPECTED_EXIT` أن Worker انتهى من دون `stop`. تستخدم حالة الطابور والتصريف الرمزين `GO_LIKE_JOB_STATE` و`GO_LIKE_JOB_DRAIN_TIMEOUT` من `@go-like/core/job`. تعلّم `newPermanentJobError` إخفاقاً لا ينبغي للطابور أن يعيد محاولته. خيار `id` هو مفتاح idempotency ما دام عمل غير منتهٍ يحمله.

`@go-like/core/job/provider` (`runJob` و`enqueue` و`dispatchJob`) لمؤلفي Plug. تستخدم شيفرة التطبيق `newScheduleServer` و`JobQueue`.

## الإيقاف

يتبع ترتيب الإيقاف الطبقات في [البنية](/ar-Arab/guide/architecture). يتوقف خادم الوسيط مع طبقة الخوادم. يتوقف اتصال أو طابور في `resources(...)` بعد ذلك، بترتيب التصريح العكسي. تبدأ مهلة التصريف إلغاء الاشتراك أو الإغلاق الأصلي ولا تثبت أن الكائن الأصلي قد انتهى. راقب وعد المزوّد النهائي قبل استبدال المالك.

رموز الخروج غير المتوقع ومهلة التصريف في NATS موجودة على `@go-like/nats/broker` و`@go-like/nats/jetstream`. وهي مدرجة في [معالجة الأخطاء](/reference/errors).
