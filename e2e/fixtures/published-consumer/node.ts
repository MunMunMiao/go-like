import * as brokerRabbitmq from "@likego/broker-rabbitmq"
import * as bullmq from "@likego/bullmq"
import * as cacheRedis from "@likego/cache-redis"
import * as configNode from "@likego/config/node"
import * as coreNode from "@likego/core/node"
import * as elysia from "@likego/elysia"
import * as h3 from "@likego/h3"
import * as hono from "@likego/hono"
import * as nats from "@likego/nats"
import * as natsBroker from "@likego/nats/broker"
import * as natsJetstream from "@likego/nats/jetstream"
import * as natsJetstreamBroker from "@likego/nats/jetstream/broker"
import * as otel from "@likego/otel"
import * as pino from "@likego/pino"
import * as prometheus from "@likego/prometheus"
import * as registryMdnsNode from "@likego/registry-mdns/node"
import * as registryZookeeper from "@likego/registry-zookeeper"
import * as storeFileNode from "@likego/store-file/node"
import * as transportHttpNode from "@likego/transport-http/node"
import * as webNode from "@likego/web/node"
import * as winston from "@likego/winston"

import { runPortable } from "./portable.ts"

runPortable()
if (
  [
    brokerRabbitmq,
    bullmq,
    cacheRedis,
    configNode,
    coreNode,
    elysia,
    h3,
    hono,
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
