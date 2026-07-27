import * as module0 from "@likego/broker"
import * as module1 from "@likego/broker/provider"
import * as module2 from "@likego/broker-memory"
import * as module3 from "@likego/broker-rabbitmq"
import * as module4 from "@likego/bullmq"
import * as module5 from "@likego/cache"
import * as module6 from "@likego/cache/provider"
import * as module7 from "@likego/cache-memory"
import * as module8 from "@likego/cache-redis"
import * as module9 from "@likego/client"
import * as module10 from "@likego/config"
import * as module11 from "@likego/config/env"
import * as module12 from "@likego/config/file"
import * as module13 from "@likego/config/yaml"
import * as module14 from "@likego/config-consul"
import * as module15 from "@likego/config-etcd"
import * as module16 from "@likego/config-kubernetes"
import * as module17 from "@likego/config-vault"
import * as module18 from "@likego/context"
import * as module19 from "@likego/core"
import * as module20 from "@likego/core/lifecycle"
import * as module21 from "@likego/core/node"
import * as module22 from "@likego/croner"
import * as module23 from "@likego/event"
import * as module24 from "@likego/health"
import * as module25 from "@likego/metadata"
import * as module26 from "@likego/nats"
import * as module27 from "@likego/nats/broker"
import * as module28 from "@likego/nats/jetstream"
import * as module29 from "@likego/nats/jetstream/broker"
import * as module30 from "@likego/otel"
import * as module31 from "@likego/pino"
import * as module32 from "@likego/prometheus"
import * as module33 from "@likego/registry"
import * as module34 from "@likego/registry/provider"
import * as module35 from "@likego/registry-consul"
import * as module36 from "@likego/registry-etcd"
import * as module37 from "@likego/registry-kubernetes"
import * as module38 from "@likego/registry-mdns"
import * as module39 from "@likego/registry-zookeeper"
import * as module40 from "@likego/resilience"
import * as module41 from "@likego/server"
import * as module42 from "@likego/store"
import * as module43 from "@likego/store/provider"
import * as module44 from "@likego/store-consul"
import * as module45 from "@likego/store-etcd"
import * as module46 from "@likego/store-file"
import * as module47 from "@likego/store-memory"
import * as module48 from "@likego/store-vault"
import * as module49 from "@likego/transport"
import * as module50 from "@likego/transport/headers"
import * as module51 from "@likego/transport/json"
import * as module52 from "@likego/transport/provider"
import * as module53 from "@likego/transport-http"
import * as module54 from "@likego/transport-memory"
import * as module55 from "@likego/web"
import * as module56 from "@likego/web/health"
import * as module57 from "@likego/winston"

const modules = [
  module0,
  module1,
  module2,
  module3,
  module4,
  module5,
  module6,
  module7,
  module8,
  module9,
  module10,
  module11,
  module12,
  module13,
  module14,
  module15,
  module16,
  module17,
  module18,
  module19,
  module20,
  module21,
  module22,
  module23,
  module24,
  module25,
  module26,
  module27,
  module28,
  module29,
  module30,
  module31,
  module32,
  module33,
  module34,
  module35,
  module36,
  module37,
  module38,
  module39,
  module40,
  module41,
  module42,
  module43,
  module44,
  module45,
  module46,
  module47,
  module48,
  module49,
  module50,
  module51,
  module52,
  module53,
  module54,
  module55,
  module56,
  module57
]
if (modules.some((value) => typeof value !== "object" || value === null)) {
  throw new Error("published export did not load as a module")
}
console.log("LikeGo published bun consumer passed")
