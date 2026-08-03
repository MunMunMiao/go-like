# الحزم

يحافظ LikeGo على أسماء حزم عامة مسطّحة، حتى عندما تُجمع مجلدات المصدر بحسب مجال القدرة. تضم المجموعة الأساسية `@likego/context` و`@likego/core` و`@likego/client` و`@likego/server` و`@likego/transport` و`@likego/metadata` و`@likego/web` و`@likego/config` و`@likego/registry` و`@likego/cache` و`@likego/store` و`@likego/broker` و`@likego/event` و`@likego/health` و`@likego/resilience`.

يمكن للاتصالات داخل العملية والاختبارات استخدام `@likego/transport-memory`. يستخدم HTTP الداخلي `@likego/transport-http`؛ ويوفّر المسار `@likego/transport-http/node` تنفيذي Node للدالتين `dial` و`listen`، بما في ذلك TLS/mTLS من نوع PEM في جهة الخادم وHTTP/2 عبر ALPN. تسلّم أطر Web معالجات Fetch الأصلية مباشرة إلى `@likego/web`، ولا تنشر LikeGo حزم جسر خاصة بكل إطار. وتشمل محوّلات دورة حياة بيئات التشغيل والمكتبات `@likego/croner` و`@likego/bullmq` و`@likego/nats` و`@likego/pino` و`@likego/winston`. أما محوّلات قابلية الرصد فهي `@likego/prometheus` و`@likego/otel`.

مزّودو الإعداد المستقلون هم `@likego/config-consul` و`@likego/config-etcd` و`@likego/config-vault`، إلى جانب مسارات البيئة والملف وYAML داخل حزمة config الأساسية. ومزّودات السجل هي `@likego/registry-mdns` و`@likego/registry-consul` و`@likego/registry-etcd` و`@likego/registry-kubernetes` و`@likego/registry-zookeeper`. أما التخزين المؤقت فله `@likego/cache-memory` و`@likego/cache-redis`، ومزّودات التخزين هي `@likego/store-memory` و`@likego/store-file` و`@likego/store-consul` و`@likego/store-etcd` و`@likego/store-vault`.

مزود Kubernetes للإعداد هو `@likego/config-kubernetes`، ومزودا Broker هما `@likego/broker-memory` و`@likego/broker-rabbitmq`.

استورد أصغر حزمة تملك العقد الذي تحتاج إليه. توجد مضيفات بيئة التشغيل، مثل listeners الخاصة بـ Node، في مسارات runtime واضحة. لا يستخدم أي اسم حزمة مجلداً عاماً باسم `adapters`، وتبدأ أسماء headers العامة بالبادئة `Likego-`.
