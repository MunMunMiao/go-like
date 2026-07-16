import { join } from "node:path"

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

const ExpectedWorkspaces = ["packages/*", "adapters/*", "examples/*"] as const
const ExpectedRootScripts: JsonObject = {
  build: "tsc -b --pretty false",
  typecheck: "tsc -b --pretty false && tsc -p tsconfig.test.json --pretty false",
  test: "bun test --isolate --no-orphans",
  "test:coverage": "bun test --isolate --no-orphans --coverage",
  "verify:workspace": "bun scripts/verify-workspace.cli.ts",
  verify: "bun run verify:workspace && bun run typecheck && bun run test:coverage"
}
const ExpectedRootScriptNames = Object.keys(ExpectedRootScripts)
const ExpectedDevDependencies = [
  ["@types/bun", "1.3.14"],
  ["typescript", "7.0.2"]
] as const
const RequiredRootDevDependencyNames = new Set<string>(ExpectedDevDependencies.map(([name]) => name))
const RootForeignLockfiles = [
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json"
] as const
const WorkspaceLockfiles = ["bun.lock", ...RootForeignLockfiles] as const
const DependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
const ExactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ExpectedBunVersion = "1.3.14"

function JsonObjectFrom(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function NewIssue(Code: string, Path: string, Message: string): WorkspaceIssue {
  return { Code, Path, Message }
}

function RootScriptsAreExact(value: unknown): boolean {
  const scripts = JsonObjectFrom(value)
  const names = Object.keys(scripts)
  return names.length === ExpectedRootScriptNames.length
    && ExpectedRootScriptNames.every((name) => scripts[name] === ExpectedRootScripts[name])
}

export function ExactDependencySpecifier(specifier: string): boolean {
  return specifier === "workspace:*" || ExactSemver.test(specifier)
}

export function VerifyBunRuntime(observedVersion: string): WorkspaceIssue | null {
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
  workspaceNames: ReadonlySet<string>
): boolean {
  if (!ExactDependencySpecifier(specifier)) {
    return false
  }
  return workspaceNames.has(name) === (specifier === "workspace:*")
}

export async function VerifyWorkspace(root: string): Promise<readonly WorkspaceIssue[]> {
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
  if (JSON.stringify(rootManifest.workspaces) !== JSON.stringify(ExpectedWorkspaces)) {
    issues.push(NewIssue("WORKSPACES", rootManifestPath, "workspaces must exactly match the required workspace globs"))
  }
  if (!RootScriptsAreExact(rootManifest.scripts)) {
    issues.push(NewIssue("ROOT_SCRIPTS", rootManifestPath, "scripts must exactly match the required root scripts"))
  }

  const rootDevDependencies = JsonObjectFrom(rootManifest.devDependencies)
  for (const [name, version] of ExpectedDevDependencies) {
    if (rootDevDependencies[name] !== version) {
      issues.push(NewIssue("DEV_DEPENDENCY", rootManifestPath, `${name} must be exactly ${version}`))
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
        issues.push(NewIssue(
          "DEPENDENCY_SPECIFIER",
          rootManifestPath,
          `${field}.${name} must use an exact semver`
        ))
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

  const workspaceManifests: string[] = []
  const glob = new Bun.Glob("{packages,adapters,examples}/*/package.json")
  for await (const manifestPath of glob.scan({ cwd: root, onlyFiles: true })) {
    workspaceManifests.push(manifestPath)
  }
  workspaceManifests.sort()

  const workspaceManifestSnapshots: WorkspaceManifestSnapshot[] = []
  for (const Path of workspaceManifests) {
    workspaceManifestSnapshots.push({
      Path,
      Manifest: JsonObjectFrom(await Bun.file(join(root, Path)).json())
    })
  }

  const workspaceNames = new Set<string>()
  for (const { Manifest } of workspaceManifestSnapshots) {
    if (typeof Manifest.name === "string") {
      workspaceNames.add(Manifest.name)
    }
  }

  for (const { Path: manifestPath, Manifest: manifest } of workspaceManifestSnapshots) {

    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@likego/")) {
      issues.push(NewIssue("WORKSPACE_NAME", manifestPath, "name must start with @likego/"))
    }
    if (manifest.version !== "0.1.0") {
      issues.push(NewIssue("WORKSPACE_VERSION", manifestPath, "version must be 0.1.0"))
    }
    if (manifest.type !== "module") {
      issues.push(NewIssue("WORKSPACE_TYPE", manifestPath, "type must be module"))
    }
    if (!("exports" in manifest)) {
      issues.push(NewIssue("WORKSPACE_EXPORTS", manifestPath, "exports must exist"))
    }

    for (const field of DependencyFields) {
      const dependencies = JsonObjectFrom(manifest[field])
      for (const name of Object.keys(dependencies).sort()) {
        const specifier = dependencies[name]
        if (
          typeof specifier !== "string"
          || !DependencySpecifierMatchesOwnership(name, specifier, workspaceNames)
        ) {
          const expectedSpecifier = workspaceNames.has(name) ? "workspace:*" : "an exact semver"
          issues.push(NewIssue(
            "DEPENDENCY_SPECIFIER",
            manifestPath,
            `${field}.${name} must use ${expectedSpecifier}`
          ))
        }
      }
    }

    const workspaceDirectory = manifestPath.slice(0, -"/package.json".length)
    for (const lockfile of WorkspaceLockfiles) {
      const lockfilePath = `${workspaceDirectory}/${lockfile}`
      if (await Bun.file(join(root, lockfilePath)).exists()) {
        issues.push(NewIssue("FOREIGN_LOCKFILE", lockfilePath, "foreign lockfiles are not allowed"))
      }
    }
  }

  return issues
}
