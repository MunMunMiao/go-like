# التدفق

لـ go-like ثلاثة حدود تدفق.

1. **تدفق Web العام** يستخدم جسمي `Request` و`Response` في Fetch وواجهة Web Streams.
2. **استدعاءات الخدمات الداخلية** تستخدم طلب Fetch واحداً واستجابة Fetch واحدة. يحمل الاستدعاء الأحادي جسم JSON واحداً. يضبط تدفق الخادم `stream: true` ويعيد `text/event-stream`. لا يوجد SPI لتدفق طلبات العميل أو للتدفق ثنائي الاتجاه على هذا المسار.
3. **RPC المولّد من Protobuf** يستخدم `@go-like/connectrpc` لـ Connect وgRPC-Web على Fetch، و`@go-like/connectrpc/node` لمعيار gRPC المُدار. يغطي Fetch القابل للنقل الأحادي وتدفق استجابات الخادم. ويغطي مدخل Node الأحادي وتدفق استجابات الخادم وتدفق طلبات العميل والتدفق ثنائي الاتجاه. يولّد `@go-like/protoc-gen-like` غراء العميل والمعالج الذي يضع Context أولاً.

`ReadableStream` أو استجابة SSE من الإطار أو ترقية WebSocket هي تدفق Web. تدفق الخادم الداخلي هو SSE على `POST /<service>/<endpoint>` مع `accept: text/event-stream`.

سُجّل تصريف gRPC المُدار مع مستهلك بطيء على Node 26.12.1 وBun 1.4.4 في [مصفوفة تصريف gRPC الأصلي](/reference/claims#native-grpc-drain-status). وتبقى ملاحظات إلغاء Fetch السابقة في Connect 2.1.2 وBun 1.4.2 في [سجل الادعاءات](/reference/claims#stream-cancellation-limits). ولا يضيف RPC المولّد إعادة تشغيل للتدفق.

## تدفق Web العام

```ts
import { contextHandler, type Handler } from "@go-like/core/web"

export const streamHandler: Handler = contextHandler(async () => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("first\n"))
      controller.enqueue(encoder.encode("second\n"))
      controller.close()
    }
  })
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" }
  })
})
```

يملك التطبيق أو الإطار تنسيق التدفق، والتفريغ، وأعراف SSE، وترقية WebSocket، وسياسة قطع الاتصال. ينهي `contextHandler` سياق Context عندما يعيد Handler الكائن `Response`. ينبغي لجسم طويل العمر أن يراقب أيضاً `request.signal`. يعيش Context الخاص بـ RPC الداخلي حتى ينتهي جسم الاستجابة.

تحتفظ Hono وElysia وH3 بواجهات التدفق وWebSocket الخاصة بها. مرّر `app.fetch` إلى `@go-like/core/web/node` أو `@go-like/core/web/bun` عندما تريد دورة حياة App.

## تدفقات الخادم الداخلية

أعلن `stream: true`. المعالج مولّد غير متزامن. يقرأ العميل `ServerStream` بـ `for await`. وتُجهض `close()` و`await using` و`break` وإلغاء المستدعي الطلب.

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const orders = defineService("orders", {
  watch: {
    request: struct.object({ after: struct.string() }),
    response: struct.object({ id: struct.string() }),
    stream: true
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://orders"))
orders.registerHandler(rpc, {
  async *watch(_ctx, request) {
    yield { id: request.after }
  }
})

const api = orders.newClient(newClient(withTransport(transport), withEndpoint("memory://orders")))
const stream = await api.watch(background(), { after: "0" })
for await (const event of stream) {
  console.log(event.id)
  break
}
await stream.close()
```

يحدّ `streamKeepAlive` و`maxSendMessageBytes` على `@go-like/core/server` فاصل تعليق SSE وحجم الإطار. وهما لا يغيّران عدد الأنماط. يبقى هناك جسم طلب واحد وسلسلة من أحداث الاستجابة.

## RPC المولّد

يصدّر `@go-like/connectrpc` الدوال `newHandler` و`callOptions` و`fromHandlerContext`. المعالج هو Fetch `Handler` لـ Connect وgRPC-Web. ركّبه على مضيف Web من core بالطريقة نفسها التي تركّب بها أي معالج آخر.

يصدّر `@go-like/connectrpc/node` الدالتين `newServer` و`newClient` وخيارات العنوان والإعلان وTLS. ذلك الخادم هو `Server` في دورة الحياة و`Endpointer` لطبقة الخوادم. يستهلك عميل Node كلاً من `Discovery` و`Selector` عندما تمررهما. معيار gRPC على هذا المدخل هو المسار الذي يغطي تدفق طلبات العميل والتدفق ثنائي الاتجاه.

`@go-like/protoc-gen-like` هو إضافة Buf. تستورد الشيفرة المولّدة `@go-like/core/context` و`@go-like/connectrpc`. وليس للمولّد Socket وقت تشغيل.

يبقى gRPC القياسي في المتصفح، وصحة gRPC الرسمية وانعكاسها، وضمان بيئة تشغيل مستقبلية خارج هذه المصفوفة. التصريف المُدار المختبَر هو [سجل الادعاءات](/reference/claims#native-grpc-drain-status).
