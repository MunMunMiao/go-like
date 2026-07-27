import { extname, join } from "node:path"

import { discoverWorkspaces, type Workspace } from "../tools/workspaces/discovery"

export interface WorkspaceIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

type JsonObject = Readonly<Record<string, unknown>>

interface WorkspaceManifestSnapshot {
  readonly Path: string
  readonly Manifest: JsonObject
}

const ExpectedRootScripts: JsonObject = {
  changeset: "changeset",
  "version:packages": "changeset version && bun update --filter '*'",
  release: "bun scripts/release-preflight.cli.ts && bun run verify && changeset publish",
  fmt: "oxfmt .",
  "fmt:check": "oxfmt --check .",
  "doc:dev": "vitepress dev doc",
  "doc:build": "vitepress build doc",
  "doc:preview": "vitepress preview doc",
  "verify:doc": "bun test test/doc-site.test.ts && bun run doc:build",
  audit: "bun audit",
  "clean:generated": "bun scripts/clean-generated.cli.ts",
  build:
    "bun run clean:generated && bun run build:packages && bun run verify:dist && bun run build:stamp",
  "build:packages": "bun run --filter './packages/**' --sequential --if-present build",
  "build:stamp": "bun scripts/published/build-stamp.cli.ts",
  "verify:dist": "bun scripts/verify-dist.cli.ts",
  "typecheck:root":
    "tsc -p tsconfig.json --pretty false && tsc -p tsconfig.test.json --pretty false && tsc -p tsconfig.tsdown.json --pretty false",
  "typecheck:e2e": "tsc -p e2e/tsconfig.json --pretty false",
  typecheck:
    "bun run typecheck:root && bun run typecheck:e2e && bun run --workspaces --sequential typecheck && bun run build:packages",
  test: "bun test --isolate --no-orphans",
  "test:coverage": "bun test --isolate --no-orphans --coverage",
  "test:coverage:workspaces":
    "bun run --filter './packages/**' --sequential test:coverage && bun scripts/published/workspace-coverage.cli.ts",
  "test:examples": "bun run --filter '@likego/example-*' --parallel test",
  "test:examples:programs": "bun run build:packages && bun scripts/verify-example-programs.cli.ts",
  "test:examples:node":
    "bun run build:packages && bun run --filter '@likego/example-*' --parallel --if-present e2e:node:prepared",
  "test:examples:docker":
    "bun run --filter '@likego/example-*' --sequential --if-present test:docker",
  "test:transport-http:node-security":
    "bun run --filter @likego/transport-http e2e:node-security:docker",
  "test:providers:docker": "bun scripts/provider-docker-gate.cli.ts",
  "test:providers:docker:prepared":
    "bun run --filter @likego/broker-rabbitmq --filter @likego/cache-redis --filter @likego/registry-consul --filter @likego/registry-etcd --filter @likego/registry-kubernetes --filter @likego/registry-mdns --filter @likego/registry-zookeeper --filter @likego/config-kubernetes --filter @likego/config-vault --filter @likego/store-vault --sequential test:docker",
  "test:published:runtime": "bun scripts/published/cli.ts --gate runtime",
  "test:published:types": "bun scripts/published/cli.ts --gate types",
  "test:published": "bun run test:published:runtime && bun run test:published:types",
  "test:e2e:inventory": "bun e2e/run.ts --inventory",
  "test:e2e:docker-ownership":
    "LIKEGO_E2E_DOCKER_OWNERSHIP=1 bun test --isolate --no-orphans e2e/suites.test.ts",
  "test:e2e:prepared": "bun e2e/run.ts",
  "test:e2e": "bun run build && bun run test:e2e:prepared",
  "soak:http": "bun scripts/soak.cli.ts --duration 60m --output .artifacts/soak/http.json",
  "soak:check": "bun scripts/soak.cli.ts --check .artifacts/soak/http.json",
  "verify:file-inventory": "bun scripts/generate-file-inventory.cli.ts --check",
  "verify:manifests": "bun tools/manifests/check.cli.ts --mode repository --root .",
  "verify:workspace": "bun scripts/verify-workspace.cli.ts",
  verify:
    "bun run fmt:check && bun run verify:workspace && bun run verify:manifests && bun run verify:file-inventory && bun run audit && bun run clean:generated && bun run typecheck && bun run verify:dist && bun run build:stamp && bun run test:coverage && bun run test:coverage:workspaces && bun run test:examples && bun scripts/verify-example-programs.cli.ts && bun run --filter '@likego/example-*' --parallel --if-present e2e:node:prepared && bun run test:examples:docker && bun run test:e2e:docker-ownership && bun run test:transport-http:node-security && bun run test:providers:docker && bun run test:published && bun run test:e2e:prepared && bun run verify:doc"
}
const ExpectedRootScriptNames = Object.keys(ExpectedRootScripts)
const ExpectedRootOverrides: JsonObject = {
  "fast-uri": "3.1.4",
  vite: "6.4.3"
}
const ExpectedRootOverrideNames = Object.keys(ExpectedRootOverrides)
const ExpectedDevDependencies = [
  ["@babel/parser", "8.0.4"],
  ["@babel/types", "8.0.4"],
  ["@changesets/cli", "2.31.1"],
  ["@types/bun", "1.3.14"],
  ["oxfmt", "0.60.0"],
  ["tsdown", "0.22.14"],
  ["typescript", "7.0.2"],
  ["vitepress", "1.6.4"]
] as const
const RequiredRootDevDependencyNames = new Set<string>(
  ExpectedDevDependencies.map(([name]) => name)
)
const RootForeignLockfiles = [
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json"
] as const
const WorkspaceLockfiles = ["bun.lock", ...RootForeignLockfiles] as const
const DependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
] as const
const RootDevelopmentJavaScriptGlobs = ["{scripts,tools,test,e2e}/**/*.{js,jsx,mjs,cjs}"] as const
const RequiredRuntimeJavaScript = new Set(["e2e/load/k6-http.js"])
const RootDevelopmentTypeScriptGlobs = ["{scripts,tools,test,e2e}/**/*.ts"] as const
const TypeScriptTranspiler = new Bun.Transpiler({ loader: "ts" })
const ForbiddenTypeScriptSpecifierExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx"
])
const ExactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ExpectedBunVersion = "1.3.14"
const ExpectedExampleStart = "bun run --cwd ../.. build:packages && bun run start:prepared"
const ExampleReadyMarker = "LIKEGO_EXAMPLE_READY="

