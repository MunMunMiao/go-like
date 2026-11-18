import { newHandler } from "@go-like/connectrpc"

import {
  registerProbeServiceHandler,
  type ProbeServiceHandler
} from "./.artifacts/gen/published/v1/probe_like.js"

import { runPublishedSmoke } from "./smoke.ts"

await runPublishedSmoke()

const service = {
  getProbe() {
    return {}
  }
} satisfies ProbeServiceHandler

export const handler = newHandler((server) => registerProbeServiceHandler(server, service))
