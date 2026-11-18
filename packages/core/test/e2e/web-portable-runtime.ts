import { cause, type Context } from "../../src/context"
import { newProbeRegistry } from "../../src/health"
import * as web from "../../src/web"
import { createHealthHandler } from "../../src/web/health"
import { runtimeExports } from "../support/public-api"

const runtime = "Bun" in globalThis ? "bun" : "node"
const actualExports = Object.keys(web).sort()
if (JSON.stringify(actualExports) !== JSON.stringify(runtimeExports["./web"])) {
  throw new Error(`unexpected @go-like/core/web exports: ${actualExports.join(",")}`)
}

const expectedResponse = new Response("portable")
const handler = web.contextHandler(() => expectedResponse)
const response = await handler(new Request("https://service.test/"))
if (handler.length !== 1 || response !== expectedResponse) {
  throw new Error(`${runtime} Web Handler identity runtime failed`)
}

const abortReason = new Error("portable abort")
const controller = new AbortController()
controller.abort(abortReason)
const observed: { context?: Context } = {}
await web.contextHandler((ctx) => {
  observed.context = ctx
  return expectedResponse
})(new Request("https://service.test/", { signal: controller.signal }))
if (observed.context === undefined || cause(observed.context) !== abortReason) {
  throw new Error(`${runtime} request Context cause identity runtime failed`)
}

const registry = newProbeRegistry()
registry.register("ready", "go-like.web", () => {})
const health = await createHealthHandler(registry)(new Request("https://service.test/readyz"))
if (
  health.status !== 200 ||
  (await health.text()) !== '{"status":"ok","checks":[{"name":"go-like.web","status":"ok"}]}'
) {
  throw new Error(`${runtime} Web health handler runtime failed`)
}

console.log(JSON.stringify({ runtime, status: health.status }))
