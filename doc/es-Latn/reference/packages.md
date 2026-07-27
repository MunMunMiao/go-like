# Paquetes

Aunque el código fuente se agrupa por capacidad, los paquetes públicos de LikeGo son planos. El núcleo incluye `@likego/context`, `@likego/core`, `@likego/client`, `@likego/server`, `@likego/transport`, `@likego/metadata`, `@likego/web`, `@likego/config`, `@likego/registry`, `@likego/cache`, `@likego/store`, `@likego/broker`, `@likego/event`, `@likego/health` y `@likego/resilience`.

Las llamadas internas en proceso y las pruebas pueden usar `@likego/transport-memory`. El HTTP interno es `@likego/transport-http`; `@likego/transport-http/node` aporta la implementación de Node para `dial` y `listen`, incluido TLS/mTLS con PEM en el servidor y HTTP/2 mediante ALPN. Los puentes Web son `@likego/hono`, `@likego/elysia` y `@likego/h3`. Las integraciones de ciclo de vida incluyen `@likego/croner`, `@likego/bullmq`, `@likego/nats`, `@likego/pino` y `@likego/winston`; para observabilidad están `@likego/prometheus` y `@likego/otel`.

Los registros mDNS, Consul, etcd, Kubernetes y ZooKeeper salen como paquetes `@likego/registry-*`. Los Store son `@likego/store-memory`, `@likego/store-file`, `@likego/store-consul`, `@likego/store-etcd` y `@likego/store-vault`. Consul, etcd y Vault también tienen proveedores de Config separados; este último se publica como `@likego/config-vault`, mientras entorno, archivo y YAML se ofrecen como subrutas de Config. Para caché están el contrato `@likego/cache` y los proveedores `@likego/cache-memory` y `@likego/cache-redis`.

Los nombres exactos de los proveedores de Registry son `@likego/registry-mdns`, `@likego/registry-consul`, `@likego/registry-etcd`, `@likego/registry-kubernetes` y `@likego/registry-zookeeper`. Los proveedores de Config que faltan en la descripción anterior son `@likego/config-consul`, `@likego/config-etcd` y `@likego/config-kubernetes`; los de Broker son `@likego/broker-memory` y `@likego/broker-rabbitmq`. El paquete CLI para crear proyectos es `@likego/create`.

Importa desde el paquete más pequeño que sea dueño del contrato. Los hosts de runtime como Node tienen entradas explícitas. No hay un cajón público llamado `adapters`; los headers propios usan siempre el prefijo `Likego-`.
