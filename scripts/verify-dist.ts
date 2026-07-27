import { parse } from "@babel/parser"
import { stat } from "node:fs/promises"
import { basename, extname, join, relative, resolve, sep } from "node:path"

import { discoverWorkspaces } from "../tools/workspaces/discovery"
import { declarationCompanionSource } from "./annotate-dist"
import { distPackageManifest, packageEntries } from "./package-dist"

interface SyntaxNode {
  readonly type: string
  readonly [name: string]: unknown
}

/** Narrows one Babel syntax-tree value without coupling the release gate to visitor packages. */
function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  )
}

/** Reads a Babel string-literal value. */
function stringLiteral(value: unknown): string | undefined {
  if (!isSyntaxNode(value) || value.type !== "StringLiteral") return undefined
  const literal = Reflect.get(value, "value")
  return typeof literal === "string" ? literal : undefined
}

/** Reads actual module specifiers without mistaking generated source held in string literals for imports. */
function generatedModuleSpecifiers(path: string, source: string): readonly string[] {
  const sourceFile = parse(source, {
    sourceType: "module",
    plugins: [["typescript", { dts: path.endsWith(".d.ts") }]]
  })
  const specifiers: string[] = []
  const add = (value: unknown): void => {
    const specifier = stringLiteral(value)
    if (specifier !== undefined) specifiers.push(specifier)
  }
  const visit = (node: SyntaxNode): void => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "TSImportType"
    ) {
      add(node.source)
    } else if (node.type === "ImportExpression") {
      add(node.source)
    } else if (node.type === "TSExternalModuleReference") {
      add(node.expression)
    } else if (node.type === "CallExpression") {
      const callee = node.callee
      const arguments_ = node.arguments
      if (isSyntaxNode(callee) && callee.type === "Import" && Array.isArray(arguments_)) {
        add(arguments_[0])
      }
    }
    for (const value of Object.values(node)) {
      if (isSyntaxNode(value)) {
        visit(value)
      } else if (Array.isArray(value)) {
        for (const child of value) {
          if (isSyntaxNode(child)) visit(child)
        }
      }
    }
  }
  if (!isSyntaxNode(sourceFile)) throw new TypeError(`generated syntax tree is invalid: ${path}`)
  visit(sourceFile)
  return Object.freeze(specifiers)
}

/** Reports whether a generated-output root is an existing directory. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function distributionFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  for await (const path of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
    files.push(path)
  }
  return Object.freeze(files.sort())
}

async function publishVersions(root: string): Promise<ReadonlyMap<string, string>> {
  const versions = new Map<string, string>()
  for (const workspace of await discoverWorkspaces(root)) {
    if (workspace.private) continue
    const value: unknown = await Bun.file(join(root, workspace.manifestPath)).json()
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("version" in value) ||
      typeof value.version !== "string"
    ) {
      throw new TypeError(`${workspace.name} package version must be a string`)
    }
    versions.set(workspace.name, value.version)
  }
  return versions
}

/**
 * Returns whether a relative path remains inside its declared distribution directory.
 */
function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))
}

/**
 * Validates that generated JavaScript and declarations use Node-compatible relative specifiers.
 */
async function verifyGeneratedFile(
  root: string,
  distRoot: string,
  path: string,
  counterpartRequired: boolean
): Promise<readonly string[]> {
  const issues: string[] = []
  const source = await Bun.file(path).text()
  if (path.endsWith(".js")) {
    const declarationName = `${basename(path, ".js")}.d.ts`
    const declarationPath = join(path, "..", declarationName)
    const declarationExists = await Bun.file(declarationPath).exists()
    if (counterpartRequired && !declarationExists) {
      issues.push(`${relative(root, path)}: adjacent generated declaration is missing`)
    }
    const headerOffset = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0
    if (
      declarationExists &&
      !source.startsWith(`// @ts-self-types="./${declarationName}"\n`, headerOffset)
    ) {
      issues.push(`${relative(root, path)}: Deno self-types header is missing or incorrect`)
    }
  } else {
    const runtimePath = `${path.slice(0, -".d.ts".length)}.js`
    if (counterpartRequired && !(await Bun.file(runtimePath).exists())) {
      issues.push(`${relative(root, path)}: adjacent generated JavaScript is missing`)
    }
  }
  for (const specifier of generatedModuleSpecifiers(path, source)) {
    if (!specifier.startsWith(".")) continue
    if (extname(specifier) !== ".js") {
      issues.push(
        `${relative(root, path)}: relative generated import must end in .js: ${specifier}`
      )
      continue
    }
    const target = resolve(path, "..", specifier)
    if (!isInside(distRoot, target)) {
      issues.push(`${relative(root, path)}: relative generated import escapes dist: ${specifier}`)
      continue
    }
    if (!(await Bun.file(target).exists())) {
      issues.push(
        `${relative(root, path)}: relative generated import target is missing: ${specifier}`
      )
    }
    if (path.endsWith(".d.ts")) {
      const declarationTarget = `${target.slice(0, -extname(target).length)}.d.ts`
      if (!(await Bun.file(declarationTarget).exists())) {
        issues.push(
          `${relative(root, path)}: relative generated declaration target is missing: ${specifier}`
        )
      }
    }
  }
  return issues
}

