import { newBrokerServer } from "@likego/broker"
import type { Server } from "@likego/core"

import { rawTelemetrySubjects, type TelemetryBroker } from "./nats"
import { processTelemetry } from "./processor"
import { defaultTelemetryPolicy, type TelemetryPolicy } from "./telemetry"

/** Adapts one durable raw consumer into a LikeGo-owned Core Server lifecycle. */
export function newTelemetryServer(
  broker: TelemetryBroker,
  policy: TelemetryPolicy = defaultTelemetryPolicy
): Server {
  return newBrokerServer(broker, rawTelemetrySubjects, async (ctx, event) => {
    await processTelemetry(ctx, broker, event, policy)
  })
}
