import { expect, test } from "bun:test"
import { relative, resolve } from "node:path"

/**
 * Final 20 workspace packages.
 * `protoc-gen-like` is `@go-like/protoc-gen-like`, the same `@go-like/*` scope as every other package.
 */
const layout = {
  "@go-like/bullmq": "packages/bullmq",
  "@go-like/connectrpc": "packages/connectrpc",
  "@go-like/consul": "packages/consul",
  "@go-like/core": "packages/core",
  "@go-like/croner": "packages/croner",
  "@go-like/etcd": "packages/etcd",
  "@go-like/file": "packages/file",
  "@go-like/kubernetes": "packages/kubernetes",
  "@go-like/mdns": "packages/mdns",
  "@go-like/nats": "packages/nats",
  "@go-like/otel": "packages/otel",
  "@go-like/pino": "packages/pino",
  "@go-like/prometheus": "packages/prometheus",
  "@go-like/protoc-gen-like": "packages/protoc-gen-like",
  "@go-like/rabbitmq": "packages/rabbitmq",
  "@go-like/redis": "packages/redis",
  "@go-like/vault": "packages/vault",
  "@go-like/winston": "packages/winston",
  "@go-like/yaml": "packages/yaml",
  "@go-like/zookeeper": "packages/zookeeper"
} as const

const packageNamePattern = /^@go-like\/[a-z0-9-]+$/u
const dependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies"
] as const
const productionFields = ["dependencies", "peerDependencies", "optionalDependencies"] as const

const root = resolve(import.meta.dir, "..")

interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly exports: Record<string, unknown>
  readonly dependencies: Record<string, Record<string, unknown>>
}

function repoPath(path: string): string {
  return relative(root, resolve(root, path)).replaceAll("\\", "/")
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function workspacePatterns(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TypeError("root package.json workspaces must be a string array")
  }
  return value
}

function matchesWorkspace(directory: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const expression = `^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*")}$`
    return new RegExp(expression, "u").test(directory)
  })
}

