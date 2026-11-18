import { expect, test } from "bun:test"

import { runtimeExports } from "./support/public-api"
import * as root from "../src/index"
import * as node from "../src/node/index"
import * as lifecycle from "../src/lifecycle/index"
import * as context from "../src/context/index"
import * as metadata from "../src/metadata/index"
import * as struct from "../src/struct/index"
import * as health from "../src/health/index"
import * as resilience from "../src/resilience/index"
import * as registry from "../src/registry/index"
import * as registryProvider from "../src/registry/provider"
import * as registryMemory from "../src/registry/memory"
import * as testing from "../src/testing/index"
import * as telemetry from "../src/telemetry/index"
import * as telemetryProvider from "../src/telemetry/provider"
import * as log from "../src/log/index"
import * as trace from "../src/trace/index"
import * as metric from "../src/metric/index"
import * as transport from "../src/transport/index"
import * as transportProvider from "../src/transport/provider"
import * as transportMemory from "../src/transport/memory/index"
import * as transportHttp from "../src/transport/http/index"
import * as transportHttpNode from "../src/transport/http/node"
import * as server from "../src/server/index"
import * as client from "../src/client/index"
import * as web from "../src/web/index"
import * as webNode from "../src/web/node"
import * as webBun from "../src/web/bun"
import * as config from "../src/config/index"
import * as configProvider from "../src/config/provider"
import * as configNode from "../src/config/node"
import * as fetchClient from "../src/fetch/index"
import * as cache from "../src/cache/index"
import * as cacheMemory from "../src/cache/memory/index"
import * as store from "../src/store/index"
import * as storeProvider from "../src/store/provider"
import * as storeMemory from "../src/store/memory/index"
import * as broker from "../src/broker/index"
import * as brokerProvider from "../src/broker/provider"
import * as brokerMemory from "../src/broker/memory/index"
import * as job from "../src/job/index"
import * as jobProvider from "../src/job/provider"

const loaded = {
  ".": root,
  "./node": node,
  "./lifecycle": lifecycle,
  "./log": log,
  "./metric": metric,
  "./context": context,
  "./metadata": metadata,
  "./struct": struct,
  "./health": health,
  "./resilience": resilience,
  "./registry": registry,
  "./registry/provider": registryProvider,
  "./registry/memory": registryMemory,
  "./telemetry": telemetry,
  "./telemetry/provider": telemetryProvider,
  "./testing": testing,
  "./trace": trace,
  "./transport": transport,
  "./transport/provider": transportProvider,
  "./transport/memory": transportMemory,
  "./transport/http": transportHttp,
  "./transport/http/node": transportHttpNode,
  "./server": server,
  "./client": client,
  "./web": web,
  "./web/node": webNode,
  "./web/bun": webBun,
  "./config": config,
  "./config/provider": configProvider,
  "./config/node": configNode,
  "./fetch": fetchClient,
  "./cache": cache,
  "./cache/memory": cacheMemory,
  "./store": store,
  "./store/provider": storeProvider,
  "./store/memory": storeMemory,
  "./broker": broker,
  "./broker/provider": brokerProvider,
  "./broker/memory": brokerMemory,
  "./job": job,
  "./job/provider": jobProvider
}

test("package exports match the runtime export table", async () => {
  const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    readonly exports: Record<string, string>
  }
  expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(runtimeExports).sort())
})

test("runtime exports match the table", () => {
  for (const [key, names] of Object.entries(runtimeExports)) {
    const mod = loaded[key as keyof typeof loaded]
    expect(Object.keys(mod).sort()).toEqual([...names])
  }
})

test("startTimeout accepts only the public timer range", () => {
  for (const value of [-1, 1.5, Number.NaN, 2_147_483_648]) {
    expect(() => root.startTimeout(value)).toThrow(RangeError)
  }
  expect(() => root.startTimeout(0)).not.toThrow()
  expect(() => root.startTimeout(2_147_483_647)).not.toThrow()
})

test("removed lifecycle concepts have no runtime compatibility facade", () => {
  for (const value of ["endpoints", "hardDrainTimeout", "newNodeRuntimeHost", "run"]) {
    expect(root).not.toHaveProperty(value)
    expect(node).not.toHaveProperty(value)
  }
})
