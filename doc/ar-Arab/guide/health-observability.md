# الصحة وقابلية الرصد

يفصل `@go-like/health` بين liveness وreadiness. يكون سجل liveness الفارغ سليماً لأن العملية نفسها تعمل، بينما يفشل سجل readiness الفارغ بحالة مغلقة: لا ينبغي توجيه الحركة إلى الخدمة قبل تسجيل فحص جاهزية واحد على الأقل ونجاح جميع الفحوص المسجلة. ويمكن لمعالج `@go-like/web/health` الاختياري عرض هذه النتائج في استجابات Web قياسية. مسارا الطلب الافتراضيان هما `GET /livez` و`GET /readyz`: تعيد الحالة السليمة `200`، والفاشلة `503`، والطريقة غير المدعومة `405`، والمسار المجهول `404`. يعيد liveness الفارغ `200`، بينما يعيد readiness الفارغ `503`؛ ويجب أن يركّب التطبيق Handler في router/host الخاص به.

```ts
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"

const probes = newProbeRegistry()
const health = createHealthHandler(probes)
// اربط /livez و/readyz بجدول المسارات الخاص بالتطبيق.
```

استخدم `curl -i http://127.0.0.1:3000/livez` بعد تركيب هذا Handler على listener فعلي فقط.

المقاييس والتتبّع صريحان أيضاً. تعرض `@go-like/prometheus` سجل `prom-client` يملكه التطبيق ولا تلمس السجل العام. وتقبل `@go-like/otel` مزوّدات OpenTelemetry يملكها التطبيق لربطها بدورة الحياة، كما توفر أغلفة واضحة لعميل go-like وunary middleware والوسيط. لا تثبّت الحزمة مزوّدات عامة أو exporters أو context managers أو automatic instrumentation.

تتبع محوّلات التدوين القاعدة نفسها. تقبل `@go-like/pino` و`@go-like/winston` الوجهات أو loggers الأصلية، ولا تديران سوى حد الإيقاف. تبقى المستويات وسياسة redaction والتنسيقات وtransports وchild loggers وسياسة الحقول ضمن شيفرة التطبيق.

اضبط عدد القيم الممكنة للوسوم، ولا تضع بيانات اعتماد داخل attributes، وثبّت context manager تدعمه بيئة التشغيل قبل توقع انتقال علاقة الأبوة في trace عبر العمل غير المتزامن. وإذا فشل تصدير telemetry، فيجب أن تسجل دورة الحياة هذا الفشل بدلاً من إعلان إيقاف نظيف على نحو مضلل.
