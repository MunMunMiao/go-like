import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { discoverWorkspaces } from "../tools/workspaces/discovery"
import { changesetRequirement } from "./changeset-required"
import { releasePreflight } from "./release-preflight"

const repositoryRoot = join(import.meta.dir, "..")
const changesetPath = join(repositoryRoot, "node_modules/.bin/changeset")
const roots: string[] = []
const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
] as const

const expectedChangesetConfig = {
  $schema: "https://unpkg.com/@changesets/config@3.1.4/schema.json",
  changelog: "@changesets/cli/changelog",
  commit: false,
  fixed: [],
  linked: [],
  access: "public",
  baseBranch: "main",
  updateInternalDependencies: "patch",
  bumpVersionsWithWorkspaceProtocolOnly: false,
  ignore: [],
  privatePackages: { version: false, tag: false },
  prettier: false
} as const

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function bunLockWorkspaces(
  source: string
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const parsed: unknown = JSON.parse(source.replace(/,\s*([}\]])/g, "$1"))
  const value = jsonObject(parsed, "bun.lock")
  const workspaces = jsonObject(value.workspaces, "bun.lock workspaces")
  return Object.fromEntries(
    Object.entries(workspaces).map(([root, entry]) => {
      const workspace = jsonObject(entry, `bun.lock workspace ${root}`)
      for (const field of dependencyFields) {
        if (workspace[field] !== undefined) {
          workspace[field] = jsonObject(workspace[field], `bun.lock workspace ${root} ${field}`)
        }
      }
      return [root, workspace]
    })
  )
}

