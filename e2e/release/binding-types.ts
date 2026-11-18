/**
 * D46 release gate.
 * A consumer with `"types": []` and an empty typeRoots compiles each binding entry's
 * built declaration. The consumer is generated outside e2e so it is not part of the
 * repository typecheck before dist exists.
 */
import { spawn } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const repoDir = fileURLToPath(new URL("../..", import.meta.url))
const bindings = [
  ["@go-like/core", "./node"],
  ["@go-like/core", "./transport/http/node"],
  ["@go-like/core", "./web/node"],
  ["@go-like/core", "./web/bun"],
  ["@go-like/core", "./config/node"],
  ["@go-like/zookeeper", "./registry/node"],
  ["@go-like/mdns", "./registry/node"],
  ["@go-like/file", "./store/node"],
  ["@go-like/connectrpc", "./node"]
] as const

interface PackageJson {
  readonly name?: unknown
  readonly exports?: unknown
}

/** Reads one package manifest. */
function readPackage(directory: string): PackageJson {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson
}

/** Maps one `./src/...ts` export onto its built declaration. */
function declarationFor(packageDir: string, exportValue: string): string {
  if (!exportValue.startsWith("./src/") || !exportValue.endsWith(".ts")) {
    throw new Error(`binding export is not a source path: ${exportValue}`)
  }
  const relative = exportValue.slice("./src/".length, -".ts".length)
  return join(packageDir, "dist", `${relative}.d.ts`)
}

/** Resolves one public export string from a package manifest. */
function exportSource(manifest: PackageJson, subpath: string): string {
  const exports = manifest.exports
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) {
    throw new Error("package exports are missing")
  }
  const value = Object.getOwnPropertyDescriptor(exports, subpath)?.value
  if (typeof value !== "string") throw new Error(`package export ${subpath} is not a source path`)
  return value
}

const packageDirs = new Map<string, string>()
for (const entry of ["core", "zookeeper", "mdns", "file", "connectrpc"]) {
  const directory = join(repoDir, "packages", entry)
  const manifest = readPackage(directory)
  if (typeof manifest.name !== "string") throw new Error(`packages/${entry} has no name`)
  packageDirs.set(manifest.name, directory)
}

const resolved: Array<{ readonly specifier: string; readonly declaration: string }> = []
for (const [name, subpath] of bindings) {
  const directory = packageDirs.get(name)
  if (directory === undefined) throw new Error(`binding package is missing: ${name}`)
  const declaration = declarationFor(directory, exportSource(readPackage(directory), subpath))
  if (!existsSync(declaration)) {
    throw new Error(`missing declaration ${declaration}; build the packages first`)
  }
  resolved.push({ specifier: `${name}${subpath.slice(1)}`, declaration })
}

const directory = mkdtempSync(join(tmpdir(), "go-like-binding-types-"))
const typeRoots = join(directory, "empty-types")
mkdirSync(typeRoots)
const imports = resolved
  .map((entry, index) => `import type * as binding${index} from "go-like-binding-${index}"`)
  .join("\n")
const members = resolved.map((_entry, index) => `  typeof binding${index}`).join(",\n")
writeFileSync(
  join(directory, "consumer.ts"),
  `${imports}\nexport type BindingModules = [\n${members}\n]\n`
)

const fromBase = (path: string): string => {
  const value = relative(directory, path)
  return value.startsWith(".") ? value : `./${value}`
}
const paths: Record<string, string[]> = {}
for (const [index, entry] of resolved.entries()) {
  paths[`go-like-binding-${index}`] = [fromBase(entry.declaration)]
}
for (const entry of readdirSync(join(repoDir, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const packageDir = join(repoDir, "packages", entry.name)
  const manifest = readPackage(packageDir)
  if (typeof manifest.name !== "string") continue
  const dist = join(packageDir, "dist")
  if (!existsSync(dist)) continue
  const root = join(dist, "index.d.ts")
  if (existsSync(root)) paths[manifest.name] = [fromBase(root)]
  paths[`${manifest.name}/*`] = [fromBase(join(dist, "*"))]
}

writeFileSync(
  join(directory, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        types: [],
        typeRoots: [typeRoots],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
        useUnknownInCatchVariables: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: false,
        noEmit: true,
        paths
      },
      files: ["consumer.ts"]
    },
    null,
    2
  )}\n`
)

let diagnostics = ""
let exitCode = 1
try {
  const tsc = join(repoDir, "node_modules/typescript/bin/tsc")
  const result = await new Promise<{ readonly code: number; readonly output: string }>(
    (resolve, reject) => {
      const child = spawn(
        "node",
        [tsc, "-p", join(directory, "tsconfig.json"), "--pretty", "false"],
        {
          cwd: directory,
          stdio: ["ignore", "pipe", "pipe"]
        }
      )
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk)
      })
      child.on("error", reject)
      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          output: `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`
        })
      })
    }
  )
  exitCode = result.code
  diagnostics = result.output.trim()
} finally {
  rmSync(directory, { recursive: true, force: true })
}

if (exitCode !== 0 || diagnostics.length > 0) {
  console.error(diagnostics.length > 0 ? diagnostics : `tsc exited ${exitCode}`)
  console.log(`binding_entries=${resolved.length} diagnostics=failed`)
  process.exitCode = 1
} else {
  console.log(`binding_entries=${resolved.length} diagnostics=0`)
  for (const entry of resolved) console.log(`${entry.specifier} ${entry.declaration}`)
}
