import * as brokerRabbitmq from "@likego/broker-rabbitmq"
import * as bullmq from "@likego/bullmq"
import * as cacheRedis from "@likego/cache-redis"
import * as coreNode from "@likego/core/node"
import * as nats from "@likego/nats"
import * as natsBroker from "@likego/nats/broker"
import * as natsJetstream from "@likego/nats/jetstream"
import * as natsJetstreamBroker from "@likego/nats/jetstream/broker"
import * as otel from "@likego/otel"
import * as pino from "@likego/pino"
import * as prometheus from "@likego/prometheus"
import * as registryZookeeper from "@likego/registry-zookeeper"
import * as winston from "@likego/winston"

import { runPortable } from "./portable.ts"

runPortable()
if (
  [
    brokerRabbitmq,
    bullmq,
    cacheRedis,
    coreNode,
    nats,
    natsBroker,
    natsJetstream,
    natsJetstreamBroker,
    otel,
    pino,
    prometheus,
    registryZookeeper,
    winston
  ].some((value) => typeof value !== "object" || value === null)
) {
  throw new Error("published Bun export did not load as a module")
}
