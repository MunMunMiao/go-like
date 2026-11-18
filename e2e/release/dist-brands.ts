/**
 * D26 release gate.
 * Over the built dist of every package, each brand symbol and each WeakMap or WeakSet
 * registry fingerprint is defined in exactly one module.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const repoDir = fileURLToPath(new URL("../..", import.meta.url))
const packagesDir = join(repoDir, "packages")
const moduleFile = /\.(?:mjs|cjs|js|d\.mts|d\.cts|d\.ts)$/
const javascriptFile = /\.(?:mjs|cjs|js)$/
const requiredBrands = [
  ["etcd", "Etcd client must be created by newEtcdClient"],
  ["consul", "Consul client must be created by newConsulClient"],
  ["vault", "Vault client must be created by newVaultClient"],
  ["kubernetes", "Kubernetes client must be created by newKubernetesClient"]
] as const

/** Collects built modules under one dist directory. */
function modules(directory: string, found: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      modules(path, found)
      continue
    }
    if (moduleFile.test(entry.name)) found.push(path)
  }
}

/** Collapses whitespace so identical inlined modules share one fingerprint. */
function window(source: string, start: number, end: number): string {
  return source.slice(start, end).replace(/\s+/g, " ")
}

/** Records one brand fingerprint and the module that defined it. */
function add(found: Map<string, string[]>, key: string, file: string): void {
  const files = found.get(key)
  if (files === undefined) found.set(key, [file])
  else files.push(file)
}

/** Finds brand declarations and registry constructors in one module. */
function scan(source: string, file: string, found: Map<string, string[]>): void {
  const symbolDeclaration =
    /(?:^|[^\w$])(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*unique symbol\b/g
  const symbolCall = /Symbol\(\s*(["'])([^"'\\]*)\1\s*\)/g
  const weakCollection = /new Weak(?:Map|Set)\b/g
  for (const match of source.matchAll(symbolDeclaration)) {
    const name = match[1]
    if (name === undefined) continue
    add(found, `symbol:${name}`, file)
  }
  for (const match of source.matchAll(symbolCall)) {
    const index = match.index
    if (index === undefined) continue
    const description = match[2] ?? ""
    const around = window(source, Math.max(0, index - 60), index + match[0].length + 60)
    add(found, `symbol-call:${description}:${around}`, file)
  }
  for (const match of source.matchAll(weakCollection)) {
    const index = match.index
    if (index === undefined) continue
    const around = window(source, Math.max(0, index - 80), index + 320)
    add(found, `registry:${around}`, file)
  }
}

const packageNames = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
const failures: string[] = []
let moduleCount = 0
let brandCount = 0

for (const name of packageNames) {
  const dist = join(packagesDir, name, "dist")
  let stats: ReturnType<typeof statSync> | undefined
  try {
    stats = statSync(dist)
  } catch {
    stats = undefined
  }
  if (stats === undefined || !stats.isDirectory()) {
    failures.push(`missing dist packages/${name}; build the packages first`)
    continue
  }
  const files: string[] = []
  modules(dist, files)
  moduleCount += files.length
  const found = new Map<string, string[]>()
  for (const file of files) {
    scan(readFileSync(file, "utf8"), relative(repoDir, file), found)
  }
  for (const [key, locations] of found) {
    brandCount += 1
    if (locations.length === 1) continue
    const shown = key.length > 160 ? `${key.slice(0, 160)}…` : key
    failures.push(
      `duplicate package=${name} count=${locations.length} key=${shown} files=${locations.join(",")}`
    )
  }
  const required = requiredBrands.find((entry) => entry[0] === name)
  if (required === undefined) continue
  const javascript = files.filter((file) => javascriptFile.test(file))
  const owners = javascript.filter((file) => readFileSync(file, "utf8").includes(required[1]))
  if (owners.length !== 1) {
    failures.push(
      `brand string package=${name} modules=${owners.length} text=${required[1]} files=${owners.map((file) => relative(repoDir, file)).join(",")}`
    )
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  console.log(
    `packages=${packageNames.length} modules=${moduleCount} brands=${brandCount} duplicates=${failures.length}`
  )
  process.exitCode = 1
} else {
  console.log(
    `packages=${packageNames.length} modules=${moduleCount} brands=${brandCount} duplicates=0`
  )
}
