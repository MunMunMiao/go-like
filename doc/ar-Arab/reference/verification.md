# التحقق

يستخدم go-like عدة evidence lanes، ولا ينبغي اختزال كل النتائج في نوعين فقط من الاختبارات. يشغّل `bun run test:unit` اختبارات وحدة حتمية لا تحتاج إلى خدمات خارجية. ويبني `bun run test:e2e` الحزم ثم يتحقق محلياً من المزوّدات الحقيقية وبيئات التشغيل المتعددة والأمثلة القابلة للتنفيذ واستهلاك حزم tarball المنشورة. تشغّل مجموعات Docker خدمات حقيقية وتحذف الموارد التي تنشئها.

يجب تسجيل Format وLint وTypecheck وBuild وRuntime E2E وProvider E2E وExample E2E وPublished وSoak وDocumentation build وAudit كلٌّ على حدة. ينشئ `test:unit:coverage` تقريراً اختيارياً فقط؛ توجد lanes الأدلة الكاملة وbaseline التاريخي وrun record الوثائق في [صفحة Verification الإنجليزية canonical](/reference/verification).

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

ينشئ ينشئ `test:unit:coverage` تقريراً اختيارياً فقط. يفحص `bun run lint` قواعد Oxlint الساكنة، ولا يثبت صحة الأنواع أو سلوك وقت التشغيل. الأوامر `fmt` و`lint` و`typecheck` و`build` و`audit` و`doc:build` أوامر هندسية وليست أنواعاً إضافية من الاختبارات. ويفحص `doc:build` مسارات VitePress الإنجليزية والمحلية المكوّنة، لكنه لا يثبت تخطيط المتصفح أو تكافؤ الترجمة. وجود الأمر لا يثبت نجاحه؛ يجب مراجعة حالة الخروج والسجلات للتشغيل الحالي. توجد lanes الأدلة الكاملة وbaseline التاريخي وrun record الوثائق في [صفحة Verification الإنجليزية canonical](/reference/verification).
