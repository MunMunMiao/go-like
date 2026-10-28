import { newHandler } from "@go-like/transport-grpc-buf"

import {
  registerProbeServiceHandler,
  type ProbeServiceHandler
} from "./.artifacts/gen/published/v1/probe_like.js"

const service = {
  getProbe() {
    return {}
  }
} satisfies ProbeServiceHandler

export const handler = newHandler((server) => registerProbeServiceHandler(server, service))
