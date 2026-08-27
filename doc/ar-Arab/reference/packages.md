# الحزم

يحافظ go-like على أسماء حزم عامة مسطّحة، حتى عندما تُجمع مجلدات المصدر بحسب مجال القدرة. تضم المجموعة الأساسية `@go-like/context` و`@go-like/core` و`@go-like/client` و`@go-like/server` و`@go-like/transport` و`@go-like/metadata` و`@go-like/web` و`@go-like/config` و`@go-like/registry` و`@go-like/cache` و`@go-like/store` و`@go-like/broker` و`@go-like/event` و`@go-like/health` و`@go-like/resilience`.

يمكن للاتصالات داخل العملية والاختبارات استخدام `@go-like/transport-memory`. يستخدم HTTP الداخلي `@go-like/transport-http`؛ ويوفّر المسار `@go-like/transport-http/node` تنفيذي Node للدالتين `dial` و`listen`، بما في ذلك TLS/mTLS من نوع PEM في جهة الخادم وHTTP/2 عبر ALPN. تسلّم أطر Web معالجات Fetch الأصلية مباشرة إلى `@go-like/web`، ولا تنشر go-like حزم جسر خاصة بكل إطار. وتشمل محوّلات دورة حياة بيئات التشغيل والمكتبات `@go-like/croner` و`@go-like/bullmq` و`@go-like/nats` و`@go-like/pino` و`@go-like/winston`. أما محوّلات قابلية الرصد فهي `@go-like/prometheus` و`@go-like/otel`.

مزّودو الإعداد المستقلون هم `@go-like/config-consul` و`@go-like/config-etcd` و`@go-like/config-vault`، إلى جانب مسارات البيئة والملف وYAML داخل حزمة config الأساسية. ومزّودات السجل هي `@go-like/registry-mdns` و`@go-like/registry-consul` و`@go-like/registry-etcd` و`@go-like/registry-kubernetes` و`@go-like/registry-zookeeper`. أما التخزين المؤقت فله `@go-like/cache-memory` و`@go-like/cache-redis`، ومزّودات التخزين هي `@go-like/store-memory` و`@go-like/store-file` و`@go-like/store-consul` و`@go-like/store-etcd` و`@go-like/store-vault`.

مزود Kubernetes للإعداد هو `@go-like/config-kubernetes`، ومزودا Broker هما `@go-like/broker-memory` و`@go-like/broker-rabbitmq`.

استورد أصغر حزمة تملك العقد الذي تحتاج إليه. توجد مضيفات بيئة التشغيل، مثل listeners الخاصة بـ Node، في مسارات runtime واضحة. لا يستخدم أي اسم حزمة مجلداً عاماً باسم `adapters`، وتبدأ أسماء headers العامة بالبادئة `Go-Like-`.
