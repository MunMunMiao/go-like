import * as brokerRabbitmq from "@go-like/broker-rabbitmq"
import * as bullmq from "@go-like/bullmq"
import * as cacheRedis from "@go-like/cache-redis"
import * as configNode from "@go-like/config/node"
import * as coreNode from "@go-like/core/node"
import * as nats from "@go-like/nats"
import * as natsBroker from "@go-like/nats/broker"
import * as natsJetstream from "@go-like/nats/jetstream"
import * as natsJetstreamBroker from "@go-like/nats/jetstream/broker"
import * as otel from "@go-like/otel"
import * as pino from "@go-like/pino"
import * as prometheus from "@go-like/prometheus"
import * as registryMdnsNode from "@go-like/registry-mdns/node"
import * as registryZookeeper from "@go-like/registry-zookeeper"
import * as storeFileNode from "@go-like/store-file/node"
import * as transportHttpNode from "@go-like/transport-http/node"
import * as webNode from "@go-like/web/node"
import * as winston from "@go-like/winston"

import { runPortable } from "./portable.ts"

runPortable()
if (
  [
    brokerRabbitmq,
    bullmq,
    cacheRedis,
    configNode,
    coreNode,
    nats,
    natsBroker,
    natsJetstream,
    natsJetstreamBroker,
    otel,
    pino,
    prometheus,
    registryMdnsNode,
    registryZookeeper,
    storeFileNode,
    transportHttpNode,
    webNode,
    winston
  ].some((value) => typeof value !== "object" || value === null)
) {
  throw new Error("published Node export did not load as a module")
}
