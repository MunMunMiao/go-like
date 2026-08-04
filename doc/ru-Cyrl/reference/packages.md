# Пакеты

Исходники могут быть сгруппированы по возможностям, но публичные пакеты go-like остаются плоскими. Ядро: `@go-like/context`, `@go-like/core`, `@go-like/client`, `@go-like/server`, `@go-like/transport`, `@go-like/metadata`, `@go-like/web`, `@go-like/config`, `@go-like/registry`, `@go-like/cache`, `@go-like/store`, `@go-like/broker`, `@go-like/event`, `@go-like/health` и `@go-like/resilience`.

Для внутрипроцессных вызовов и тестов можно использовать `@go-like/transport-memory`. Внутренний HTTP реализует `@go-like/transport-http`; подпуть `@go-like/transport-http/node` предоставляет реализации Node для `dial` и `listen`, включая серверные PEM TLS/mTLS и HTTP/2 с согласованием ALPN. Web-фреймворки передают свои нативные Fetch-обработчики напрямую в `@go-like/web`; go-like не публикует отдельные пакеты-мосты для фреймворков. Адаптеры жизненного цикла включают `@go-like/croner`, `@go-like/bullmq`, `@go-like/nats`, `@go-like/pino`, `@go-like/winston`, а наблюдаемость — `@go-like/prometheus` и `@go-like/otel`.

Реестры mDNS, Consul, etcd, Kubernetes и ZooKeeper выходят отдельными пакетами `@go-like/registry-*`. Store-провайдеры: `@go-like/store-memory`, `@go-like/store-file`, `@go-like/store-consul`, `@go-like/store-etcd` и `@go-like/store-vault`. Для Config есть отдельные Consul, etcd и Vault пакеты, включая `@go-like/config-vault`, а environment, file и YAML доступны как subpaths. Для кеша используются контракт `@go-like/cache` и провайдеры `@go-like/cache-memory` и `@go-like/cache-redis`.

Точные имена Registry-провайдеров: `@go-like/registry-mdns`, `@go-like/registry-consul`, `@go-like/registry-etcd`, `@go-like/registry-kubernetes` и `@go-like/registry-zookeeper`. Дополнительные Config-провайдеры — `@go-like/config-consul`, `@go-like/config-etcd` и `@go-like/config-kubernetes`; Broker-провайдеры — `@go-like/broker-memory` и `@go-like/broker-rabbitmq`.

Импортируйте из самого маленького пакета, которому принадлежит контракт. Runtime hosts вроде Node имеют отдельные точки входа. Публичной свалки `adapters` нет, а собственные HTTP headers всегда имеют префикс `Go-Like-`.