function JsonObjectFrom(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function NewIssue(Code: string, Path: string, Message: string): WorkspaceIssue {
  return { Code, Path, Message }
}

async function exampleProductionSources(
  root: string,
  exampleRoot: string
): Promise<readonly string[]> {
  const sources: string[] = []
  for await (const path of new Bun.Glob("src/**/*.{ts,tsx}").scan({
    cwd: join(root, exampleRoot),
    onlyFiles: true
  })) {
    if (path.endsWith(".d.ts") || path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue
    sources.push(path)
  }
  return sources.sort()
}

async function exampleTestSources(root: string, exampleRoot: string): Promise<readonly string[]> {
  const sources: string[] = []
  for await (const path of new Bun.Glob("{test,e2e}/**/*.{ts,tsx}").scan({
    cwd: join(root, exampleRoot),
    onlyFiles: true
  })) {
    sources.push(path)
  }
  return sources.sort()
}

function exampleScriptEntryPoints(script: string): readonly string[] {
  return [
    ...new Set(
      [...script.matchAll(/(?:\.\/)?src\/[A-Za-z0-9_./-]+\.tsx?\b/g)].map((match) =>
        match[0].replace(/^\.\//, "")
      )
    )
  ].sort()
}

function importsExampleMain(specifier: string): boolean {
  const withoutExtension = specifier.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/u, "")
  return withoutExtension === "#src/main" || withoutExtension.endsWith("/src/main")
}

/**
 * Verifies one private example as a directly runnable program without prescribing industry layers.
 */
export async function verifyExampleProgram(
  root: string,
  exampleRoot: string
): Promise<readonly WorkspaceIssue[]> {
  const issues: WorkspaceIssue[] = []
  const manifestPath = `${exampleRoot}/package.json`
  const manifest = JsonObjectFrom(await Bun.file(join(root, manifestPath)).json())
  const scripts = JsonObjectFrom(manifest.scripts)
  const sources = await exampleProductionSources(root, exampleRoot)
  const supportSources = sources.filter(
    (path) => path !== "src/main.ts" && path !== "src/program.ts"
  )
  const mainPath = `${exampleRoot}/src/main.ts`
  const programPath = `${exampleRoot}/src/program.ts`
  const mainExists = await Bun.file(join(root, mainPath)).exists()

  if (!mainExists || (await Bun.file(join(root, mainPath)).text()).trim().length === 0) {
    issues.push(
      NewIssue("EXAMPLE_MAIN", mainPath, "src/main.ts must be the non-empty program entry")
    )
  }
  if (await Bun.file(join(root, programPath)).exists()) {
    issues.push(
      NewIssue(
        "EXAMPLE_PROGRAM",
        programPath,
        "src/program.ts is forbidden; src/main.ts is the only program entry"
      )
    )
  }
  if (supportSources.length < 2) {
    issues.push(
      NewIssue(
        "EXAMPLE_SOURCE_SPLIT",
        `${exampleRoot}/src`,
        "examples must keep at least two production TypeScript responsibility modules beside main.ts"
      )
    )
  }
  if (scripts.start !== ExpectedExampleStart) {
    issues.push(
      NewIssue(
        "EXAMPLE_START",
        manifestPath,
        `scripts.start must be exactly ${ExpectedExampleStart}`
      )
    )
  }
  const prepared = scripts["start:prepared"]
  if (
    typeof prepared !== "string" ||
    JSON.stringify(exampleScriptEntryPoints(prepared)) !== JSON.stringify(["src/main.ts"])
  ) {
    issues.push(
      NewIssue(
        "EXAMPLE_START_PREPARED",
        manifestPath,
        "scripts.start:prepared must execute only src/main.ts"
      )
    )
  }
  if (typeof scripts.test !== "string" || scripts.test.trim().length === 0) {
    issues.push(
      NewIssue("EXAMPLE_TEST_SCRIPT", manifestPath, "scripts.test must run the example tests")
    )
  }

  if (mainExists) {
    const main = await Bun.file(join(root, mainPath)).text()
    if (!main.includes(ExampleReadyMarker)) {
      issues.push(
        NewIssue(
          "EXAMPLE_READY",
          mainPath,
          `src/main.ts must publish ${ExampleReadyMarker} after startup`
        )
      )
    }
  }
  for (const source of sources) {
    if (source === "src/main.ts") continue
    const path = `${exampleRoot}/${source}`
    if ((await Bun.file(join(root, path)).text()).includes(ExampleReadyMarker)) {
      issues.push(
        NewIssue("EXAMPLE_READY", path, `${ExampleReadyMarker} belongs only to src/main.ts`)
      )
    }
  }

  const tests = await exampleTestSources(root, exampleRoot)
  if (!tests.some((path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx"))) {
    issues.push(
      NewIssue("EXAMPLE_TESTS", `${exampleRoot}/test`, "examples must contain a TypeScript test")
    )
  }
  for (const test of tests) {
    let imports: ReturnType<Bun.Transpiler["scanImports"]>
    try {
      imports = TypeScriptTranspiler.scanImports(
        await Bun.file(join(root, exampleRoot, test)).text()
      )
    } catch {
      issues.push(
        NewIssue(
          "EXAMPLE_TEST_SCAN",
          `${exampleRoot}/${test}`,
          "example tests must be syntactically scannable"
        )
      )
      continue
    }
    if (imports.some((entry) => importsExampleMain(entry.path))) {
      issues.push(
        NewIssue(
          "EXAMPLE_TEST_IMPORT",
          `${exampleRoot}/${test}`,
          "tests must import responsibility modules instead of executing src/main.ts"
        )
      )
    }
  }

  const readmePath = `${exampleRoot}/README.md`
  const readmeFile = Bun.file(join(root, readmePath))
  if (!(await readmeFile.exists())) {
    issues.push(
      NewIssue(
        "EXAMPLE_README",
        readmePath,
        "README must explain the LikeGo capability and source responsibilities"
      )
    )
    return issues
  }
  const readme = await readmeFile.text()
  const undocumented = sources.filter((path) => {
    const localPath = path.slice("src/".length)
    return !readme.includes(path) && !readme.includes(localPath)
  })
  const packageName = typeof manifest.name === "string" ? manifest.name : ""
  const documentsRun =
    readme.includes(`bun run --filter ${packageName} start`) ||
    readme.includes(`bun run --cwd ${exampleRoot} start`)
  const documentsLikeGo = readme.includes("LikeGo") || readme.includes("@likego/")
  if (!documentsLikeGo || undocumented.length > 0 || !documentsRun) {
    issues.push(
      NewIssue(
        "EXAMPLE_README",
        readmePath,
        `README must explain LikeGo, direct running, and every source responsibility${undocumented.length === 0 ? "" : ` (missing: ${undocumented.join(", ")})`}`
      )
    )
  }
  return issues
}

function RootScriptsAreExact(value: unknown): boolean {
  const scripts = JsonObjectFrom(value)
  const names = Object.keys(scripts)
  return (
    names.length === ExpectedRootScriptNames.length &&
    ExpectedRootScriptNames.every((name) => scripts[name] === ExpectedRootScripts[name])
  )
}

function RootOverridesAreExact(value: unknown): boolean {
  const overrides = JsonObjectFrom(value)
  const names = Object.keys(overrides)
  return (
    names.length === ExpectedRootOverrideNames.length &&
    ExpectedRootOverrideNames.every((name) => overrides[name] === ExpectedRootOverrides[name])
  )
}

function ExportTargetUsesDist(value: unknown): boolean {
  if (typeof value === "string") {
    return value === "dist" || value.startsWith("./dist/") || value.includes("/dist/")
  }
  if (Array.isArray(value)) return value.some(ExportTargetUsesDist)
  if (typeof value !== "object" || value === null) return false
  return Object.values(value).some(ExportTargetUsesDist)
}

export function exactDependencySpecifier(specifier: string): boolean {
  return specifier === "workspace:*" || ExactSemver.test(specifier)
}

export function verifyBunRuntime(observedVersion: string): WorkspaceIssue | null {
  return observedVersion === ExpectedBunVersion
    ? null
    : NewIssue(
        "BUN_RUNTIME",
        "Bun.version",
        `Bun runtime must be exactly ${ExpectedBunVersion} (observed ${observedVersion})`
      )
}

function DependencySpecifierMatchesOwnership(
  name: string,
  specifier: string,
  workspaceVersions: ReadonlyMap<string, string>,
  privateWorkspaceNames: ReadonlySet<string>,
  consumerPrivate: boolean,
  field: (typeof DependencyFields)[number]
): boolean {
  if (!exactDependencySpecifier(specifier)) {
    return false
  }
  const version = workspaceVersions.get(name)
  if (version === undefined) {
    return privateWorkspaceNames.has(name)
      ? (consumerPrivate || field === "devDependencies") && specifier === "workspace:*"
      : specifier !== "workspace:*"
  }
  return consumerPrivate || field === "devDependencies"
    ? specifier === "workspace:*"
    : specifier === version
}

/**
 * Inventories handwritten JavaScript inside development source roots while excluding generated trees.
 */
function WorkspaceDevelopmentGlobs(
  workspaces: readonly Workspace[],
  suffix: string
): readonly string[] {
  return workspaces.map((workspace) => `${workspace.root}/${suffix}`)
}

async function collectHandwrittenJavaScript(
  root: string,
  workspaces: readonly Workspace[]
): Promise<readonly string[]> {
  const paths = new Set<string>()
  const patterns = [
    ...RootDevelopmentJavaScriptGlobs,
    ...WorkspaceDevelopmentGlobs(workspaces, "**/*.{js,jsx,mjs,cjs}")
  ]
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      const segments = path.split("/")
      if (
        segments.includes("dist") ||
        segments.includes(".artifacts") ||
        segments.includes("node_modules")
      ) {
        continue
      }
      if (RequiredRuntimeJavaScript.has(path)) continue
      paths.add(path)
    }
  }
  return [...paths].sort()
}

/**
 * Finds extension-bearing internal TypeScript module specifiers without matching comments or string lookalikes.
 */
async function collectRelativeImportExtensions(
  root: string,
  workspaces: readonly Workspace[]
): Promise<readonly WorkspaceIssue[]> {
  const paths = new Set<string>()
  const patterns = [
    ...RootDevelopmentTypeScriptGlobs,
    ...WorkspaceDevelopmentGlobs(workspaces, "**/*.ts")
  ]
  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
      const segments = path.split("/")
      if (
        segments.includes("dist") ||
        segments.includes(".artifacts") ||
        segments.includes("node_modules")
      ) {
        continue
      }
      if (path.startsWith("tools/") && path.includes("/fixtures/")) continue
      paths.add(path)
    }
  }
  const issues: WorkspaceIssue[] = []
  for (const path of Array.from(paths).sort()) {
    try {
      const source = await Bun.file(join(root, path)).text()
      const scannable = source.startsWith("#!")
        ? source.slice(Math.max(0, source.indexOf("\n")))
        : source
      const imports = TypeScriptTranspiler.scanImports(scannable)
      for (const imported of imports) {
        if (
          imported.path.startsWith(".") &&
          ForbiddenTypeScriptSpecifierExtensions.has(extname(imported.path))
        ) {
          issues.push(
            NewIssue(
              "RELATIVE_IMPORT_EXTENSION",
              path,
              `internal TypeScript module specifier must omit its extension: ${imported.path}`
            )
          )
        }
      }
    } catch {
      issues.push(
        NewIssue("TYPESCRIPT_SCAN", path, "development TypeScript must be syntactically scannable")
      )
    }
  }
  return issues
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function VerifyBuildReferences(
  root: string,
  workspaces: readonly Workspace[]
): Promise<WorkspaceIssue | null> {
  const path = "tsconfig.build.json"
  let value: unknown
  try {
    value = await Bun.file(join(root, path)).json()
  } catch {
    return NewIssue("BUILD_REFERENCES", path, "build references must be valid JSON")
  }
  const manifest = JsonObjectFrom(value)
  if (!Array.isArray(manifest.references)) {
    return NewIssue("BUILD_REFERENCES", path, "build references must be an array")
  }
  const observed: string[] = []
  for (const reference of manifest.references) {
    const entry = JsonObjectFrom(reference)
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      return NewIssue("BUILD_REFERENCES", path, "each build reference must declare one path")
    }
    const normalized = entry.path.replace(/^\.\//, "").replace(/\/+$/, "")
    if (normalized.length === 0 || normalized === ".." || normalized.startsWith("../")) {
      return NewIssue("BUILD_REFERENCES", path, "build references must stay inside the repository")
    }
    observed.push(normalized)
  }
  observed.sort(CompareCodeUnits)
  const expected = workspaces
    .filter((workspace) => !workspace.private)
    .map((workspace) => workspace.root)
    .sort(CompareCodeUnits)
  if (
    observed.length !== new Set(observed).size ||
    JSON.stringify(observed) !== JSON.stringify(expected)
  ) {
    return NewIssue(
      "BUILD_REFERENCES",
      path,
      "build references must exactly match canonical public workspace discovery"
    )
  }
  return null
}

async function VerifyTsdownTypecheckConfig(root: string): Promise<WorkspaceIssue | null> {
  const path = "tsconfig.tsdown.json"
  let value: unknown
  try {
    value = await Bun.file(join(root, path)).json()
  } catch {
    return NewIssue("TSDOWN_TYPECHECK_CONFIG", path, "tsdown typecheck config must be valid JSON")
  }
  const manifest = JsonObjectFrom(value)
  const compilerOptions = JsonObjectFrom(manifest.compilerOptions)
  const rootKeys = Object.keys(manifest).sort()
  const compilerKeys = Object.keys(compilerOptions).sort()
  if (
    JSON.stringify(rootKeys) !== JSON.stringify(["compilerOptions", "extends", "files"]) ||
    manifest.extends !== "./tsconfig.base.json" ||
    !Array.isArray(manifest.files) ||
    JSON.stringify(manifest.files) !== JSON.stringify(["tsdown.config.ts"]) ||
    JSON.stringify(compilerKeys) !== JSON.stringify(["noEmit", "skipLibCheck", "types"]) ||
    compilerOptions.noEmit !== true ||
    compilerOptions.skipLibCheck !== true ||
    !Array.isArray(compilerOptions.types) ||
    JSON.stringify(compilerOptions.types) !== JSON.stringify(["bun"])
  ) {
    return NewIssue(
      "TSDOWN_TYPECHECK_CONFIG",
      path,
      "tsdown config typecheck must be isolated to tsdown.config.ts with only external declarations skipped"
    )
  }
  return null
}

export async function verifyWorkspace(root: string): Promise<readonly WorkspaceIssue[]> {
  const issues: WorkspaceIssue[] = []
  const rootManifestPath = "package.json"
  const rootManifest = JsonObjectFrom(await Bun.file(join(root, rootManifestPath)).json())

  if (rootManifest.name !== "likego") {
    issues.push(NewIssue("ROOT_NAME", rootManifestPath, "name must be likego"))
  }
  if (rootManifest.private !== true) {
    issues.push(NewIssue("ROOT_PRIVATE", rootManifestPath, "private must be true"))
  }
  if (rootManifest.type !== "module") {
    issues.push(NewIssue("ROOT_TYPE", rootManifestPath, "type must be module"))
  }
  if (rootManifest.packageManager !== "bun@1.3.14") {
    issues.push(NewIssue("PACKAGE_MANAGER", rootManifestPath, "packageManager must be bun@1.3.14"))
  }
  if (typeof rootManifest.version !== "string" || !ExactSemver.test(rootManifest.version)) {
    issues.push(NewIssue("ROOT_VERSION", rootManifestPath, "version must use an exact semver"))
  }
  let workspaces: readonly Workspace[] = []
  try {
    workspaces = await discoverWorkspaces(root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    issues.push(NewIssue("WORKSPACES", rootManifestPath, message))
  }
  if (!RootScriptsAreExact(rootManifest.scripts)) {
    issues.push(
      NewIssue(
        "ROOT_SCRIPTS",
        rootManifestPath,
        "scripts must exactly match the required root scripts"
      )
    )
  }
  if (!RootOverridesAreExact(rootManifest.overrides)) {
    issues.push(
      NewIssue(
        "ROOT_OVERRIDES",
        rootManifestPath,
        "overrides must exactly match the required security resolutions"
      )
    )
  }

  const rootDevDependencies = JsonObjectFrom(rootManifest.devDependencies)
  for (const [name, version] of ExpectedDevDependencies) {
    if (rootDevDependencies[name] !== version) {
      issues.push(
        NewIssue("DEV_DEPENDENCY", rootManifestPath, `${name} must be exactly ${version}`)
      )
    }
  }

  for (const field of DependencyFields) {
    const dependencies = JsonObjectFrom(rootManifest[field])
    for (const name of Object.keys(dependencies).sort()) {
      if (field === "devDependencies" && RequiredRootDevDependencyNames.has(name)) {
        continue
      }
      const specifier = dependencies[name]
      if (typeof specifier !== "string" || !ExactSemver.test(specifier)) {
        issues.push(
          NewIssue(
            "DEPENDENCY_SPECIFIER",
            rootManifestPath,
            `${field}.${name} must use an exact semver`
          )
        )
      }
    }
  }

  if (!(await Bun.file(join(root, "bun.lock")).exists())) {
    issues.push(NewIssue("BUN_LOCK_MISSING", "bun.lock", "bun.lock must exist"))
  }
  for (const lockfile of RootForeignLockfiles) {
    if (await Bun.file(join(root, lockfile)).exists()) {
      issues.push(NewIssue("FOREIGN_LOCKFILE", lockfile, "foreign lockfiles are not allowed"))
    }
  }

  const workspaceManifestSnapshots: WorkspaceManifestSnapshot[] = []
  for (const workspace of workspaces) {
    const Path = workspace.manifestPath
    workspaceManifestSnapshots.push({
      Path,
      Manifest: JsonObjectFrom(await Bun.file(join(root, Path)).json())
    })
  }

  const buildReferenceIssue = await VerifyBuildReferences(root, workspaces)
  if (buildReferenceIssue !== null) issues.push(buildReferenceIssue)
  const tsdownTypecheckIssue = await VerifyTsdownTypecheckConfig(root)
  if (tsdownTypecheckIssue !== null) issues.push(tsdownTypecheckIssue)

  const workspaceVersions = new Map<string, string>()
  const privateWorkspaceNames = new Set<string>()
  for (const { Manifest } of workspaceManifestSnapshots) {
    if (
      Manifest.private !== true &&
      typeof Manifest.name === "string" &&
      typeof Manifest.version === "string"
    ) {
      workspaceVersions.set(Manifest.name, Manifest.version)
    }
    if (Manifest.private === true && typeof Manifest.name === "string") {
      privateWorkspaceNames.add(Manifest.name)
    }
  }

  for (const { Path: manifestPath, Manifest: manifest } of workspaceManifestSnapshots) {
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@likego/")) {
      issues.push(NewIssue("WORKSPACE_NAME", manifestPath, "name must start with @likego/"))
    }
    if (manifest.type !== "module") {
      issues.push(NewIssue("WORKSPACE_TYPE", manifestPath, "type must be module"))
    }
    const publishConfig = JsonObjectFrom(manifest.publishConfig)
    if (manifest.private === true) {
      if ("version" in manifest) {
        issues.push(NewIssue("PRIVATE_VERSION", manifestPath, "private examples must omit version"))
      }
      if ("files" in manifest) {
        issues.push(NewIssue("PRIVATE_FILES", manifestPath, "private examples must omit files"))
      }
      if (ExportTargetUsesDist(manifest.exports)) {
        issues.push(
          NewIssue(
            "PRIVATE_DIST_EXPORT",
            manifestPath,
            "private examples must not export generated dist files"
          )
        )
      }
      if ("build" in JsonObjectFrom(manifest.scripts)) {
        issues.push(
          NewIssue("PRIVATE_BUILD_SCRIPT", manifestPath, "private examples must omit build scripts")
        )
      }
      if ("publishConfig" in manifest) {
        issues.push(
          NewIssue(
            "PUBLISH_CONFIG",
            manifestPath,
            "private workspaces must not declare publishConfig"
          )
        )
      }
    } else {
      if (typeof manifest.version !== "string" || !ExactSemver.test(manifest.version)) {
        issues.push(NewIssue("WORKSPACE_VERSION", manifestPath, "version must use an exact semver"))
      }
      if (!("exports" in manifest)) {
        issues.push(NewIssue("WORKSPACE_EXPORTS", manifestPath, "exports must exist"))
      }
      if (
        Object.keys(publishConfig).length !== 2 ||
        publishConfig.directory !== "dist" ||
        publishConfig.access !== "public"
      ) {
        issues.push(
          NewIssue(
            "PUBLISH_CONFIG",
            manifestPath,
            "public workspaces must publish publicly and exactly from dist"
          )
        )
      }
    }

    for (const field of DependencyFields) {
      const dependencies = JsonObjectFrom(manifest[field])
      for (const name of Object.keys(dependencies).sort()) {
        const specifier = dependencies[name]
        if (
          typeof specifier !== "string" ||
          !DependencySpecifierMatchesOwnership(
            name,
            specifier,
            workspaceVersions,
            privateWorkspaceNames,
            manifest.private === true,
            field
          )
        ) {
          const workspaceVersion = workspaceVersions.get(name)
          const expectedSpecifier = privateWorkspaceNames.has(name)
            ? "workspace:* from a private workspace or devDependencies"
            : workspaceVersion === undefined
              ? "an exact semver"
              : manifest.private === true || field === "devDependencies"
                ? "workspace:*"
                : `the exact workspace version ${workspaceVersion}`
          issues.push(
            NewIssue(
              "DEPENDENCY_SPECIFIER",
              manifestPath,
              `${field}.${name} must use ${expectedSpecifier}`
            )
          )
        }
      }
    }

    const workspaceDirectory = manifestPath.slice(0, -"/package.json".length)
    if (
      manifest.private === true &&
      typeof manifest.name === "string" &&
      manifest.name.startsWith("@likego/example-") &&
      workspaceDirectory.startsWith("examples/")
    ) {
      issues.push(...(await verifyExampleProgram(root, workspaceDirectory)))
    }
    for (const lockfile of WorkspaceLockfiles) {
      const lockfilePath = `${workspaceDirectory}/${lockfile}`
      if (await Bun.file(join(root, lockfilePath)).exists()) {
        issues.push(NewIssue("FOREIGN_LOCKFILE", lockfilePath, "foreign lockfiles are not allowed"))
      }
    }
  }

  for (const path of await collectHandwrittenJavaScript(root, workspaces)) {
    issues.push(
      NewIssue(
        "HANDWRITTEN_JAVASCRIPT",
        path,
        "development sources must be TypeScript; JavaScript is allowed only as generated output"
      )
    )
  }

  for (const issue of await collectRelativeImportExtensions(root, workspaces)) {
    issues.push(issue)
  }

  return issues
}
