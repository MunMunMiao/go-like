# التحقق

يستخدم go-like عدة evidence lanes، ولا ينبغي اختزال كل النتائج في نوعين فقط من الاختبارات. يشغّل `bun run test:unit` اختبارات وحدة حتمية لا تحتاج إلى خدمات خارجية. ويبني `bun run test:e2e` الحزم ثم يتحقق محلياً من المزوّدات الحقيقية وبيئات التشغيل المتعددة والأمثلة القابلة للتنفيذ واستهلاك حزم tarball المنشورة. تشغّل مجموعات Docker خدمات حقيقية وتحذف الموارد التي تنشئها.

يجب تسجيل Format وLint وTypecheck وBuild وRuntime E2E وProvider E2E وExample E2E وPublished وSoak وDocumentation build وAudit كلٌّ على حدة. أمر التحقق الأساسي للمستودع هو `bun run verify`؛ فهو يشغّل بالترتيب `fmt:check` و`lint:check` و`typecheck` و`build` ثم `test:unit:coverage`. تشغّل مرحلة التغطية كل script تغطية للجذر وworkspaces مرة واحدة، وتفرض التحقق الإلزامي من التغطية. `examples/payments-ledger` هو الاستثناء الوحيد خارج نطاق اختبارات الوحدة: فهو يشغّل أيضاً سيناريو التكامل الحقيقي مع PostgreSQL وNATS، ولذلك يحتاج إلى Docker. توجد lanes الأدلة الكاملة وbaseline التاريخي وrun record الوثائق في [صفحة Verification الإنجليزية canonical](/reference/verification).

```sh
bun run verify
bun run test:parallel
bun run test:stability
bun run test:e2e
bun run test:e2e:soak
```

يشغّل `test:parallel` نطاق اختبارات الوحدة نفسه مرة واحدة باستخدام عاملَي Bun معزولين للتحقق من أمان التوازي بين الملفات. ويرتّب `test:stability` كل تشغيل عشوائياً، ويكرر كل ملف اختبار مرتين، ويطبع seed قابلاً لإعادة الإنتاج من دون استخدام retry. كلاهما فحص مستقل لا يدخل في canonical gate ولا يحل محل `verify`؛ يبحث `test:stability` عن الاعتماد على ترتيب التنفيذ والإخفاقات المتقطعة، وهذا يختلف عن سلوك التشغيل لمدة 60 دقيقة الذي يفحصه `test:e2e:soak`.

تُستخدم أوامر المراحل الفردية فقط لتضييق نطاق الفشل، ولا يحل نجاحها محل `bun run verify`. يصلح `bun run fmt` التنسيق. ويطبّق `bun run lint` إصلاحات Oxlint الآمنة، ثم يعيد التنسيق ويفشل إذا بقي أي warning. تستخدم البوابة `fmt:check` و`lint:check` اللذين لا يعدّلان الملفات، كما يتطلب `lint:check` صفراً من warnings. لا تغني هذه الأوامر عن فحص الأنواع ولا تنفّذ سلوك runtime. تبقى اختبارات E2E وsoak مستقلة وتُشغّل محلياً عند الحاجة. الأوامر `fmt` و`lint` و`typecheck` و`build` و`audit` و`doc:build` أوامر هندسية وليست أنواعاً إضافية من الاختبارات. ويفحص `doc:build` مسارات VitePress الإنجليزية والمحلية المكوّنة، لكنه لا يثبت تخطيط المتصفح أو تكافؤ الترجمة. وجود الأمر لا يثبت نجاحه؛ يجب مراجعة حالة الخروج والسجلات للتشغيل الحالي. توجد lanes الأدلة الكاملة وbaseline التاريخي وrun record الوثائق في [صفحة Verification الإنجليزية canonical](/reference/verification).
