import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

interface PromClientModule {
  readonly Counter: new (options: {
    readonly name: string
    readonly help: string
    readonly registers: readonly unknown[]
  }) => { inc(): void }
  readonly Registry: new () => {
    clear(): void
    getMetricsAsJSON(): Promise<readonly unknown[]>
  }
}

interface PackageJson {
  readonly version: string
}

interface PrometheusModule {
  createPrometheusHandler(registry: unknown): (request: Request) => Promise<Response>
}

const require = createRequire(resolve(process.cwd(), "package.json"))
const promClient = require("prom-client") as PromClientModule
const packageJson = require("prom-client/package.json") as PackageJson
if (packageJson.version !== "15.1.3") {
  throw new Error(`unexpected prom-client version ${packageJson.version}`)
}
const prometheus = (await import(
  pathToFileURL(resolve(process.cwd(), "dist/index.js")).href
)) as PrometheusModule

const registry = new promClient.Registry()
const counter = new promClient.Counter({
  name: "likego_e2e_total",
  help: "LikeGo sourced E2E counter.",
  registers: [registry]
})
counter.inc()
const response = await prometheus.createPrometheusHandler(registry)(
  new Request("https://service.test/metrics")
)
const body = await response.text()
const sampleMatch = /^likego_e2e_total\s+([0-9]+(?:\.[0-9]+)?)$/m.exec(body)
const sampleValue = sampleMatch?.[1] === undefined ? Number.NaN : Number(sampleMatch[1])
if (response.status !== 200 || sampleValue !== 1) {
  throw new Error("Prometheus Handler scrape did not expose the incremented sample")
}
registry.clear()
const registryCleared = (await registry.getMetricsAsJSON()).length === 0
if (!registryCleared)
  throw new Error("Prometheus Registry remained populated after explicit cleanup")

process.stdout.write(
  `LIKEGO_PROMETHEUS_E2E_RESULT=${JSON.stringify({
    valid: true,
    runtime: `Node.js ${process.versions.node}`,
    promClientVersion: packageJson.version,
    services: ["prom-client 15.1.3", "standard Web Handler"],
    scenarios: ["prometheus-registry-handler-scrape"],
    scrape: {
      status: response.status,
      samplePresent: sampleValue === 1,
      sampleValue,
      contentType: response.headers.get("Content-Type")
    },
    cleanup: {
      registryCleared
    }
  })}\n`
)
