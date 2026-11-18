# المزوّدات

لكل Plug في المنظومة ملف README لخياراته وملكيته الأصلية وحقول أخطائه. هذه الصفحة هي الفهرس. تعيش مداخل المفاهيم على `@go-like/core` وهي مدرجة في [الحزم](/ar-Arab/reference/packages).

ينشئ التطبيق العميل الأصلي ويمرره. تشترك Plugs التي تشارك بروتوكولاً في عميل جذر واحد. كل Socket مسار فرعي منفصل. مسارات README أدناه ملفات في هذا المستودع.

## القياس عن بعد

| Plug                  | README                          | دوال الإنشاء                                                                               |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `@go-like/otel`       | `packages/otel/README.md`       | `newOtelTracerProvider`، `newOtelMeterProvider`، `newOtelLogHandler`، `newOtelPropagator` |
| `@go-like/pino`       | `packages/pino/README.md`       | `newPinoHandler` من `@go-like/pino/log`                                                   |
| `@go-like/winston`    | `packages/winston/README.md`    | `newWinstonHandler` من `@go-like/winston/log`                                             |
| `@go-like/prometheus` | `packages/prometheus/README.md` | `newPrometheusMeterProvider`، `createPrometheusHandler` من `@go-like/prometheus/metric`   |

ثبّت الحزمة بـ `telemetry(tel)`. الدليل هو [الصحة وقابلية الرصد](/ar-Arab/guide/health-observability). يحتاج Winston إلى تنسيق يفهم `Error` قبل `format.json()`.

## السجلات والإعداد والمخازن

| Plug                  | README                          | المداخل                                  |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `@go-like/consul`     | `packages/consul/README.md`     | `.`، `./registry`، `./config`، `./store` |
| `@go-like/etcd`       | `packages/etcd/README.md`       | `.`، `./registry`، `./config`، `./store` |
| `@go-like/vault`      | `packages/vault/README.md`      | `.`، `./config`، `./store`               |
| `@go-like/kubernetes` | `packages/kubernetes/README.md` | `.`، `./registry`، `./config`            |
| `@go-like/zookeeper`  | `packages/zookeeper/README.md`  | `./registry`، `./registry/node`          |
| `@go-like/mdns`       | `packages/mdns/README.md`       | `./registry`، `./registry/node`          |
| `@go-like/yaml`       | `packages/yaml/README.md`       | `./config` (`decodeYaml`)                |
| `@go-like/file`       | `packages/file/README.md`       | `./store`، `./store/node`                |

تُصدَّر أخطاء HTTP والنقل والبروتوكول المشتركة من جذر الحزمة. تبقى نتائج المخزن وحدها على مدخل المخزن. راجع [معالجة الأخطاء](/reference/errors).

## الوسطاء وذاكرة التخزين المؤقت والمهام

| Plug                | README                        | المدخل                    |
| ------------------- | ----------------------------- | ------------------------- |
| `@go-like/nats`     | `packages/nats/README.md`     | `./broker`، `./jetstream` |
| `@go-like/rabbitmq` | `packages/rabbitmq/README.md` | `./broker`                |
| `@go-like/redis`    | `packages/redis/README.md`    | `./cache`                 |
| `@go-like/bullmq`   | `packages/bullmq/README.md`   | `./job`                   |
| `@go-like/croner`   | `packages/croner/README.md`   | `./job`                   |

الدليل هو [الوسيط والأحداث والمهام](/ar-Arab/guide/broker-events).

## RPC

| الحزمة                     | README                               | المدخل                                |
| -------------------------- | ------------------------------------ | ------------------------------------- |
| `@go-like/connectrpc`      | `packages/connectrpc/README.md`      | `.` معالج Fetch، و`./node` معيار gRPC |
| `@go-like/protoc-gen-like` | `packages/protoc-gen-like/README.md` | ثنائي المولّد. بلا Socket وقت تشغيل     |

الدليل هو [التدفق](/ar-Arab/guide/streaming).

## Core

عمليات نقل الذاكرة وذاكراتها المؤقتة ومخازنها ووسطاؤها وApp نفسه مداخل `@go-like/core`، وليست Plugs. يفهرس README الحزمة تلك المداخل الواحد والأربعين: `packages/core/README.md`.
