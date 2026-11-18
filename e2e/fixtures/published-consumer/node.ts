import * as brokerRabbitmq from "@go-like/rabbitmq/broker"
import * as bullmq from "@go-like/bullmq/job"
import * as cacheRedis from "@go-like/redis/cache"
import * as configNode from "@go-like/core/config/node"
import * as coreNode from "@go-like/core/node"
import * as natsBroker from "@go-like/nats/broker"
import * as natsJetstream from "@go-like/nats/jetstream"
import * as otel from "@go-like/otel"
import * as pino from "@go-like/pino/log"
import * as prometheus from "@go-like/prometheus/metric"
import * as registryMdnsNode from "@go-like/mdns/registry/node"
import * as registryZookeeper from "@go-like/zookeeper/registry"
import * as registryZookeeperNode from "@go-like/zookeeper/registry/node"
import * as storeFileNode from "@go-like/file/store/node"
import * as transportGrpcNative from "@go-like/connectrpc/node"
import * as transportHttpNode from "@go-like/core/transport/http/node"
import * as webNode from "@go-like/core/web/node"
import * as winston from "@go-like/winston/log"

import { runPortable } from "./portable.ts"

runPortable()
if (
  [
    brokerRabbitmq,
    bullmq,
    cacheRedis,
    configNode,
    coreNode,
    natsBroker,
    natsJetstream,
    otel,
    pino,
    prometheus,
    registryMdnsNode,
    registryZookeeper,
    registryZookeeperNode,
    storeFileNode,
    transportGrpcNative,
    transportHttpNode,
    webNode,
    winston
  ].some((value) => typeof value !== "object" || value === null)
) {
  throw new Error("published Node export did not load as a module")
}
