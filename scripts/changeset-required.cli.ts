import { join } from "node:path"

import { discoverWorkspaces } from "../tools/workspaces/discovery"
import { changesetRequirement, type PublicPackageRelease } from "./changeset-required"

async function git(root: string, arguments_: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...arguments_], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${arguments_[0] ?? "command"} failed: ${stderr.trim()}`)
  }
  return stdout
}

function zeroSeparated(value: string): readonly string[] {
  return value.split("\0").filter((entry) => entry.length > 0)
}

function baseArgument(arguments_: readonly string[]): string {
  const base = arguments_[1]
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--base" ||
    typeof base !== "string" ||
    base.length === 0
  ) {
    throw new TypeError("usage: bun scripts/changeset-required.cli.ts --base <commit>")
  }
  return base
}

async function publicPackages(root: string): Promise<readonly PublicPackageRelease[]> {
  const packages: PublicPackageRelease[] = []
  for (const workspace of await discoverWorkspaces(root)) {
    if (workspace.private) continue
    const manifest: unknown = await Bun.file(join(root, workspace.manifestPath)).json()
    const version =
      typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
        ? (manifest as Record<string, unknown>).version
        : undefined
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest) ||
      typeof version !== "string"
    ) {
      throw new TypeError(`${workspace.manifestPath}: public package version must be a string`)
    }
    packages.push({
      name: workspace.name,
      root: workspace.root,
      version
    })
  }
  return Object.freeze(packages)
}

const root = process.cwd()
const requestedBase = baseArgument(process.argv.slice(2))
const base = (
  await git(root, ["rev-parse", "--verify", "--end-of-options", `${requestedBase}^{commit}`])
).trim()
const revision = `${base}...HEAD`
const [changedPaths, changedChangesetPaths, tags, packages] = await Promise.all([
  git(root, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z", revision, "--"]).then(
    zeroSeparated
  ),
  git(root, ["diff", "--name-only", "--diff-filter=A", "-z", revision, "--", ".changeset"]).then(
    zeroSeparated
  ),
  git(root, ["tag", "--list"]).then((value) => value.split("\n").filter((tag) => tag.length > 0)),
  publicPackages(root)
])
const result = changesetRequirement({
  changedPaths,
  changedChangesetPaths,
  publicPackages: packages,
  tags
})
console.log(
  `LIKEGO_CHANGESET_REQUIRED=${JSON.stringify({
    valid: result.status === "pass",
    reason: result.reason,
    publishablePaths: result.publishablePaths
  })}`
)
if (result.status === "fail") {
  console.error(
    `CHANGESET_MISSING public package publishable content changed without an active changeset: ${result.publishablePaths.join(", ")}`
  )
  process.exitCode = 1
}
