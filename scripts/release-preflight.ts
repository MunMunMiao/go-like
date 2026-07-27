import { readdir } from "node:fs/promises"
import { join } from "node:path"

export interface ReleasePreflightIssue {
  readonly Code:
    | "ACTIVE_CHANGESET"
    | "DIRTY_WORKTREE"
    | "RELEASE_BRANCH"
    | "RELEASE_REMOTE"
    | "RELEASE_UPSTREAM"
  readonly Message: string
}

async function runGit(
  root: string,
  args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() }
}

async function gitStatus(root: string): Promise<string> {
  const result = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (result.exitCode !== 0) throw new Error("git status failed")
  return result.stdout
}

async function releaseGitIssues(root: string): Promise<readonly ReleasePreflightIssue[]> {
  const branch = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (branch.exitCode !== 0 || branch.stdout !== "main") {
    return [
      {
        Code: "RELEASE_BRANCH",
        Message:
          branch.exitCode === 0
            ? `release requires branch main, current branch is ${branch.stdout}`
            : "release requires branch main, current HEAD is detached"
      }
    ]
  }

  const upstream = await runGit(root, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}"
  ])
  if (upstream.exitCode !== 0 || upstream.stdout !== "origin/main") {
    return [
      {
        Code: "RELEASE_UPSTREAM",
        Message:
          upstream.exitCode === 0
            ? `release requires upstream origin/main, current upstream is ${upstream.stdout}`
            : "release requires upstream origin/main"
      }
    ]
  }

  const fetched = await runGit(root, ["fetch", "--quiet", "origin", "main"])
  const revisions = await Promise.all([
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, ["rev-parse", "@{upstream}"]),
    runGit(root, ["rev-parse", "refs/remotes/origin/main"])
  ])
  const failed = [
    { operation: "refresh origin/main", result: fetched },
    { operation: "resolve HEAD", result: revisions[0] },
    { operation: "resolve upstream", result: revisions[1] },
    { operation: "resolve origin/main", result: revisions[2] }
  ].find((entry) => entry.result.exitCode !== 0)
  if (failed !== undefined) {
    return [
      {
        Code: "RELEASE_REMOTE",
        Message: `failed to ${failed.operation}`
      }
    ]
  }
  if (new Set(revisions.map((result) => result.stdout)).size !== 1) {
    return [
      {
        Code: "RELEASE_REMOTE",
        Message: "HEAD, upstream, and origin/main must reference the same commit"
      }
    ]
  }
  return []
}

async function activeChangesets(root: string): Promise<readonly string[]> {
  const entries = await readdir(join(root, ".changeset"), { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => `.changeset/${entry.name}`)
    .sort()
}

/** Refuses to publish a snapshot that is not the reviewed, versioned Git tree. */
export async function releasePreflight(root: string): Promise<readonly ReleasePreflightIssue[]> {
  const issues: ReleasePreflightIssue[] = []
  if ((await gitStatus(root)).length > 0) {
    issues.push({
      Code: "DIRTY_WORKTREE",
      Message: "working tree contains tracked or untracked changes"
    })
  }
  const changesets = await activeChangesets(root)
  if (changesets.length > 0) {
    issues.push({
      Code: "ACTIVE_CHANGESET",
      Message: `active changesets must be consumed before release: ${changesets.join(", ")}`
    })
  }
  if (issues.length === 0) issues.push(...(await releaseGitIssues(root)))
  return Object.freeze(issues)
}
