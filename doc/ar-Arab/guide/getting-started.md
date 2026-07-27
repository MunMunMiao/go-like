# البدء

ثبّت فقط الأجزاء التي تحتاج إليها خدمتك. تبدأ خدمة HTTP معتادة بالحزم `@likego/context` و`@likego/core` و`@likego/web`، مع محوّل إطار Web الذي اخترته. أما الاستدعاءات الداخلية فتضيف `@likego/client` و`@likego/transport` و`@likego/transport-http`. يبقى اكتشاف الخدمات والإعداد والتخزين اختيارات صريحة، ولا تظهر كإعدادات افتراضية مخفية.

> [!IMPORTANT]
> لم تُنشر حزم `@likego/*` على npm بعد. عند العمل من نسخة المستودع، يحلّ `workspace:*` الاعتماديات إلى حزم `@likego/*` المحلية؛ ولا يعني الإصدار `0.0.1` في ملفات manifest أنها منشورة على npm. لذلك يصف أمر `bun add` أدناه المسار المتاح بعد النشر. للتحقق من المصدر الحالي وتشغيله من جذر المستودع:
>
> ```sh
> bun install --frozen-lockfile
> bun run test:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @likego/context @likego/core @likego/web
```

أنشئ `src/main.ts`:

```ts
import { background } from "@likego/context"
import { context, name, newApp, server, stopTimeout } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Handler } from "@likego/web"
import { newNodeServer, port } from "@likego/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from LikeGo", path })
}

const app = newApp(
  context(background()),
  name("hello"),
  server(newNodeServer(handler, port(3000))),
  stopTimeout(30_000),
  signal()
)

await app.run()
```

شغّل الخدمة:

```sh
bun run src/main.ts
```

يمكن لأي كائن يحقق عقد `Server` بنيوياً أن ينضم إلى التطبيق. توفّر حزم مثل `@likego/croner` و`@likego/bullmq` و`@likego/pino` و`@likego/winston` محوّلات لمكتبات شائعة، لكنها لا تستبدل تلك المكتبات ولا تنسخ جميع خياراتها إلى واجهة جديدة.

أنشئ بيانات الاعتماد وعملاء الشبكة وإعداد إطار العمل داخل شيفرة التطبيق. مرّر إلى LikeGo أقل قدرة لازمة، وغالباً ما تكون كائناً أصلياً موجوداً أو دالة `fetch` محقونة. بهذه الطريقة تصبح الاختبارات حتمية، ويظل واضحاً عند الإيقاف من يملك كل اتصال أو مستمع ومن تقع عليه مسؤولية إغلاقه.
