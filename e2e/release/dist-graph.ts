/**
 * RV2(a) and RV2(c) release gate.
 *
 * (a) Every plug's built JavaScript imports core only through bare
 *     `@go-like/core/...` specifiers and contains no inlined core instance marker.
 * (c) The built import graph of every portable (lane P) entry reaches no
 *     `node:` or `bun:` specifier, following relative chunks and `@go-like/*`
 *     imports into the matching package dist.
 *
 * Run after `bun run build`:
 *   bun e2e/release/dist-graph.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoDir = fileURLToPath(new URL("../..", import.meta.url))
const packagesDir = join(repoDir, "packages")
const marker = "go-like.core.instances"

/** Core entries that may reach a Node or Bun runtime (design 3.4 lane column). */
const coreBindingEntries: ReadonlySet<string> = new Set([
  "./node",
  "./transport/http/node",
  "./web/node",
  "./web/bun",
  "./config/node"
])

/** Portable plug entries from design 3.3, lane P. */
const portablePlugEntries: readonly (readonly [string, string])[] = [
  ["@go-like/otel", "."],
  ["@go-like/consul", "."],
  ["@go-like/consul", "./registry"],
  ["@go-like/consul", "./config"],
  ["@go-like/consul", "./store"],
  ["@go-like/etcd", "."],
  ["@go-like/etcd", "./registry"],
  ["@go-like/etcd", "./config"],
  ["@go-like/etcd", "./store"],
  ["@go-like/vault", "."],
  ["@go-like/vault", "./config"],
  ["@go-like/vault", "./store"],
  ["@go-like/kubernetes", "."],
  ["@go-like/kubernetes", "./registry"],
  ["@go-like/kubernetes", "./config"],
  ["@go-like/zookeeper", "./registry"],
  ["@go-like/mdns", "./registry"],
  ["@go-like/yaml", "./config"],
  ["@go-like/croner", "./job"],
  ["@go-like/file", "./store"],
  ["@go-like/connectrpc", "."]
]

interface DistPackage {
  readonly name: string
  readonly root: string
  readonly exports: ReadonlyMap<string, string>
}

function display(file: string): string {
  return relative(repoDir, file).replaceAll("\\", "/")
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

/** Reads the `import` (or `default`) target from one dist exports value. */
function exportTarget(value: unknown, label: string): string {
  if (typeof value === "string") return value
  const fields = record(value, label)
  for (const key of ["import", "default"] as const) {
    const target = fields[key]
    if (typeof target === "string") return target
  }
  throw new Error(`${label} has no import target`)
}

/** Reads one built package and its dist export map. */
function readDistPackage(directory: string): DistPackage | null {
  const root = join(packagesDir, directory, "dist")
  const manifestPath = join(root, "package.json")
  if (!existsSync(manifestPath)) return null
  const manifest = record(JSON.parse(readFileSync(manifestPath, "utf8")), manifestPath)
  if (typeof manifest.name !== "string") throw new TypeError(`${manifestPath} has no name`)
  const exports = new Map<string, string>()
  for (const [key, value] of Object.entries(record(manifest.exports, `${manifest.name} exports`))) {
    if (key === "./package.json") continue
    exports.set(key, exportTarget(value, `${manifest.name} ${key}`))
  }
  return { name: manifest.name, root, exports }
}

/** Collects built JavaScript files under one dist directory. */
function javascriptFiles(directory: string, found: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      javascriptFiles(path, found)
      continue
    }
    if (entry.name.endsWith(".js")) found.push(path)
  }
}

