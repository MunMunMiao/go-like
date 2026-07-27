import { cause, type Context } from "@likego/context"
import * as fetchPackage from "@likego/web"

const actualExports = Object.keys(fetchPackage)
if (JSON.stringify(actualExports) !== JSON.stringify(["contextHandler"])) {
  throw new Error(`unexpected @likego/web exports: ${actualExports.join(",")}`)
}

const expectedResponse = new Response("portable")
const fetchHandler = fetchPackage.contextHandler(() => expectedResponse)
if (fetchHandler.length !== 1) {
  throw new Error(`unexpected Handler length: ${fetchHandler.length}`)
}

const response = await fetchHandler(new Request("https://example.test/"))
if (response !== expectedResponse) {
  throw new Error("built @likego/web response identity smoke failed")
}

const abortReason = new Error("portable abort")
const controller = new AbortController()
controller.abort(abortReason)
const observed: { context?: Context } = {}
await fetchPackage.contextHandler((ctx) => {
  observed.context = ctx
  return expectedResponse
})(new Request("https://example.test/", { signal: controller.signal }))
if (observed.context === undefined || cause(observed.context) !== abortReason) {
  throw new Error("built @likego/web Error identity smoke failed")
}
