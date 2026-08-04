import type { Broker } from "@go-like/broker"
import type { Client, ClientMiddleware } from "@go-like/client"
import type { Server } from "@go-like/core"
import type { Middleware } from "@go-like/server"
import type { Meter, Tracer } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { TracerProvider } from "@opentelemetry/sdk-trace"

import {
  measureClient,
  measureClientMiddleware,
  measureUnaryMiddleware,
  newRequestMetrics,
  otelShutdownTimeout,
  newOtelServer,
  traceBroker,
  traceClient,
  traceUnaryMiddleware,
  traceWebHandler,
  type OtelProviders,
  type OtelServer,
  type RequestMetrics
} from "../src/index"

const resource = resourceFromAttributes({ "service.name": "types" })
const tracerProvider = new TracerProvider({ resource, spanProcessors: [] })
const meterProvider = new MeterProvider({ resource, readers: [] })
const providers: OtelProviders = { tracerProvider, meterProvider }
const subject: OtelServer = newOtelServer(providers, otelShutdownTimeout(25_000))
const server: Server = subject
declare const client: Client
declare const tracer: Tracer
declare const meter: Meter
declare const broker: Broker<void, void, void, unknown>
const requestMetrics: RequestMetrics = newRequestMetrics(meter)
const measuredClientWrapper: Client = measureClient(client, requestMetrics)
const measuredClient: ClientMiddleware = measureClientMiddleware(requestMetrics)
const measuredUnary: Middleware = measureUnaryMiddleware(requestMetrics)
const tracedClient: Client = traceClient(client, tracer)
const tracedBroker: Broker<void, void, void, unknown> = traceBroker(broker, tracer)
const tracedUnary: Middleware = traceUnaryMiddleware(tracer)
declare const webHandler: (request: Request) => Response | Promise<Response>
const tracedWeb: (request: Request) => Response | Promise<Response> = traceWebHandler(
  webHandler,
  tracer
)

void tracerProvider.getTracer("types")
void meterProvider.getMeter("types")
void server
void measuredClientWrapper
void measuredClient
void measuredUnary
void tracedClient
void tracedBroker
void tracedUnary
void tracedWeb