/** Extracts static and dynamic module specifiers from one built file. */
function specifiers(source: string): readonly string[] {
  const found = new Set<string>()
  const staticPattern = /\b(?:import|export)\s+(?:[^"'();]*?\bfrom\s*)?["']([^"']+)["']/gu
  for (const match of source.matchAll(staticPattern)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found]
}

/** Maps a bare `@go-like/...` specifier onto its dist entry file. */
function resolveGoLike(
  packageByDir: ReadonlyMap<string, DistPackage>,
  specifier: string
): { readonly file: string } | { readonly failure: string } {
  const rest = specifier.slice("@go-like/".length)
  const slash = rest.indexOf("/")
  const directory = slash === -1 ? rest : rest.slice(0, slash)
  const key = slash === -1 ? "." : `.${rest.slice(slash)}`
  const parsed = packageByDir.get(directory)
  if (parsed === undefined) return { failure: `unknown package ${specifier}` }
  const target = parsed.exports.get(key)
  if (target === undefined) return { failure: `missing export ${specifier}` }
  const file = resolve(parsed.root, target)
  if (!existsSync(file)) return { failure: `missing dist file ${specifier} -> ${display(file)}` }
  return { file }
}

/** Resolves a file or directory target the way the built graph uses it. */
function resolveImport(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const directories = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
const packages: DistPackage[] = []
const failures: string[] = []
for (const directory of directories) {
  const parsed = readDistPackage(directory)
  if (parsed === null) {
    failures.push(`missing dist packages/${directory}/dist; build the packages first`)
    continue
  }
  packages.push(parsed)
}
const packageByDir = new Map(
  packages.map((parsed) => [parsed.name.slice("@go-like/".length), parsed] as const)
)
const core = packageByDir.get("core")
if (core === undefined) throw new Error("packages/core/dist is missing")

/** RV2(a): scan every plug dist and validate core imports plus the marker. */
const plugPackages = packages.filter((parsed) => parsed.name !== "@go-like/core")
let plugFiles = 0
let coreSpecifiersOk = 0
let markerHits = 0
for (const plug of plugPackages) {
  const files: string[] = []
  javascriptFiles(plug.root, files)
  plugFiles += files.length
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    if (source.includes(marker)) {
      markerHits += 1
      failures.push(`marker file=${display(file)} text=${marker}`)
    }
    for (const specifier of specifiers(source)) {
      if (specifier.startsWith("@go-like/core")) {
        if (!/^@go-like\/core(?:\/[A-Za-z0-9._-]+)*$/u.test(specifier)) {
          failures.push(`core-specifier file=${display(file)} import=${specifier}`)
          continue
        }
        const resolved = resolveGoLike(packageByDir, specifier)
        if ("failure" in resolved) {
          failures.push(
            `core-specifier file=${display(file)} import=${specifier} (${resolved.failure})`
          )
          continue
        }
        coreSpecifiersOk += 1
        continue
      }
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier)
        const inside = relative(plug.root, target)
        if (inside.startsWith("..") || isAbsolute(inside)) {
          failures.push(`relative-escape file=${display(file)} import=${specifier}`)
        }
        continue
      }
      if (isAbsolute(specifier) || specifier.startsWith("file:")) {
        failures.push(`absolute-import file=${display(file)} import=${specifier}`)
      }
    }
  }
}

/** RV2(c): walk every portable entry's built graph for runtime specifiers. */
const portableStarts: { readonly label: string; readonly file: string }[] = []
for (const key of core.exports.keys()) {
  if (coreBindingEntries.has(key)) continue
  const target = core.exports.get(key)
  if (target === undefined) continue
  portableStarts.push({
    label: `@go-like/core${key.slice(1)}`,
    file: resolve(core.root, target)
  })
}
for (const [name, key] of portablePlugEntries) {
  const resolved = resolveGoLike(packageByDir, `${name}${key.slice(1)}`)
  if ("failure" in resolved) {
    failures.push(`portable-entry ${name}${key.slice(1)} (${resolved.failure})`)
    continue
  }
  portableStarts.push({ label: `${name}${key.slice(1)}`, file: resolved.file })
}

const visited = new Set<string>()
const nodeViolations = new Set<string>()
const pending = portableStarts.map((entry) => entry.file)
while (pending.length > 0) {
  const file = pending.pop()
  if (file === undefined || visited.has(file)) continue
  visited.add(file)
  for (const specifier of specifiers(readFileSync(file, "utf8"))) {
    if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
      nodeViolations.add(`${display(file)} -> ${specifier}`)
      continue
    }
    if (specifier.startsWith(".")) {
      const target = resolveImport(file, specifier)
      if (target === null) {
        failures.push(`unresolved-relative file=${display(file)} import=${specifier}`)
        continue
      }
      pending.push(target)
      continue
    }
    if (specifier.startsWith("@go-like/")) {
      const resolved = resolveGoLike(packageByDir, specifier)
      if ("failure" in resolved) {
        failures.push(`unresolved-import file=${display(file)} import=${specifier}`)
        continue
      }
      pending.push(resolved.file)
    }
  }
}
for (const violation of nodeViolations) failures.push(`runtime-import ${violation}`)

console.log(
  `plugs=${plugPackages.length} files=${plugFiles} core_specifiers_ok=${coreSpecifiersOk} marker_hits=${markerHits} portable_entries=${portableStarts.length} node_imports=${nodeViolations.size}`
)
if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
}
