import { expect, test } from "bun:test"
import { dirname, relative, resolve } from "node:path"

import { API } from "typescript/async"
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteral,
  SyntaxKind,
  type Node
} from "typescript/ast"

/**
 * Design section 3.2 tiers. Inside packages/core, concept directories carry the tier.
 * lifecycle is tier 2 and type-only. waitForContext lives on context.
 */
const corePackages = {
  "@go-like/core": "packages/core"
} as const

/**
 * Runtime binding entries. A binding file is one of these, or a file reached by
 * value imports from these entries and from no portable entry. `node:`, `bun`,
 * and `bun:` are legal only in those files.
 */
const bindingExports = [
  "@go-like/core/config/node",
  "@go-like/core/node",
  "@go-like/core/transport/http/node",
  "@go-like/core/web/bun",
  "@go-like/core/web/node"
] as const

/** Third-party specifiers, including type-only imports. The vendored schema leaves this empty. */
const allowedSpecifierViolations: readonly string[] = []

/** `node:` / `bun` / `bun:` outside runtime binding files. None on the current tree. */
const allowedRuntimeSpecifiers: readonly string[] = []

/** Portable value-import closures that reach a binding entry or a runtime specifier. None today. */
const allowedPortableClosure: readonly string[] = []

/** Value imports whose target tier is higher than the source. None today. */
const allowedTierViolations: readonly string[] = []

/** Value-level file cycles. None today. */
const allowedValueCycles: readonly string[] = []

const root = resolve(import.meta.dir, "..")

interface Edge {
  readonly spec: string
  readonly value: boolean
}

type Target =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "missing" }
  | { readonly kind: "runtime" }
  | { readonly kind: "other" }

