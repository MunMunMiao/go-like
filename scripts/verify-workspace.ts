import { join } from "node:path"

export interface WorkspaceIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

type JsonObject = Readonly<Record<string, unknown>>

const ExpectedWorkspaces = ["packages/*", "adapters/*", "examples/*"] as const
const ExpectedDevDependencies = [
  ["@types/bun", "1.3.14"],
  ["typescript", "7.0.2"]
] as const
const ForeignLockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"] as const
const DependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
const ExactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function JsonObjectFrom(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function NewIssue(Code: string, Path: string, Message: string): WorkspaceIssue {
  return { Code, Path, Message }
}

export function ExactDependencySpecifier(specifier: string): boolean {
  return specifier === "workspace:*" || ExactSemver.test(specifier)
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

  const rootDevDependencies = JsonObjectFrom(rootManifest.devDependencies)
  for (const [name, version] of ExpectedDevDependencies) {
    if (rootDevDependencies[name] !== version) {
      issues.push(NewIssue("DEV_DEPENDENCY", rootManifestPath, `${name} must be exactly ${version}`))
    }
  }

  if (!(await Bun.file(join(root, "bun.lock")).exists())) {
    issues.push(NewIssue("BUN_LOCK_MISSING", "bun.lock", "bun.lock must exist"))
  }
  for (const lockfile of ForeignLockfiles) {
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

  for (const manifestPath of workspaceManifests) {
    const manifest = JsonObjectFrom(await Bun.file(join(root, manifestPath)).json())

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
        if (typeof specifier !== "string" || !ExactDependencySpecifier(specifier)) {
          issues.push(NewIssue(
            "DEPENDENCY_SPECIFIER",
            manifestPath,
            `${field}.${name} must use an exact semver or workspace:*`
          ))
        }
      }
    }
  }

  return issues
}
