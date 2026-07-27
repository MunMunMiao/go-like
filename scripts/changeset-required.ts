export interface PublicPackageRelease {
  readonly name: string
  readonly root: string
  readonly version: string
}

export interface ChangesetRequirementInput {
  readonly changedPaths: readonly string[]
  readonly changedChangesetPaths: readonly string[]
  readonly publicPackages: readonly PublicPackageRelease[]
  readonly tags: readonly string[]
}

export interface ChangesetRequirement {
  readonly status: "pass" | "fail"
  readonly reason:
    | "CHANGESET_MISSING"
    | "CHANGESET_PRESENT"
    | "INITIAL_RELEASE"
    | "NO_PUBLISHABLE_CHANGES"
  readonly publishablePaths: readonly string[]
}

function publishablePath(path: string, packages: readonly PublicPackageRelease[]): boolean {
  for (const package_ of packages) {
    const root = package_.root.replace(/\/$/, "")
    if (path === `${root}/package.json` || path === `${root}/LICENSE`) return true
    if (path.startsWith(`${root}/src/`)) return true
  }
  return false
}

function activeChangesetPath(path: string): boolean {
  return /^\.changeset\/[^/]+\.md$/.test(path) && path !== ".changeset/README.md"
}

function initialRelease(
  packages: readonly PublicPackageRelease[],
  tags: readonly string[]
): boolean {
  return (
    packages.length > 0 &&
    packages.every((package_) => package_.version === "0.0.1") &&
    packages.every((package_) => !tags.some((tag) => tag.startsWith(`${package_.name}@`)))
  )
}

/** Applies the PR release-note policy to an already collected Git diff. */
export function changesetRequirement(input: ChangesetRequirementInput): ChangesetRequirement {
  const publishablePaths = Object.freeze(
    Array.from(
      new Set(input.changedPaths.filter((path) => publishablePath(path, input.publicPackages)))
    )
  )
  if (publishablePaths.length === 0) {
    return { status: "pass", reason: "NO_PUBLISHABLE_CHANGES", publishablePaths }
  }
  if (input.changedChangesetPaths.some(activeChangesetPath)) {
    return { status: "pass", reason: "CHANGESET_PRESENT", publishablePaths }
  }
  if (initialRelease(input.publicPackages, input.tags)) {
    return { status: "pass", reason: "INITIAL_RELEASE", publishablePaths }
  }
  return { status: "fail", reason: "CHANGESET_MISSING", publishablePaths }
}