interface LaneGraph {
  readonly discoveredBindings: readonly string[]
  readonly specifierViolations: readonly string[]
  readonly runtimeSpecifiers: readonly string[]
  readonly portableClosure: readonly string[]
  readonly tierViolations: readonly string[]
  readonly valueCycles: readonly string[]
  readonly lifecycleSpecifiers: readonly string[]
  readonly yamlSource: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function display(file: string): string {
  return relative(root, file).replaceAll("\\", "/")
}

function coreTier(file: string): 0 | 1 | 2 | 3 | 4 {
  const path = display(file)
  if (path.startsWith("packages/core/src/config/node")) return 4
  if (
    path.startsWith("packages/core/src/cache/memory/") ||
    path.startsWith("packages/core/src/store/memory/") ||
    path.startsWith("packages/core/src/broker/memory/")
  ) {
    return 3
  }
  if (
    path === "packages/core/src/index.ts" ||
    path.startsWith("packages/core/src/app/") ||
    path.startsWith("packages/core/src/node/") ||
    path.startsWith("packages/core/src/transport/http/node") ||
    path.startsWith("packages/core/src/web/node") ||
    path.startsWith("packages/core/src/web/bun") ||
    path.startsWith("packages/core/src/web/native-")
  ) {
    return 4
  }
  if (
    path.startsWith("packages/core/src/transport/http/") ||
    path.startsWith("packages/core/src/transport/memory/")
  ) {
    return 3
  }
  if (path.startsWith("packages/core/src/transport/")) return 2
  if (
    path === "packages/core/src/broker/testing.ts" ||
    path === "packages/core/src/job/testing.ts"
  ) {
    return 3
  }
  if (path.startsWith("packages/core/src/")) {
    const concept = path.slice("packages/core/src/".length).split("/")[0] ?? ""
    if (concept === "context" || concept === "internal") return 0
    if (
      concept === "metadata" ||
      concept === "struct" ||
      concept === "telemetry" ||
      concept === "log" ||
      concept === "trace" ||
      concept === "metric"
    ) {
      return 1
    }
    if (
      concept === "health" ||
      concept === "resilience" ||
      concept === "registry" ||
      concept === "lifecycle" ||
      concept === "resident" ||
      concept === "config" ||
      concept === "fetch" ||
      concept === "cache" ||
      concept === "store" ||
      concept === "broker" ||
      concept === "job"
    )
      return 2
    if (
      concept === "server" ||
      concept === "client" ||
      concept === "web" ||
      concept === "testing"
    ) {
      return 3
    }
    throw new Error(`unmapped core source tier: ${path}`)
  }
  throw new Error(`core source is outside the lane table: ${path}`)
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort()
}

/** Clause-level `import type` / `export type` are not value edges. Inline `type` specifiers are. */
function moduleEdges(node: Node): readonly Edge[] {
  const found: Edge[] = []
  const visit = (current: Node): void => {
    if (isImportDeclaration(current) && isStringLiteral(current.moduleSpecifier)) {
      found.push({
        spec: current.moduleSpecifier.text,
        value: current.importClause?.phaseModifier !== SyntaxKind.TypeKeyword
      })
    } else if (
      isExportDeclaration(current) &&
      current.moduleSpecifier !== undefined &&
      isStringLiteral(current.moduleSpecifier)
    ) {
      found.push({
        spec: current.moduleSpecifier.text,
        value: !current.isTypeOnly
      })
    } else if (
      isImportEqualsDeclaration(current) &&
      isExternalModuleReference(current.moduleReference) &&
      isStringLiteral(current.moduleReference.expression)
    ) {
      found.push({
        spec: current.moduleReference.expression.text,
        value: !current.isTypeOnly
      })
    } else if (isCallExpression(current) && current.expression.kind === SyntaxKind.ImportKeyword) {
      const argument = current.arguments[0]
      if (argument !== undefined && isStringLiteral(argument)) {
        found.push({ spec: argument.text, value: true })
      } else {
        found.push({ spec: "(dynamic)", value: true })
      }
    } else if (
      isImportTypeNode(current) &&
      isLiteralTypeNode(current.argument) &&
      isStringLiteral(current.argument.literal)
    ) {
      found.push({ spec: current.argument.literal.text, value: false })
    }
    current.forEachChild(visit)
  }
  visit(node)
  return found
}

let laneGraph: Promise<LaneGraph> | undefined

function lane(): Promise<LaneGraph> {
  laneGraph ??= loadLane()
  return laneGraph
}

async function loadLane(): Promise<LaneGraph> {
  const manifests = new Map<
    string,
    { readonly directory: string; readonly exports: Record<string, unknown> }
  >()
  for (const [name, directory] of Object.entries(corePackages)) {
    const manifest = record(
      await Bun.file(resolve(root, directory, "package.json")).json(),
      `${name} package.json`
    )
    manifests.set(name, { directory, exports: record(manifest.exports, `${name} exports`) })
  }

  const yamlFile = resolve(root, "packages/yaml/src/config/index.ts")
  const lifecycleTarget = manifests.get("@go-like/core")?.exports["./lifecycle"]
  if (typeof lifecycleTarget !== "string") {
    throw new Error("@go-like/core ./lifecycle export is missing")
  }
  const lifecycleFile = resolve(root, corePackages["@go-like/core"], lifecycleTarget)

  const files = new Set<string>()
  for (const directory of Object.values(corePackages)) {
    for await (const path of new Bun.Glob(`${directory}/src/**/*.{ts,tsx,mts,cts}`).scan({
      cwd: root,
      onlyFiles: true
    })) {
      if (path.endsWith(".d.ts")) continue
      files.add(resolve(root, path))
    }
  }

  function resolveRelative(spec: string, from: string): Target {
    const base = resolve(dirname(from), spec)
    const candidates: string[] = []
    if (/\.(?:[cm]?ts|tsx)$/u.test(spec)) candidates.push(base)
    if (spec.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`)
    if (spec.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.mts`)
    if (spec.endsWith(".cjs")) candidates.push(`${base.slice(0, -4)}.cts`)
    candidates.push(
      `${base}.ts`,
      resolve(base, "index.ts"),
      `${base}.tsx`,
      resolve(base, "index.tsx")
    )
    for (const candidate of candidates) {
      const file = resolve(candidate)
      if (files.has(file)) return { kind: "file", file }
    }
    return { kind: "missing" }
  }

  function resolveSpecifier(spec: string, from: string): Target {
    if (spec.startsWith(".")) return resolveRelative(spec, from)
    if (spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:")) {
      return { kind: "runtime" }
    }
    const match = /^@go-like\/([a-z0-9-]+)(\/.*)?$/u.exec(spec)
    if (match?.[1] === undefined) return { kind: "other" }
    const name = `@go-like/${match[1]}`
    const manifest = manifests.get(name)
    if (manifest === undefined) return { kind: "other" }
    const key = match[2] === undefined ? "." : `.${match[2]}`
    const target = manifest.exports[key]
    if (typeof target !== "string" || !target.startsWith("./")) return { kind: "missing" }
    const file = resolve(root, manifest.directory, target)
    if (!files.has(file)) return { kind: "missing" }
    return { kind: "file", file }
  }

  function entryFile(specifier: string): string {
    const target = resolveSpecifier(specifier, root)
    if (target.kind !== "file") throw new Error(`public entry does not resolve: ${specifier}`)
    return target.file
  }

  const bindingFiles = new Map<string, string>()
  for (const specifier of bindingExports) bindingFiles.set(entryFile(specifier), specifier)
  const discoveredBindings = [...manifests.entries()].flatMap(([name, manifest]) =>
    Object.keys(manifest.exports)
      .filter((key) => key.endsWith("/node") || key.endsWith("/bun"))
      .map((key) => `${name}${key.slice(1)}`)
  )

  const edges = new Map<string, readonly Edge[]>()
  const api = new API()
  try {
    for (const file of files) {
      const retained = await api.createSourceFile(file, await Bun.file(file).text())
      try {
        edges.set(file, moduleEdges(retained.sourceFile))
      } finally {
        await retained.dispose()
      }
    }
  } finally {
    await api.close()
  }

  const specifierViolations: string[] = []
  for (const file of files) {
    for (const edge of edges.get(file) ?? []) {
      const target =
        edge.spec === "(dynamic)" ? { kind: "missing" as const } : resolveSpecifier(edge.spec, file)
      if (target.kind === "runtime") continue
      if (target.kind === "other") specifierViolations.push(`${display(file)} -> ${edge.spec}`)
      else if (target.kind === "missing") {
        specifierViolations.push(`${display(file)} unresolved ${edge.spec}`)
      }
    }
  }

  function valueClosure(starts: readonly string[]): Set<string> {
    const seen = new Set<string>()
    const stack = [...starts]
    while (stack.length > 0) {
      const file = stack.pop()
      if (file === undefined || seen.has(file)) continue
      seen.add(file)
      for (const edge of edges.get(file) ?? []) {
        if (!edge.value || edge.spec === "(dynamic)") continue
        const target = resolveSpecifier(edge.spec, file)
        if (target.kind === "file") stack.push(target.file)
      }
    }
    return seen
  }

  const portableStarts: { readonly specifier: string; readonly file: string }[] = []
  for (const [name, manifest] of manifests) {
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (key === "./package.json" || typeof target !== "string") continue
      const specifier = `${name}${key.slice(1)}`
      if ((bindingExports as readonly string[]).includes(specifier)) continue
      const file = resolve(root, manifest.directory, target)
      if (!files.has(file)) throw new Error(`public entry does not resolve: ${specifier}`)
      portableStarts.push({ specifier, file })
    }
  }

