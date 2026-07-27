import { expect, test } from "bun:test"

const PackageRoot = `${import.meta.dir}/..`

/** Reads one package-local JSON contract as untrusted data. */
async function json(path: string): Promise<unknown> {
  return await Bun.file(`${PackageRoot}/${path}`).json()
}

test("declares the exact native Pino runtime package contract", async () => {
  expect(await json("package.json")).toEqual({
    $schema: "https://json.schemastore.org/package.json",
    name: "@likego/pino",
    version: expect.any(String),
    description: "Native Pino lifecycle and request logging adapters for LikeGo.",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    publishConfig: { directory: "dist", access: "public" },
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      test: "bun test --isolate --no-orphans test/*.test.ts",
      "test:coverage":
        "bun test --isolate --no-orphans test/*.test.ts --coverage --coverage-reporter=lcov --coverage-dir .artifacts/coverage && bun test/coverage-contract.ts",
      "test:install": "bun test/integration/published-install.ts",
      typecheck: "tsc -p tsconfig.test.json --pretty false",
      "smoke:bun": "bun test/smoke/runtime-smoke.ts",
      "smoke:node": "tsx test/smoke/runtime-smoke.ts"
    },
    dependencies: {
      "@likego/broker": expect.any(String),
      "@likego/client": expect.any(String),
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@likego/server": expect.any(String),
      "@likego/transport": expect.any(String),
      "@types/node": "26.1.1",
      pino: "10.3.1"
    },
    license: "MIT"
  })
})

test("keeps package-private lifecycle seams out of the official Pino public boundary", async () => {
  expect(await json("tsconfig.json")).toMatchObject({
    compilerOptions: { skipLibCheck: true }
  })
  expect(await json("tsconfig.test.json")).toMatchObject({
    compilerOptions: { skipLibCheck: true }
  })
  const types = await Bun.file(`${PackageRoot}/src/types.ts`).text()
  const runtime = await Bun.file(`${PackageRoot}/src/runtime.ts`).text()
  const index = await Bun.file(`${PackageRoot}/src/index.ts`).text()
  expect(types).not.toContain('from "pino"')
  expect(types).not.toContain("interface PinoLogger")
  expect(types).not.toMatch(/export interface PinoDestination(?:\s|\{)/)
  expect(runtime).toContain('symbols, type Logger } from "pino"')
  expect(runtime).not.toContain('from "sonic-boom"')
  expect(runtime).not.toContain("PinnedSonicBoom")
  expect(runtime).not.toContain("Object.getPrototypeOf(destination)")
  expect(runtime).toContain("snapshotOwnerOperations")
  expect(runtime).toContain("constructionOperations")
  expect(runtime).toContain("validateOwnerOperations")
  expect(runtime).toMatch(
    /const captureFailure\s*=\s*failures\[0\]\s*\?\?\s*\(closeObserved\s*\?\s*newPinoDestinationClosedError\(\)\s*:\s*captureStateFailure\)/
  )
  expect(runtime).toContain(
    "validateOwnerOperations(capturedLogger, capturedDestination, constructionOperations)"
  )
  expect(runtime).not.toContain("newPinoServerWithOwnerOperations")
  expect(runtime).toContain("operations.destinationEnd.call(lifecycleDestination)")
  expect(runtime).toContain("operations.destinationDestroy.call(lifecycleDestination)")
  expect(runtime).toContain("operation.call(logger, flushed)")
  expect(runtime).toContain('ReturnType<typeof import("pino").destination>')
  expect(runtime).toContain('ReturnType<typeof import("pino").transport>')
  expect(index).not.toContain("DestinationLifecycle")
  expect(index).not.toContain("LoggerFlushLifecycle")
  expect(index).not.toContain("PinoLogger")
  expect(index).not.toContain("PinoDestination,")
})

test("declares the borrowed logger and explicitly transferred destination ownership", async () => {
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/pino",
    packageKind: "integration",
    exports: {
      ".": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["logger", "destination"],
        capabilities: ["broker", "client", "logging", "server", "web"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/pino",
    resources: [
      {
        id: "logger",
        owner: "application-owned",
        exposure: "native-borrowed",
        stopContract: "application-owned"
      },
      {
        id: "destination",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("contains only the intended production source inventory", async () => {
  const sourceFiles: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({
    cwd: PackageRoot,
    onlyFiles: true
  })) {
    sourceFiles.push(file)
  }
  sourceFiles.sort()
  expect(sourceFiles).toEqual([
    "src/errors.ts",
    "src/index.ts",
    "src/logging.ts",
    "src/runtime.ts",
    "src/thread-stream-node26-compat.ts",
    "src/types.ts"
  ])
})

test("ships the exact ThreadStream declaration bridge required by latest Node types", async () => {
  const index = await Bun.file(`${PackageRoot}/src/index.ts`).text()
  const compatibility = await Bun.file(`${PackageRoot}/src/thread-stream-node26-compat.ts`).text()

  expect(index).toContain('export type {} from "./thread-stream-node26-compat"')
  expect(compatibility).toContain('import type { Transferable } from "node:worker_threads"')
  expect(compatibility).toContain("type TransferListItem = Transferable")
})