function stringField(manifest: Record<string, unknown>, field: string, label: string): string {
  const value = manifest[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} ${field} must be a string`)
  }
  return value
}

async function workspacePackages(): Promise<readonly PackageManifest[]> {
  const packages: PackageManifest[] = []
  const names = new Set<string>()
  for await (const path of new Bun.Glob("packages/**/package.json").scan({
    cwd: root,
    onlyFiles: true
  })) {
    if (
      path.includes("/node_modules/") ||
      path.includes("/dist/") ||
      path.includes("/.artifacts/")
    ) {
      continue
    }
    const manifest = record(await Bun.file(resolve(root, path)).json(), path)
    const name = stringField(manifest, "name", path)
    if (names.has(name)) throw new Error(`duplicate workspace package ${name}`)
    names.add(name)
    const dependencies: Record<string, Record<string, unknown>> = {}
    for (const field of dependencyFields) {
      if (manifest[field] === undefined) continue
      dependencies[field] = record(manifest[field], `${name} ${field}`)
    }
    packages.push({
      name,
      version: stringField(manifest, "version", path),
      directory: repoPath(resolve(root, path, "..")),
      exports: record(manifest.exports, `${name} exports`),
      dependencies
    })
  }
  return packages
}

async function lockstepVersion(): Promise<{ readonly version: string; readonly source: string }> {
  const manifest = record(await Bun.file(resolve(root, "package.json")).json(), "root package.json")
  if (typeof manifest.version === "string" && manifest.version.length > 0) {
    return { version: manifest.version, source: "root package.json" }
  }
  const versions = new Set((await workspacePackages()).map((item) => item.version))
  if (versions.size !== 1) {
    throw new Error(
      `workspace packages do not share one version: ${[...versions].sort().join(", ")}`
    )
  }
  const version = [...versions][0]
  if (version === undefined) throw new Error("workspace has no packages")
  return { version, source: "the single shared package version" }
}

function dependencyCycles(packages: readonly PackageManifest[]): readonly string[] {
  const names = new Set(packages.map((item) => item.name))
  const edges = new Map<string, readonly string[]>()
  for (const item of packages) {
    const next = new Set<string>()
    for (const field of productionFields) {
      for (const name of Object.keys(item.dependencies[field] ?? {})) {
        if (name.startsWith("@go-like/") && names.has(name)) next.add(name)
      }
    }
    edges.set(item.name, [...next].sort())
  }
  const found: string[] = []
  const color = new Map<string, number>()
  const stack: string[] = []
  const visit = (name: string): void => {
    color.set(name, 1)
    stack.push(name)
    for (const next of edges.get(name) ?? []) {
      const state = color.get(next) ?? 0
      if (state === 0) visit(next)
      else if (state === 1) {
        const start = stack.indexOf(next)
        found.push(stack.slice(start).concat(next).join(" -> "))
      }
    }
    stack.pop()
    color.set(name, 2)
  }
  for (const name of edges.keys()) if ((color.get(name) ?? 0) === 0) visit(name)
  return found
}

test("workspace packages match the layout table, scope, and lockstep version", async () => {
  const packages = await workspacePackages()
  const discovered = Object.fromEntries(packages.map((item) => [item.name, item.directory]))
  expect(discovered).toEqual(layout)
  const rootManifest = record(
    await Bun.file(resolve(root, "package.json")).json(),
    "root package.json"
  )
  const unmatched = packages
    .filter((item) => !matchesWorkspace(item.directory, workspacePatterns(rootManifest.workspaces)))
    .map((item) => item.directory)
  expect(unmatched).toEqual([])
  const unscoped = packages
    .filter((item) => !packageNamePattern.test(item.name))
    .map((item) => item.name)
  expect(unscoped).toEqual([])
  const lockstep = await lockstepVersion()
  expect(lockstep.source).toBe("root package.json")
  const mismatched = packages
    .filter((item) => item.version !== lockstep.version)
    .map((item) => `${item.name}@${item.version}`)
  expect(mismatched).toEqual([])
})

test("internal @go-like dependencies use the lockstep version and devDependencies use workspace:*", async () => {
  const packages = await workspacePackages()
  const lockstep = await lockstepVersion()
  const problems: string[] = []
  for (const item of packages) {
    for (const field of dependencyFields) {
      const expected = field === "devDependencies" ? "workspace:*" : lockstep.version
      for (const [name, range] of Object.entries(item.dependencies[field] ?? {})) {
        if (!name.startsWith("@go-like/")) continue
        if (!(name in layout)) problems.push(`${item.name} ${field} ${name} is not in the layout`)
        if (range !== expected) {
          problems.push(
            `${item.name} ${field} ${name} is ${JSON.stringify(range)}, expected ${expected}`
          )
        }
      }
    }
  }
  expect(problems).toEqual([])
})

test("non-dev internal package dependencies are acyclic", async () => {
  expect(dependencyCycles(await workspacePackages())).toEqual([])
})

test("plugs peer-depend on exact core and never on another plug", async () => {
  const packages = await workspacePackages()
  const lockstep = await lockstepVersion()
  const problems: string[] = []
  for (const item of packages) {
    if (item.name === "@go-like/core") continue
    const fields = dependencyFields.flatMap((field) =>
      Object.keys(item.dependencies[field] ?? {}).map((name) => `${field} ${name}`)
    )
    if (item.name === "@go-like/protoc-gen-like") {
      if (fields.some((field) => field.endsWith(" @go-like/core"))) {
        problems.push("@go-like/protoc-gen-like depends on @go-like/core")
      }
      continue
    }
    if (item.dependencies.peerDependencies?.["@go-like/core"] !== lockstep.version) {
      problems.push(`${item.name} peerDependencies @go-like/core must be ${lockstep.version}`)
    }
    if (item.dependencies.devDependencies?.["@go-like/core"] !== "workspace:*") {
      problems.push(`${item.name} devDependencies @go-like/core must be workspace:*`)
    }
    for (const field of fields) {
      const name = field.slice(field.indexOf(" ") + 1)
      if (name.startsWith("@go-like/") && name !== "@go-like/core") {
        problems.push(`${item.name} depends on plug ${name}`)
      }
    }
  }
  expect(problems).toEqual([])
})

test("tsconfig paths match one repo-root target per public entry", async () => {
  const packages = await workspacePackages()
  const byName = new Map(packages.map((item) => [item.name, item]))
  const expected: Record<string, readonly string[]> = {}
  for (const [name, directory] of Object.entries(layout)) {
    const manifest = byName.get(name)
    if (manifest === undefined) throw new Error(`layout package is missing on disk: ${name}`)
    if (manifest.directory !== directory) {
      throw new Error(`${name} directory is ${manifest.directory}, layout says ${directory}`)
    }
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (key === "./package.json") continue
      if (typeof target !== "string" || !target.startsWith("./")) {
        throw new Error(`${name} export ${key} does not target a relative file`)
      }
      expected[`${name}${key.slice(1)}`] = [`./${directory}/${target.slice("./".length)}`]
    }
  }
  const base = record(
    await Bun.file(resolve(root, "tsconfig.base.json")).json(),
    "tsconfig.base.json"
  )
  const compilerOptions = record(base.compilerOptions, "compilerOptions")
  const paths = record(compilerOptions.paths, "compilerOptions.paths")
  const actual: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(paths)) actual[key] = value
  expect(actual).toEqual(expected)
})

test("each protocol client brands itself in exactly one source module", async () => {
  const glob = new Bun.Glob("**/*.ts")
  for (const name of ["consul", "etcd", "vault", "kubernetes"] as const) {
    const directory = resolve(root, "packages", name, "src")
    const matches: string[] = []
    for await (const file of glob.scan({ cwd: directory, onlyFiles: true })) {
      const text = await Bun.file(resolve(directory, file)).text()
      if (text.includes("new WeakMap")) matches.push(file.replaceAll("\\", "/"))
    }
    expect(matches).toEqual(["client/client.ts"])
  }
})