  const portableReached = valueClosure(portableStarts.map((entry) => entry.file))
  const bindingReached = valueClosure([...bindingFiles.keys()])
  const bindingImplementation = new Set<string>([
    ...[...bindingReached].filter((file) => !portableReached.has(file)),
    ...bindingFiles.keys()
  ])

  const runtimeSpecifiers = [...files]
    .filter((file) => !bindingImplementation.has(file))
    .flatMap((file) =>
      (edges.get(file) ?? [])
        .filter((edge) => resolveSpecifier(edge.spec, file).kind === "runtime")
        .map((edge) => `${display(file)} -> ${edge.spec}`)
    )

  const portableClosure: string[] = []
  for (const start of portableStarts) {
    for (const file of valueClosure([start.file])) {
      const binding = bindingFiles.get(file)
      if (binding !== undefined) {
        portableClosure.push(`${start.specifier} reaches binding entry ${binding}`)
      }
      for (const edge of edges.get(file) ?? []) {
        if (edge.value && resolveSpecifier(edge.spec, file).kind === "runtime") {
          portableClosure.push(`${start.specifier} reaches ${edge.spec} in ${display(file)}`)
        }
      }
    }
  }

  const tierViolations: string[] = []
  for (const file of files) {
    const sourceTier = coreTier(file)
    for (const edge of edges.get(file) ?? []) {
      if (!edge.value || edge.spec === "(dynamic)") continue
      const target = resolveSpecifier(edge.spec, file)
      if (target.kind !== "file") continue
      const targetTier = coreTier(target.file)
      if (targetTier > sourceTier) {
        tierViolations.push(
          `${display(file)} tier ${sourceTier} -> ${edge.spec} tier ${targetTier}`
        )
      }
    }
  }

