import { resolve } from "node:path"

import { runFrameworkDistConsumerMain, type VendorPackageSource } from "../harness/framework-stage"

const Kinds = Object.freeze(["vanilla", "hono", "h3", "elysia"] as const)
type FrameworkKind = (typeof Kinds)[number]

function frameworkKind(value: string | undefined): FrameworkKind {
  if (Kinds.includes(value as FrameworkKind)) return value as FrameworkKind
  throw new Error(`unknown web framework evidence target ${value ?? ""}`)
}

const root = resolve(import.meta.dir, "../..")
const kind = frameworkKind(process.argv[2])
const builtPackages = ["@go-like/context", "@go-like/core", "@go-like/web"]
const vendorPackages: VendorPackageSource[] = [
  {
    name: "@hono/node-server",
    source: resolve(root, "packages/web/node_modules/@hono/node-server")
  }
]
if (kind === "hono") {
  vendorPackages.push({ name: "hono", source: resolve(root, "examples/hono/node_modules/hono") })
}
if (kind === "h3") {
  vendorPackages.push({ name: "h3", source: resolve(root, "examples/h3/node_modules/h3") })
}
if (kind === "elysia") {
  vendorPackages.push({
    name: "elysia",
    source: resolve(root, "examples/elysia/node_modules/elysia")
  })
}

await runFrameworkDistConsumerMain({
  root,
  prefix: `go-like-framework-${kind}-`,
  consumer: resolve(import.meta.dir, "web-framework-native-consumer.mjs"),
  arguments: [kind],
  builtPackages,
  vendorPackages,
  requiredRuntimePeers: {
    "@hono/node-server": ["hono"],
    elysia: ["@sinclair/typebox"]
  }
})
