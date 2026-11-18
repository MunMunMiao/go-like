import * as brokerRabbitmq from "@go-like/rabbitmq/broker"
import * as bullmq from "@go-like/bullmq/job"
import * as cacheRedis from "@go-like/redis/cache"
import * as coreNode from "@go-like/core/node"
import * as natsBroker from "@go-like/nats/broker"
import * as natsJetstream from "@go-like/nats/jetstream"
import * as otel from "@go-like/otel"
import * as pino from "@go-like/pino/log"
import * as prometheus from "@go-like/prometheus/metric"
import "@go-like/protoc-gen-like"
import * as registryZookeeper from "@go-like/zookeeper/registry"
import * as webBun from "@go-like/core/web/bun"
import * as winston from "@go-like/winston/log"

import { runPortable } from "./portable.ts"

runPortable()
if (
  [
    brokerRabbitmq,
    bullmq,
    cacheRedis,
    coreNode,
    natsBroker,
    natsJetstream,
    otel,
    pino,
    prometheus,
    registryZookeeper,
    winston,
    webBun
  ].some((value) => typeof value !== "object" || value === null)
) {
  throw new Error("published Bun export did not load as a module")
}