  const lifecycleEdges = edges.get(lifecycleFile) ?? []
  return {
    discoveredBindings: sortedUnique(discoveredBindings),
    specifierViolations: sortedUnique(specifierViolations),
    runtimeSpecifiers: sortedUnique(runtimeSpecifiers),
    portableClosure: sortedUnique(portableClosure),
    tierViolations: sortedUnique(tierViolations),
    valueCycles: collectValueCycles(files, edges, resolveSpecifier),
    lifecycleSpecifiers: sortedUnique(
      lifecycleEdges.filter((edge) => edge.value).map((edge) => edge.spec)
    ),
    yamlSource: await Bun.file(yamlFile).text()
  }
}

function collectValueCycles(
  nodes: ReadonlySet<string>,
  graph: ReadonlyMap<string, readonly Edge[]>,
  resolveSpecifier: (spec: string, from: string) => Target
): readonly string[] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  const visit = (node: string): void => {
    indices.set(node, index)
    low.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const edge of graph.get(node) ?? []) {
      if (!edge.value || edge.spec === "(dynamic)") continue
      const target = resolveSpecifier(edge.spec, node)
      if (target.kind !== "file" || !nodes.has(target.file)) continue
      const next = target.file
      if (!indices.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, indices.get(next) ?? 0))
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = []
      let current: string | undefined
      do {
        current = stack.pop()
        if (current === undefined) break
        onStack.delete(current)
        component.push(current)
      } while (current !== node)
      const self = (graph.get(node) ?? []).some((edge) => {
        if (!edge.value || edge.spec === "(dynamic)") return false
        const target = resolveSpecifier(edge.spec, node)
        return target.kind === "file" && target.file === node
      })
      if (component.length > 1 || self) components.push(component.map(display).sort())
    }
  }
  for (const node of nodes) if (!indices.has(node)) visit(node)
  return components.map((component) => component.join(" | ")).sort()
}

test("clause-level type imports are not value edges and inline type imports are", async () => {
  const source = [
    'import type { A } from "type-only"',
    'import { type B } from "inline"',
    'import { type C, D } from "mixed"',
    'import "side"',
    'export type { E } from "export-type"',
    'export { type F } from "export-inline"',
    'export { G } from "export-value"',
    'export * from "export-star"',
    'await import("dynamic")',
    'const name = "variable"; await import(name)',
    "import {",
    "  type Left,",
    "  type Right",
    '} from "multiline"',
    'type Query = import("type-query").Value'
  ].join("\n")
  const api = new API()
  try {
    const retained = await api.createSourceFile("sample.ts", source)
    try {
      const edges = moduleEdges(retained.sourceFile)
      expect(sortedUnique(edges.filter((edge) => edge.value).map((edge) => edge.spec))).toEqual([
        "(dynamic)",
        "dynamic",
        "export-inline",
        "export-star",
        "export-value",
        "inline",
        "mixed",
        "multiline",
        "side"
      ])
      expect(sortedUnique(edges.filter((edge) => !edge.value).map((edge) => edge.spec))).toEqual([
        "export-type",
        "type-only",
        "type-query"
      ])
    } finally {
      await retained.dispose()
    }
  } finally {
    await api.close()
  }
})

test("core sources import only relative paths or binding runtimes", async () => {
  const graph = await lane()
  expect(graph.yamlSource).toContain('from "js-yaml/browser"')
  expect(graph.specifierViolations).toEqual([...allowedSpecifierViolations])
  expect(graph.runtimeSpecifiers).toEqual([...allowedRuntimeSpecifiers])
})

test("runtime binding exports are exactly the node and bun subpaths", async () => {
  const graph = await lane()
  expect(graph.discoveredBindings).toEqual([...bindingExports].sort())
})

test("portable entries do not reach node, bun, or a binding entry", async () => {
  expect((await lane()).portableClosure).toEqual([...allowedPortableClosure])
})

test("value imports stay at the same tier or a lower one", async () => {
  const graph = await lane()
  expect(graph.lifecycleSpecifiers).toEqual(["./resource-server"])
  expect(graph.tierViolations).toEqual([...allowedTierViolations])
})

test("core lane files have no value-level cycle", async () => {
  expect((await lane()).valueCycles).toEqual([...allowedValueCycles])
})
