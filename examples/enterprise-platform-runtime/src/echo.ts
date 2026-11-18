import type { Config } from "@go-like/core/config"
import type { Context } from "@go-like/core/context"
import { newCounter } from "@go-like/core/metric"
import { serviceError, type ServiceHandler } from "@go-like/core/transport"

import type { RuntimeConfig } from "./config"
import { echoService } from "./contract"

export { echoService } from "./contract"

/** Discovery and route name of the internal echo service. */
export const echoServiceName = echoService.name

/** Route token of the internal echo operation. */
export const echoEndpointName = echoService.endpoints.ping.endpoint

const calls = newCounter("enterprise.calls", {
  description: "Enterprise unary requests by bounded result.",
  attributeKeys: ["result"]
})

/** Creates the business handler without taking transport or lifecycle ownership. */
export function newEchoHandler(
  config: Config<RuntimeConfig>,
  onCall: () => void = () => {}
): ServiceHandler<typeof echoService> {
  if (typeof onCall !== "function") throw new TypeError("onCall must be a function")

  return Object.freeze({
    ping(ctx: Context): string {
      const release = config.value("release").load()
      if (typeof release !== "number") {
        throw serviceError("unavailable", "runtime configuration is not ready", 503)
      }
      calls.add(ctx, 1, { result: "ok" })
      onCall()
      return `pong:${release}`
    }
  })
}
