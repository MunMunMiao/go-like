import type { Broker } from "@go-like/broker"
import type { Client } from "@go-like/client"
import type { Middleware } from "@go-like/server"
import { Registry } from "prom-client"

import type { Handler } from "@go-like/web"
import {
  createPrometheusHandler,
  measureBroker,
  measureClient,
  measureUnaryMiddleware,
  measureWebHandler,
  newRequestMetrics,
  type PrometheusHandlerOptions,
  type RequestComponent,
  type RequestMetricLabel,
  type RequestMetrics,
  type RequestOutcome
} from "../src/index"

const registry: Registry = new Registry()
const options: PrometheusHandlerOptions = { path: "/internal/metrics" }
const handler: Handler = createPrometheusHandler(registry, options)
const metrics: RequestMetrics = newRequestMetrics(registry)
declare const client: Client
declare const broker: Broker<void, void, void, unknown>
const measuredClient: Client = measureClient(client, metrics)
const measuredBroker: Broker<void, void, void, unknown> = measureBroker(broker, metrics)
const measuredUnary: Middleware = measureUnaryMiddleware(metrics)
const measuredWeb: Handler = measureWebHandler(handler, metrics)
const component: RequestComponent = "client"
const label: RequestMetricLabel = "operation"
const outcome: RequestOutcome = "success"

void handler
void measuredClient
void measuredBroker
void measuredUnary
void measuredWeb
void component
void label
void outcome
