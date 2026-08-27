# البدء

ثبّت فقط الأجزاء التي تحتاج إليها خدمتك. تبدأ خدمة HTTP معتادة بالحزم `@go-like/context` و`@go-like/core` و`@go-like/web`، مع إطار Web يوفّر معالج Fetch أصلياً. أما الاستدعاءات الداخلية فتضيف `@go-like/client` و`@go-like/transport` و`@go-like/transport-http`. يبقى اكتشاف الخدمات والإعداد والتخزين اختيارات صريحة، ولا تظهر كإعدادات افتراضية مخفية.

> [!IMPORTANT]
> لم تُنشر حزم `@go-like/*` على npm بعد. عند العمل من نسخة المستودع، يحلّ `workspace:*` الاعتماديات إلى حزم `@go-like/*` المحلية؛ ولا يعني الإصدار `0.0.1` في ملفات manifest أنها منشورة على npm. لذلك يصف أمر `bun add` أدناه المسار المتاح بعد النشر. للتحقق من المصدر الحالي وتشغيله من جذر المستودع:
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @go-like/context @go-like/core @go-like/web
```

أنشئ `src/main.ts`:

```ts
import process from "node:process"

import { background } from "@go-like/context"
import { afterStart, context, name, newApp, server, stopTimeout } from "@go-like/core"
import { signal } from "@go-like/core/node"
import type { Handler } from "@go-like/web"
import { newNodeServer, port } from "@go-like/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from go-like", path })
}

const webServer = newNodeServer(handler, port(3000))
const app = newApp(
  context(background()),
  name("hello"),
  server(webServer),
  stopTimeout(30_000),
  signal(),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=hello\n")
  })
)

await app.run()
```

شغّل الخدمة:

```sh
bun run src/main.ts
```

انتظر ظهور `GO_LIKE_EXAMPLE_READY=hello` قبل إرسال الطلبات. يمكن لأي كائن يحقق عقد `Server` بنيوياً أن ينضم إلى التطبيق. توفّر حزم مثل `@go-like/croner` و`@go-like/bullmq` و`@go-like/pino` و`@go-like/winston` محوّلات لمكتبات شائعة، لكنها لا تستبدل تلك المكتبات ولا تنسخ جميع خياراتها إلى واجهة جديدة.

أنشئ بيانات الاعتماد وعملاء الشبكة وإعداد إطار العمل داخل شيفرة التطبيق. مرّر إلى go-like أقل قدرة لازمة، وغالباً ما تكون كائناً أصلياً موجوداً أو دالة `fetch` محقونة. بهذه الطريقة تصبح الاختبارات حتمية، ويظل واضحاً عند الإيقاف من يملك كل اتصال أو مستمع ومن تقع عليه مسؤولية إغلاقه.