async function run(
  command: readonly string[],
  cwd: string
): Promise<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}> {
  const child = Bun.spawn(Array.from(command), { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

async function requireGit(command: readonly string[], cwd: string): Promise<void> {
  const result = await run(["git", ...command], cwd)
  expect(result).toMatchObject({ exitCode: 0, stderr: "" })
}

async function releaseFixture(): Promise<{ readonly remote: string; readonly root: string }> {
  const remote = await mkdtemp(join(tmpdir(), "likego-release-remote-"))
  const root = await mkdtemp(join(tmpdir(), "likego-release-preflight-"))
  roots.push(root, remote)
  await requireGit(["init", "--bare", "--initial-branch", "main"], remote)
  await mkdir(join(root, ".changeset"), { recursive: true })
  await Bun.write(join(root, ".changeset/README.md"), "# Changesets\n")
  await Bun.write(join(root, "tracked.txt"), "clean\n")
  await requireGit(["init", "--initial-branch", "main"], root)
  await requireGit(["config", "user.name", "LikeGo Tests"], root)
  await requireGit(["config", "user.email", "likego-tests@example.invalid"], root)
  await requireGit(["config", "commit.gpgsign", "false"], root)
  await requireGit(["add", "."], root)
  await requireGit(["commit", "-m", "test: initialize release fixture"], root)
  await requireGit(["remote", "add", "origin", remote], root)
  await requireGit(["push", "--quiet", "--set-upstream", "origin", "main"], root)
  return { remote, root }
}

function releaseIssueCodes(
  issues: Awaited<ReturnType<typeof releasePreflight>>
): readonly string[] {
  return issues.map((issue) => issue.Code)
}

test("release preflight rejects dirty worktrees and unconsumed active changesets", async () => {
  const { root } = await releaseFixture()

  expect(await releasePreflight(root)).toEqual([])

  await Bun.write(join(root, "untracked.txt"), "dirty\n")
  expect(await releasePreflight(root)).toEqual([
    {
      Code: "DIRTY_WORKTREE",
      Message: "working tree contains tracked or untracked changes"
    }
  ])
  await rm(join(root, "untracked.txt"))

  await Bun.write(join(root, "tracked.txt"), "dirty\n")
  expect(await releasePreflight(root)).toEqual([
    {
      Code: "DIRTY_WORKTREE",
      Message: "working tree contains tracked or untracked changes"
    }
  ])
  await Bun.write(join(root, "tracked.txt"), "clean\n")

  await Bun.write(
    join(root, ".changeset/pending.md"),
    '---\n"@likego/core": patch\n---\n\nPending release.\n'
  )
  await requireGit(["add", ".changeset/pending.md"], root)
  await requireGit(["commit", "-m", "test: add pending changeset"], root)
  expect(await releasePreflight(root)).toEqual([
    {
      Code: "ACTIVE_CHANGESET",
      Message: "active changesets must be consumed before release: .changeset/pending.md"
    }
  ])
})

test("release preflight accepts only the refreshed origin main snapshot", async () => {
  const feature = await releaseFixture()
  await requireGit(["switch", "--quiet", "--create", "feature"], feature.root)
  expect(releaseIssueCodes(await releasePreflight(feature.root))).toContain("RELEASE_BRANCH")

  const detached = await releaseFixture()
  await requireGit(["switch", "--quiet", "--detach", "HEAD"], detached.root)
  expect(releaseIssueCodes(await releasePreflight(detached.root))).toContain("RELEASE_BRANCH")

  const ahead = await releaseFixture()
  await Bun.write(join(ahead.root, "ahead.txt"), "ahead\n")
  await requireGit(["add", "ahead.txt"], ahead.root)
  await requireGit(["commit", "-m", "test: create local ahead commit"], ahead.root)
  expect(releaseIssueCodes(await releasePreflight(ahead.root))).toEqual(["RELEASE_REMOTE"])

  const behind = await releaseFixture()
  const publisher = await mkdtemp(join(tmpdir(), "likego-release-publisher-"))
  roots.push(publisher)
  await requireGit(["clone", "--quiet", behind.remote, publisher], tmpdir())
  await requireGit(["config", "user.name", "LikeGo Tests"], publisher)
  await requireGit(["config", "user.email", "likego-tests@example.invalid"], publisher)
  await requireGit(["config", "commit.gpgsign", "false"], publisher)
  await Bun.write(join(publisher, "remote.txt"), "remote\n")
  await requireGit(["add", "remote.txt"], publisher)
  await requireGit(["commit", "-m", "test: advance remote main"], publisher)
  await requireGit(["push", "--quiet", "origin", "main"], publisher)
  expect(releaseIssueCodes(await releasePreflight(behind.root))).toEqual(["RELEASE_REMOTE"])
  const [tracking, remoteMain] = await Promise.all([
    run(["git", "rev-parse", "refs/remotes/origin/main"], behind.root),
    run(["git", "rev-parse", "main"], behind.remote)
  ])
  expect(tracking).toMatchObject({ exitCode: 0, stderr: "" })
  expect(remoteMain).toMatchObject({ exitCode: 0, stderr: "" })
  expect(tracking.stdout).toBe(remoteMain.stdout)

  const wrongUpstream = await releaseFixture()
  await requireGit(["push", "--quiet", "origin", "main:other"], wrongUpstream.root)
  await requireGit(["branch", "--set-upstream-to", "origin/other", "main"], wrongUpstream.root)
  expect(releaseIssueCodes(await releasePreflight(wrongUpstream.root))).toEqual([
    "RELEASE_UPSTREAM"
  ])

  const unreachable = await releaseFixture()
  await rm(unreachable.remote, { recursive: true, force: true })
  expect(await releasePreflight(unreachable.root)).toEqual([
    { Code: "RELEASE_REMOTE", Message: "failed to refresh origin/main" }
  ])
}, 15_000)

test("changeset requirement covers only publishable public package changes", () => {
  const publicPackages = [
    { name: "@likego/core", root: "packages/core", version: "0.0.1" }
  ] as const
  const irrelevantPaths = [
    "packages/core/README.md",
    "packages/core/test/app.test.ts",
    "packages/testing/src/index.ts",
    "examples/core/src/main.ts"
  ] as const

  expect(
    changesetRequirement({
      changedPaths: irrelevantPaths,
      changedChangesetPaths: [],
      publicPackages,
      tags: ["@likego/core@0.0.1"]
    })
  ).toEqual({ status: "pass", reason: "NO_PUBLISHABLE_CHANGES", publishablePaths: [] })

  const publishablePaths = [
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/core/LICENSE"
  ] as const
  expect(
    changesetRequirement({
      changedPaths: publishablePaths,
      changedChangesetPaths: [],
      publicPackages,
      tags: []
    })
  ).toEqual({ status: "pass", reason: "INITIAL_RELEASE", publishablePaths })
  expect(
    changesetRequirement({
      changedPaths: publishablePaths,
      changedChangesetPaths: [".changeset/public-api.md"],
      publicPackages,
      tags: ["@likego/core@0.0.1"]
    })
  ).toEqual({ status: "pass", reason: "CHANGESET_PRESENT", publishablePaths })
  expect(
    changesetRequirement({
      changedPaths: publishablePaths,
      changedChangesetPaths: [],
      publicPackages,
      tags: ["@likego/core@0.0.1"]
    })
  ).toEqual({ status: "fail", reason: "CHANGESET_MISSING", publishablePaths })
  expect(
    changesetRequirement({
      changedPaths: publishablePaths,
      changedChangesetPaths: [".changeset/README.md"],
      publicPackages,
      tags: ["@likego/core@0.0.1"]
    })
  ).toEqual({ status: "fail", reason: "CHANGESET_MISSING", publishablePaths })
  expect(
    changesetRequirement({
      changedPaths: publishablePaths,
      changedChangesetPaths: [],
      publicPackages: [{ ...publicPackages[0], version: "0.0.2" }],
      tags: []
    })
  ).toEqual({ status: "fail", reason: "CHANGESET_MISSING", publishablePaths })
})

test("pull request verification fetches release tags and checks its base commit", async () => {
  const workflow = await Bun.file(join(repositoryRoot, ".github/workflows/verify.yml")).text()
  const cli = await Bun.file(join(repositoryRoot, "scripts/changeset-required.cli.ts")).text()
  expect(workflow).toContain("fetch-depth: 0")
  expect(workflow).toContain("if: github.event_name == 'pull_request'")
  expect(workflow).toContain("LIKEGO_CHANGESET_BASE: ${{ github.event.pull_request.base.sha }}")
  expect(workflow).toContain(
    'bun scripts/changeset-required.cli.ts --base "$LIKEGO_CHANGESET_BASE"'
  )
  expect(cli).toContain('"--diff-filter=A"')
})

test("release configuration enforces dynamic semver and dist-only public publication", async () => {
  expect(await Bun.file(join(repositoryRoot, ".changeset/config.json")).json()).toEqual(
    expectedChangesetConfig
  )
  const rootManifest = jsonObject(
    await Bun.file(join(repositoryRoot, "package.json")).json(),
    "root package manifest"
  )
  expect(rootManifest).toMatchObject({
    scripts: {
      changeset: "changeset",
      "version:packages": "changeset version && bun update --filter '*'",
      release: "bun scripts/release-preflight.cli.ts && bun run verify && changeset publish"
    },
    devDependencies: {
      "@changesets/cli": "2.31.1",
      oxfmt: "0.60.0"
    }
  })
  if (typeof rootManifest.version !== "string") {
    throw new TypeError("root package manifest version must be a string")
  }
  expect(rootManifest.version).toMatch(exactSemver)

  const workspaces = await discoverWorkspaces(repositoryRoot)
  expect(workspaces.filter((workspace) => workspace.private).length).toBeGreaterThanOrEqual(40)
  expect(workspaces.filter((workspace) => !workspace.private)).toHaveLength(46)
  const releaseVersions = new Map<string, string>()
  for (const workspace of workspaces) {
    const manifest = jsonObject(
      await Bun.file(join(repositoryRoot, workspace.manifestPath)).json(),
      `${workspace.name} package manifest`
    )
    expect(manifest).toMatchObject({ name: workspace.name })
    if (workspace.private) {
      expect(manifest.version).toBeUndefined()
      expect(manifest.files).toBeUndefined()
      expect(manifest.publishConfig).toBeUndefined()
      expect(jsonObject(manifest.scripts ?? {}, `${workspace.name} scripts`).build).toBeUndefined()
    } else {
      if (typeof manifest.version !== "string") {
        throw new TypeError(`${workspace.name} package manifest version must be a string`)
      }
      expect(manifest.version).toMatch(exactSemver)
      expect(manifest.publishConfig).toEqual({ directory: "dist", access: "public" })
      releaseVersions.set(workspace.name, manifest.version)
    }
  }
  expect(releaseVersions.size).toBe(46)

  for (const workspace of workspaces) {
    const manifest = jsonObject(
      await Bun.file(join(repositoryRoot, workspace.manifestPath)).json(),
      `${workspace.name} package manifest`
    )
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      const dependencies =
        manifest[field] === undefined
          ? {}
          : jsonObject(manifest[field], `${workspace.name} ${field}`)
      for (const [name, specifier] of Object.entries(dependencies)) {
        const targetVersion = releaseVersions.get(name)
        if (targetVersion === undefined) continue
        expect(specifier).toBe(workspace.private ? "workspace:*" : targetVersion)
      }
    }
  }

  const lockWorkspaces = bunLockWorkspaces(await Bun.file(join(repositoryRoot, "bun.lock")).text())
  for (const workspace of workspaces) {
    const manifest = jsonObject(
      await Bun.file(join(repositoryRoot, workspace.manifestPath)).json(),
      `${workspace.name} package manifest`
    )
    const locked = lockWorkspaces[workspace.root]
    expect(locked).toBeDefined()
    expect(locked?.name).toBe(workspace.name)
    expect(locked?.version).toBe(manifest.version)
    for (const field of dependencyFields) {
      expect(locked?.[field] ?? {}).toEqual(manifest[field] ?? {})
    }
  }
})

test("the initial 0.0.1 release is complete and its implementation changesets cannot replay", async () => {
  const workspaces = (await discoverWorkspaces(repositoryRoot)).filter(
    (workspace) => !workspace.private
  )
  const archivedChangesets = (await readdir(join(repositoryRoot, "docs/releases/0.0.1/changesets")))
    .filter((name) => name.endsWith(".md"))
    .sort()
  const activeChangesets = (await readdir(join(repositoryRoot, ".changeset")))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
  const releaseNotes = await Bun.file(join(repositoryRoot, "docs/releases/0.0.1.md")).text()
  const releasedPackages = Array.from(
    releaseNotes.matchAll(/^- `(@likego\/[^`]+)`$/gm),
    (match) => match[1]
  ).sort()

  expect(workspaces).toHaveLength(46)
  expect(archivedChangesets).toHaveLength(53)
  expect(activeChangesets.filter((name) => archivedChangesets.includes(name))).toEqual([])
  expect(releasedPackages).toEqual(workspaces.map((workspace) => workspace.name).sort())
})

test("Changesets consumes patch and minor entries while updating exact internal dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-changesets-exact-"))
  roots.push(root)
  await mkdir(join(root, ".changeset"), { recursive: true })
  await mkdir(join(root, "docs/releases/0.0.1/changesets"), { recursive: true })
  await mkdir(join(root, "packages/dependency"), { recursive: true })
  await mkdir(join(root, "packages/consumer"), { recursive: true })
  await mkdir(join(root, "packages/feature"), { recursive: true })
  await Bun.write(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "likego-changesets-fixture",
      private: true,
      packageManager: "bun@1.3.14",
      workspaces: ["packages/*"]
    })}\n`
  )
  await Bun.write(
    join(root, ".changeset/config.json"),
    `${JSON.stringify(expectedChangesetConfig, null, 2)}\n`
  )
  await Bun.write(
    join(root, ".changeset/exact-range.md"),
    '---\n"@likego/dependency": patch\n---\n\nVerify exact dependency updates.\n'
  )
  await Bun.write(
    join(root, ".changeset/initial-minor.md"),
    '---\n"@likego/feature": minor\n---\n\nVerify pre-1.0 minor updates.\n'
  )
  await Bun.write(
    join(root, "docs/releases/0.0.1/changesets/historical-major.md"),
    '---\n"@likego/feature": major\n---\n\nArchived history must not replay.\n'
  )
  await Bun.write(
    join(root, "packages/dependency/package.json"),
    `${JSON.stringify({
      name: "@likego/dependency",
      version: "0.0.1"
    })}\n`
  )
  await Bun.write(
    join(root, "packages/consumer/package.json"),
    `${JSON.stringify({
      name: "@likego/consumer",
      version: "0.0.1",
      dependencies: { "@likego/dependency": "0.0.1" }
    })}\n`
  )
  await Bun.write(
    join(root, "packages/feature/package.json"),
    `${JSON.stringify({
      name: "@likego/feature",
      version: "0.0.1"
    })}\n`
  )

  const installed = await run([process.execPath, "install", "--lockfile-only"], root)
  expect(installed.exitCode).toBe(0)
  expect(await Bun.file(join(root, "bun.lock")).exists()).toBe(true)

  expect(await run([changesetPath, "version"], root)).toMatchObject({ exitCode: 0, stderr: "" })
  expect((await run([process.execPath, "update", "--filter", "*"], root)).exitCode).toBe(0)
  expect(await Bun.file(join(root, "packages/dependency/package.json")).json()).toMatchObject({
    version: "0.0.2"
  })
  expect(await Bun.file(join(root, "packages/consumer/package.json")).json()).toMatchObject({
    version: "0.0.2",
    dependencies: { "@likego/dependency": "0.0.2" }
  })
  expect(await Bun.file(join(root, "packages/feature/package.json")).json()).toMatchObject({
    version: "0.1.0"
  })
  expect(await Bun.file(join(root, ".changeset/exact-range.md")).exists()).toBe(false)
  expect(await Bun.file(join(root, ".changeset/initial-minor.md")).exists()).toBe(false)
  expect(
    await Bun.file(join(root, "docs/releases/0.0.1/changesets/historical-major.md")).exists()
  ).toBe(true)
  expect(await Bun.file(join(root, "packages/dependency/CHANGELOG.md")).text()).toContain("0.0.2")
  expect(await Bun.file(join(root, "packages/feature/CHANGELOG.md")).text()).toContain("0.1.0")
  const lockWorkspaces = bunLockWorkspaces(await Bun.file(join(root, "bun.lock")).text())
  expect(lockWorkspaces["packages/dependency"]?.version).toBe("0.0.2")
  expect(lockWorkspaces["packages/consumer"]?.version).toBe("0.0.2")
  expect(lockWorkspaces["packages/consumer"]?.dependencies).toEqual({
    "@likego/dependency": "0.0.2"
  })
  expect(lockWorkspaces["packages/feature"]?.version).toBe("0.1.0")
})