async function reachableGeneratedFiles(
  distRoot: string,
  entries: readonly string[],
  files: ReadonlySet<string>,
  declarations: boolean
): Promise<ReadonlySet<string>> {
  const pending = Array.from(entries)
  const reachable = new Set<string>()
  while (pending.length > 0) {
    const path = pending.shift()
    if (path === undefined || reachable.has(path) || !files.has(path)) continue
    reachable.add(path)
    const source = await Bun.file(join(distRoot, path)).text()
    for (const specifier of generatedModuleSpecifiers(path, source)) {
      if (!specifier.startsWith(".") || extname(specifier) !== ".js") continue
      const runtimeTarget = relative(distRoot, resolve(distRoot, path, "..", specifier)).replaceAll(
        "\\",
        "/"
      )
      const target = declarations
        ? `${runtimeTarget.slice(0, -extname(runtimeTarget).length)}.d.ts`
        : runtimeTarget
      if (!target.startsWith("../") && target !== ".." && files.has(target)) pending.push(target)
    }
  }
  return reachable
}

/**
 * Verifies every publishable workspace has complete, self-contained transient distribution output.
 */
export async function verifyDist(root: string): Promise<void> {
  const issues: string[] = []
  const workspaceVersions = await publishVersions(root)
  for (const workspace of await discoverWorkspaces(root)) {
    if (workspace.private) continue
    const manifestPath = workspace.manifestPath
    const workspaceRoot = resolve(root, workspace.root)
    const distRoot = join(workspaceRoot, "dist")
    if (!(await directoryExists(distRoot))) {
      issues.push(`${manifestPath}: distribution output is missing`)
      continue
    }
    const sourceManifest: unknown = await Bun.file(join(root, manifestPath)).json()
    let entries: Readonly<Record<string, string>>
    let expectedManifest: Record<string, unknown>
    try {
      entries = packageEntries(sourceManifest)
      expectedManifest = distPackageManifest(sourceManifest, workspaceVersions)
    } catch (error) {
      issues.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const expectedFiles = new Set(["LICENSE", "README.md", "package.json"])
    const entryJavaScript: string[] = []
    const entryDeclarations: string[] = []
    for (const output of Object.keys(entries)) {
      expectedFiles.add(`${output}.js`)
      expectedFiles.add(`${output}.d.ts`)
      entryJavaScript.push(`${output}.js`)
      entryDeclarations.push(`${output}.d.ts`)
    }
    const files = await distributionFiles(distRoot)
    const fileSet = new Set(files)
    for (const path of files) {
      if (expectedFiles.has(path)) continue
      if (path.includes(".min.") || (!path.endsWith(".js") && !path.endsWith(".d.ts"))) {
        issues.push(`${workspace.root}/dist/${path}: unexpected distribution file: ${path}`)
      }
    }
    for (const path of Array.from(expectedFiles).sort()) {
      if (!files.includes(path))
        issues.push(`${workspace.root}/dist/${path}: required distribution file is missing`)
    }
    if (
      files.includes("README.md") &&
      (await Bun.file(join(workspaceRoot, "README.md")).text()) !==
        (await Bun.file(join(distRoot, "README.md")).text())
    ) {
      issues.push(`${workspace.root}/dist/README.md: copied package README drifted`)
    }
    if (
      files.includes("LICENSE") &&
      (await Bun.file(join(workspaceRoot, "LICENSE")).text()) !==
        (await Bun.file(join(distRoot, "LICENSE")).text())
    ) {
      issues.push(`${workspace.root}/dist/LICENSE: copied package LICENSE drifted`)
    }
    if (files.includes("package.json")) {
      const actualManifest: unknown = await Bun.file(join(distRoot, "package.json")).json()
      if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
        issues.push(`${workspace.root}/dist/package.json: generated package manifest drifted`)
      }
    }
    const reachableJavaScript = await reachableGeneratedFiles(
      distRoot,
      entryJavaScript,
      fileSet,
      false
    )
    const reachableDeclarations = await reachableGeneratedFiles(
      distRoot,
      entryDeclarations,
      fileSet,
      true
    )
    const declarationCompanions = new Set(
      Array.from(reachableDeclarations).map((path) => `${path.slice(0, -".d.ts".length)}.js`)
    )
    for (const path of files.filter((file) => file.endsWith(".js") && !file.includes(".min."))) {
      const runtimeReachable = reachableJavaScript.has(path)
      const typeReachable = declarationCompanions.has(path)
      if (!runtimeReachable && !typeReachable) {
        issues.push(`${workspace.root}/dist/${path}: unreachable distribution JavaScript`)
        continue
      }
      const absolute = join(distRoot, path)
      if (
        !runtimeReachable &&
        (await Bun.file(absolute).text()) !== declarationCompanionSource(path)
      ) {
        issues.push(`${workspace.root}/dist/${path}: type-only companion content is invalid`)
      }
      for (const issue of await verifyGeneratedFile(
        root,
        distRoot,
        absolute,
        entryJavaScript.includes(path) || !runtimeReachable
      )) {
        issues.push(issue)
      }
    }
    for (const path of files.filter((file) => file.endsWith(".d.ts") && !file.includes(".min."))) {
      if (!reachableDeclarations.has(path)) {
        issues.push(`${workspace.root}/dist/${path}: unreachable distribution declaration`)
        continue
      }
      const absolute = join(distRoot, path)
      for (const issue of await verifyGeneratedFile(root, distRoot, absolute, true)) {
        issues.push(issue)
      }
    }
  }
  if (issues.length > 0) {
    throw new Error(`generated distribution verification failed:\n${issues.sort().join("\n")}`)
  }
}
