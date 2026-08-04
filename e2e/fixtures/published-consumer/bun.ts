import * as brokerRabbitmq from "@go-like/broker-rabbitmq"
import * as bullmq from "@go-like/bullmq"
import * as cacheRedis from "@go-like/cache-redis"
import * as coreNode from "@go-like/core/node"
import * as nats from "@go-like/nats"
import * as natsBroker from "@go-like/nats/broker"
import * as natsJetstream from "@go-like/nats/jetstream"
import * as natsJetstreamBroker from "@go-like/nats/jetstream/broker"
import * as otel from "@go-like/otel"
import * as pino from "@go-like/pino"
import * as prometheus from "@go-like/prometheus"
import * as registryZookeeper from "@go-like/registry-zookeeper"
import * as winston from "@go-like/winston"

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
