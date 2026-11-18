# مقارنة go-like بالأدوات الأخرى

تبدأ المقارنة العادلة من الملكية. تحل NestJS وFastify وHono وElysia وKoa وtRPC أجزاء مختلفة من تطبيق TypeScript. go-micro وgo-kratos مرجعان في Go بنقل وتوليد شيفرة مختلفين. go-like لوحة Socket: طبقات دورة حياة صريحة، واستدعاءات داخلية، وPlugs للأنظمة الخلفية التي تختارها.

تسميات الدليل في هذه الصفحة:

- **Source** يعني أن checkout الحالي يعرض API.
- **Pinned external** يعني إصداراً أو commit أو صفحة رسمية مسجّلة. وهو ليس benchmark جديداً.
- **Declared** يعني أن مثالاً أو اختباراً موجود. وهو ليس نتيجة نجاح.
- **Gap** يعني أن هذا المستودع لا يثبت التزام توافق.

خط أساس التوثيق التاريخي هو commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. يحتوي سجل البحث على commitين لـ go-micro: `9d306dcfc1a912a8a9493f31fee0bb983475258d`، وللمذكرة `v6.9.0`، `3c39d17fadaa9ec21b671be4afef3e63846406e6`. عامل الاثنين بوصفهما مدخلين يُعاد التحقق منهما.

## موقع go-like في المكدس

| الأداة     | ما تملكه عادة                                     | ما تضيفه go-like بجانبه                                                  |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| NestJS    | الوحدات والمتحكمات والمزيّنات وسياق التطبيق        | `Server` بنيوي فقط إذا كتبت ذلك المحوّل                                   |
| Fastify   | المسارات والخطافات والإضافات ومستمع Node           | حد دورة حياة أو استدعاء حول مورد ما زال Fastify يملكه                    |
| Hono      | المسارات وmiddleware و`app.fetch`                 | طبقات App، والاستدعاءات الداخلية، وPlugs                                  |
| Elysia    | شجرة المسارات والمخطط والخطافات ومحوّلها الخاص     | الشيء نفسه، بينما يبقى `.listen()` لـ Elysia                             |
| Koa       | middleware وموجّه خارجي                            | دورة الحياة والاستدعاءات الداخلية، من دون موجّه آخر                        |
| tRPC      | الإجراءات والمحلّلات والمحوّلات                        | الاكتشاف والاختيار ودورة حياة App                                          |
| go-micro  | Go Context والخدمة والسجل والوسيط وسطح وكيل أوسع  | المفردات فقط. لا Go ABI                                                   |
| go-kratos | دورة حياة App وHTTP/gRPC والسجل والإعداد وProtobuf | تركيب TypeScript. مسار gRPC هو Connect-ES، لا بيئة Google                 |
| go-like   | Sockets والطبقات واستدعاءات Fetch وSSE وPlugs     | ما زال التطبيق يملك المسارات والسياسة والمصادقة وتفاصيل البروتوكول الأصلي |

## الملكية

| الاهتمام             | go-like                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| المسارات الخارجية   | الإطار أو `Handler` التطبيق                                                                 |
| معالج Web           | `(Request) => Response \| Promise<Response>`                                               |
| دورة حياة العملية   | `newApp`، وثلاث طبقات، وخطافات                                                              |
| الاعتماديات          | دوال إنشاء وخيارات. لا حاوية                                                                |
| الاستدعاءات الداخلية | `Transport` و`Client` و`Server` و`defineService` وSSE `ServerStream`                       |
| الاكتشاف             | `Registry` و`Discovery` ومرشحات وخمسة مُختارات                                              |
| إعادة المحاولة      | محاولة واحدة ما لم تفوّض `withRetry` المزيد                                                 |
| التدفق              | Web Streams عند الحافة؛ JSON أو SSE داخلياً؛ أربع أنماط gRPC على `@go-like/connectrpc/node` |
| القياس              | يسجّل core وحدات العمل. تملأ Plugs عقود القياس. لا تسجيل عام                                  |

## دورة الحياة وContext

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` بنيوي: `start(ctx)` و`stop(ctx)`. في طبقة الموارد، يُحل `start` عندما يصبح المورد قابلاً للاستخدام. في طبقة الخوادم، قد يبقى `start` معلّقاً، وتعمل إيقافات الأشقاء بالتزامن. تعمل إيقافات الموارد بترتيب التصريح العكسي. لسياق Nest، أو رسم إضافات Fastify، أو خطاف Elysia ترتيبه الخاص. قارن المالكين، لا كلمة «رشيق».

يعرض Context الدوال `deadline()` و`done()` و`err()` و`value(key)`، مع `background` و`withCancel` و`withTimeout` و`withDeadline` و`withoutCancel` و`withValue`. يستخدم `AbortSignal` داخلياً. وهو ليس Go `context.Context` وليس واجهة gRPC.

## الاستدعاءات وإعادة المحاولة والتدفقات

المسار الداخلي هو Client، وDiscovery اختيارية، ومرشحات، ومُختار، ونقل، ثم `POST /<service>/<endpoint>`، ثم معالج الخادم. تتحقق نقطة النهاية النمطية من JSON عبر Struct. وهي ليست IDL. تختار `withEndpoint("discovery:///name")` خدمة. وقائمة العناوين المباشرة لا تفعل ذلك.

تنفّذ الاستدعاءات محاولة واحدة ما لم تضبط `withRetry` القيمة `authorization` على `"idempotent"` أو `"caller-approved"`، و`maxAttempts` موجباً، و`shouldRetry`. ذلك التفويض إعلان. الاستجابة التي استُلمت مسبقاً لا تُعاد عندما تفشل التغذية الراجعة اللاحقة.

```text
Web Handler
  Web Streams, framework SSE, or WebSocket

