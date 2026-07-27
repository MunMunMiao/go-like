# Пакеты

Исходники могут быть сгруппированы по возможностям, но публичные пакеты LikeGo остаются плоскими. Ядро: `@likego/context`, `@likego/core`, `@likego/client`, `@likego/server`, `@likego/transport`, `@likego/metadata`, `@likego/web`, `@likego/config`, `@likego/registry`, `@likego/cache`, `@likego/store`, `@likego/broker`, `@likego/event`, `@likego/health` и `@likego/resilience`.

Для внутрипроцессных вызовов и тестов можно использовать `@likego/transport-memory`. Внутренний HTTP реализует `@likego/transport-http`; подпуть `@likego/transport-http/node` предоставляет реализации Node для `dial` и `listen`, включая серверные PEM TLS/mTLS и HTTP/2 с согласованием ALPN. Web-мосты — `@likego/hono`, `@likego/elysia`, `@likego/h3`. Адаптеры жизненного цикла включают `@likego/croner`, `@likego/bullmq`, `@likego/nats`, `@likego/pino`, `@likego/winston`, а наблюдаемость — `@likego/prometheus` и `@likego/otel`.

Реестры mDNS, Consul, etcd, Kubernetes и ZooKeeper выходят отдельными пакетами `@likego/registry-*`. Store-провайдеры: `@likego/store-memory`, `@likego/store-file`, `@likego/store-consul`, `@likego/store-etcd` и `@likego/store-vault`. Для Config есть отдельные Consul, etcd и Vault пакеты, включая `@likego/config-vault`, а environment, file и YAML доступны как subpaths. Для кеша используются контракт `@likego/cache` и провайдеры `@likego/cache-memory` и `@likego/cache-redis`.

Точные имена Registry-провайдеров: `@likego/registry-mdns`, `@likego/registry-consul`, `@likego/registry-etcd`, `@likego/registry-kubernetes` и `@likego/registry-zookeeper`. Дополнительные Config-провайдеры — `@likego/config-consul`, `@likego/config-etcd` и `@likego/config-kubernetes`; Broker-провайдеры — `@likego/broker-memory` и `@likego/broker-rabbitmq`.

Импортируйте из самого маленького пакета, которому принадлежит контракт. Runtime hosts вроде Node имеют отдельные точки входа. Публичной свалки `adapters` нет, а собственные HTTP headers всегда имеют префикс `Likego-`.
