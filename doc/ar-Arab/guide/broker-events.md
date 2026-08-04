# الوسيط والأحداث

يعرّف `@go-like/broker` واجهة SPI للبيانات الثنائية والموضوعات، ويأتي `Context` في أول عمليات النشر والاشتراك. يحتفظ كل تسليم برسالة المزوّد الأصلية، لأن الإقرار والرفض والإنهاء وإعادة التسليم والاستمرارية وdead-letter سلوكيات تختلف بين الوسطاء، ولا يصح تسطيحها داخل مجموعة طرق مشتركة توحي بضمانات غير حقيقية.

تمثل `@go-like/event` الطبقة النمطية الاختيارية. فهي ترمّز payload مستقلاً من البيانات الثنائية عند النشر، ولا تفك ترميزه إلا عند الحاجة في جهة الاستلام. لا يؤدي فشل فك الترميز إلى إتلاف كائن NATS أو JetStream الأصلي، ولذلك يستطيع التطبيق اتخاذ قرار تسوية الرسالة الصحيح حتى عند وجود payload غير صالح.

تعيد `Broker.subscribe(ctx, topic, handler)` كائن `Subscriber` خاصاً بالمزوّد يوفّر `unsubscribe(ctx)`. ويحوّل `newBrokerServer(...)` كائن `Broker` إلى عقد Core `Server`: تمثّل `start(ctx)` مدة التشغيل كاملة، بينما تطلب `stop(ctx)` الإيقاف. يتولى go-like إيقاف الاشتراك المقبول، لكنه لا يمتلك connection أو stream أو durable consumer. يؤدي إلغاء البدء إلى التراجع عن اشتراك أُنشئ ولم يُقبل بعد.

اختر وسيط رسائل عندما يكون التسليم وfan-out جزءاً من نموذج المجال. واستخدم BullMQ عبر `@go-like/bullmq` عندما تحتاج فعلاً إلى retry وbackoff وtoken وسلوك Worker الخاص بطابور الوظائف. لا يفعل المحوّل أكثر من ضم `Worker` الرسمي إلى دورة الحياة، ولا يدّعي أن نموذج الطابور ونموذج وسيط الأحداث شيء واحد.

> [!NOTE]
> هذه الصفحة ملخص محلي. يوجد DAG الكامل لـ RabbitMQ recovery وNATS Core/JetStream settlement وBullMQ/Croner lifecycle وterminal barrier لدى provider في [الصفحة الإنجليزية canonical](/guide/broker-events).

```text
application-owned native connection / consumer
  -> go-like accepted subscription
  -> Broker bytes/topic delivery
  -> application settlement through native provider object
  -> explicit unsubscribe / provider terminal result
```