@go-like/core client and server
  one JSON body, or SSE when stream: true

@go-like/connectrpc
  Connect and gRPC-Web unary and server-streaming on Fetch

@go-like/connectrpc/node
  standard gRPC unary, server-streaming, client-streaming, and bidi
```

حلقة إعادة المحاولة الافتراضية في go-micro وأشكال تدفق HTTP في go-kratos خاصة بالإصدار. أعد التحقق من الـ commits المثبّتة قبل نشر مقارنة تعتمد عليها.

## بيئات التشغيل

تستخدم المداخل المشتركة Fetch و`AbortSignal` أو قدرة محقونة. يعيش TLS المخصص وHTTP/2 وmTLS على `@go-like/core/transport/http/node` و`@go-like/connectrpc/node`. تمرر أمثلة Hono وElysia وH3 وFetch العادي معالج Fetch إلى مضيف core. لا يوجد جسر NestJS أو Fastify في هذا المستودع. لا يثبت إصدار manifest `0.0.1` النشر على npm.

## بحسب الأداة

**NestJS.** تبقى الوحدات والمزوّدات والمتحكمات لـ Nest. التكامل هو `Server` يملكه التطبيق حول تطبيق Nest، بقبول وإغلاق صريحين. لا يتضمن هذا المستودع ذلك المحوّل.

**Fastify.** تبقى المسارات والتغليف والمستمع لـ Fastify. ولا تحوّل go-like الكائنين `request` / `reply` إلى Fetch `Handler`.

**Hono.** يمرر `examples/hono` الدالة `app.fetch` إلى `newNodeServer` ويضع ذلك المضيف في `server(...)`. تبقى المسارات في Hono.

**Elysia.** أبقِ شجرة المسارات وسلوك Bun الخاص. يستخدم المثال معالج Fetch مع مضيف Node. `.listen()` ليست واجهة go-like.

**Koa.** أبقِ middleware والموجّه الخارجي. أضف حد دورة حياة أو استدعاء فقط حيث تستطيع تسمية المالك.

**tRPC.** تبقى الإجراءات لـ tRPC. نقطة نهاية go-like هي Struct فوق JSON Fetch، لا موجّه إجراءات.

**go-micro وgo-kratos.** هما مرجعان لاستدعاءات تضع Context أولاً، ولدورة الحياة، ولمفردات الاكتشاف. تنتج المراقبون في go-like لقطات استبدال كاملة. مدخل gRPC المُدار هو `@go-like/connectrpc/node`.

## ماذا تختار؟

استخدم الإطار الذي يملك المشكلة التي لديك فعلاً. أضف Socket من go-like عندما تكون القطعة الناقصة هي القبول أو الإلغاء أو الاكتشاف أو عقد نظام خلفي بمالك مسمّى. تثبيت كل Plug في تطبيق إطار مكتمل يزيل فائدة العقود الصغيرة.

## مراسي الدليل

الشجرة الحالية:

- `packages/core/src/app/app.ts` و`packages/core/src/app/tiers.ts` للطبقات والميزانيات وترتيب الإيقاف؛
- `packages/core/src/lifecycle/index.ts` لـ `Server` و`Endpointer`؛
- `packages/core/src/web/context.ts` لـ `Handler` و`contextHandler`؛
- `packages/core/src/client/index.ts` لخيارات الاستدعاء والاكتشاف وإعادة المحاولة؛
- `packages/core/src/server/index.ts` للإرسال الداخلي؛
- `packages/core/src/transport/service.ts` لـ `defineService`؛
- `packages/core/src/registry/selector.ts` للمرشحات والمُختارات والتغذية الراجعة؛
- `packages/connectrpc/src/node.ts` لـ gRPC المُدار.

مدخلات خارجية مثبّتة، ولم تُعد هذه المراجعة التوثيقية التحقق منها:

- [commit مقارنة go-micro](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)؛
- [commit go-micro v6.9.0](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6)؛
- [commit go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)؛
- [commit go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)؛
- [دورة حياة NestJS](https://docs.nestjs.com/fundamentals/lifecycle-events)، و[خادم Fastify](https://fastify.dev/docs/latest/Reference/Server/)، و[Hono](https://hono.dev/docs/api/hono)، و[دورة حياة Elysia](https://elysiajs.com/essential/life-cycle)، و[Koa](https://koajs.com/)، و[موجّهات tRPC](https://trpc.io/docs/server/routers).

إصدارات TypeScript من أطراف ثالثة سُجّلت للمقارنة، لا بوصفها وعود توافق: NestJS `@nestjs/core@11.1.28`، وFastify `5.11.2`، وHono `4.12.34`، وElysia `1.4.29`، وKoa `3.2.1`، وtRPC `@trpc/server@11.18.0`. manifest مثال Elysia هو التثبيت لذلك المثال؛ وهذا الجدول لقطة البحث.
