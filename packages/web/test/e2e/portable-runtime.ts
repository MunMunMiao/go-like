import { cause, type Context } from "@likego/context"
import { newProbeRegistry } from "@likego/health"
import * as web from "@likego/web"
import { createHealthHandler } from "@likego/web/health"

const runtime = "Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node"
const runtimeExports = Object.keys(web)
if (JSON.stringify(runtimeExports) !== JSON.stringify(["contextHandler"])) {
  throw new Error(`unexpected @likego/web exports: ${runtimeExports.join(",")}`)
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
registry.register("ready", "likego.web", () => {})
const health = await createHealthHandler(registry)(new Request("https://service.test/readyz"))
if (
  health.status !== 200 ||
  (await health.text()) !== '{"status":"ok","checks":[{"name":"likego.web","status":"ok"}]}'
) {
  throw new Error(`${runtime} Web health handler runtime failed`)
}

console.log(JSON.stringify({ runtime, status: health.status }))
