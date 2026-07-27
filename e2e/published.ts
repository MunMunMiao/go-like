import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { runCommand } from "./suites"

async function command(
  root: string,
  cwd: string,
  argv: readonly string[],
  timeoutMs = 120_000,
  signal?: AbortSignal
): Promise<string> {
  const result = await runCommand(root, { cwd, command: argv, timeoutMs, signal })
  if (result.timedOut) throw new Error(`${argv.join(" ")} exceeded ${timeoutMs}ms`)
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} exited ${result.exitCode}: ${result.stderr || result.stdout}`
    )
  }
  return result.stdout.trim()
}

async function packageRoots(root: string): Promise<readonly string[]> {
  const roots: string[] = []
  for await (const path of new Bun.Glob("packages/**/package.json").scan({
    cwd: root,
    onlyFiles: true
  })) {
    if (path.includes("/dist/") || path.includes("/node_modules/")) continue
    const manifest = await Bun.file(join(root, path)).json()
    if (manifest.private !== true) roots.push(resolve(root, path, ".."))
  }
  return Object.freeze(roots.sort())
}

export async function runPublishedE2e(root: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const stage = await realpath(await mkdtemp(join(tmpdir(), "likego-published-")))
  try {
    await cp(join(root, "e2e/fixtures/published-consumer"), stage, { recursive: true })
    const tarballRoot = join(stage, "tarballs")
    await mkdir(tarballRoot)
    const tarballs: string[] = []
    for (const packageRoot of await packageRoots(root)) {
      const output = await command(
        root,
        join(packageRoot, "dist"),
        ["bun", "pm", "pack", "--destination", tarballRoot, "--ignore-scripts", "--quiet"],
        120_000,
        signal
      )
      const tarball = output.split("\n").findLast((line) => line.trim().endsWith(".tgz"))
      if (tarball === undefined)
        throw new Error(`bun pm pack returned no tarball for ${packageRoot}`)
      tarballs.push(resolve(packageRoot, "dist", tarball.trim()))
    }

    await command(
      root,
      stage,
      [
        "npm",
        "install",
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--loglevel=error",
        ...tarballs
      ],
      300_000,
      signal
    )
    await command(
      root,
      stage,
      [resolve(root, "node_modules/.bin/tsc"), "-p", "tsconfig.json"],
      120_000,
      signal
    )
    await command(root, stage, ["bun", "bun.mjs"], 120_000, signal)
    await command(root, stage, ["node", "node.mjs"], 120_000, signal)
    await command(
      root,
      stage,
      ["deno", "run", "--allow-all", "--node-modules-dir=manual", "deno.mjs"],
      120_000,
      signal
    )
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const controller = new AbortController()
  const onSigint = () => controller.abort(new Error("published E2E interrupted by SIGINT"))
  const onSigterm = () => controller.abort(new Error("published E2E interrupted by SIGTERM"))
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    await runPublishedE2e(resolve(import.meta.dir, ".."), controller.signal)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}
