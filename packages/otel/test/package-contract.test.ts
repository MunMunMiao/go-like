import { expect, test } from "bun:test"

test("manifests pin official OpenTelemetry packages and declare native provider transfer", async () => {
  const packageManifest = await Bun.file(`${import.meta.dir}/../package.json`).json()
  const capability = await Bun.file(`${import.meta.dir}/../capability.json`).json()
  const owner = await Bun.file(`${import.meta.dir}/../owner.json`).json()
  const readme = await Bun.file(`${import.meta.dir}/../README.md`).text()

  expect(packageManifest.dependencies).toMatchObject({
    "@likego/broker": "0.0.1",
    "@likego/client": "0.0.1",
    "@likego/context": "0.0.1",
    "@likego/core": "0.0.1",
    "@likego/server": "0.0.1",
    "@likego/transport": "0.0.1",
    "@opentelemetry/api": "1.9.1",
    "@opentelemetry/sdk-metrics": "2.10.0",
    "@opentelemetry/sdk-trace": "2.10.0"
  })
  expect(packageManifest.devDependencies).toMatchObject({
    "@likego/registry": "workspace:*",
    "@likego/transport-http": "workspace:*",
    "@opentelemetry/context-async-hooks": "2.10.0",
    "@opentelemetry/core": "2.10.0",
    "@opentelemetry/exporter-metrics-otlp-http": "0.221.0",
    "@opentelemetry/exporter-trace-otlp-http": "0.221.0",
    "@opentelemetry/resources": "2.10.0"
  })
  expect(packageManifest.module).toBe("src/index.ts")
  expect(packageManifest.typings).toBe("src/index.ts")
  expect(packageManifest.exports).toEqual({ ".": "./src/index.ts" })
  expect(capability).toMatchObject({
    schemaVersion: 2,
    package: "@likego/otel",
    packageKind: "integration",
    exports: {
      ".": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["tracer-provider", "meter-provider"],
        capabilities: [
          "broker",
          "client",
          "metrics",
          "observability",
          "opentelemetry",
          "server",
          "web"
        ]
      }
    }
  })
  expect(owner.resources).toEqual([
    {
      id: "tracer-provider",
      owner: "application-owned",
      exposure: "native-borrowed",
      stopContract: "likego-owned"
    },
    {
      id: "meter-provider",
      owner: "application-owned",
      exposure: "native-borrowed",
      stopContract: "likego-owned"
    }
  ])
  expect(readme).toContain(
    "otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6"
  )
  expect(readme).toContain(
    "https://github.com/MunMunMiao/likego/blob/main/packages/otel/test/e2e/collector-0.157.0-report.md"
  )
})
