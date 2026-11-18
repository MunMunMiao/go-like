import { cp, mkdtemp, rm } from "node:fs/promises"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"

import { expect, test } from "bun:test"

const dist = join(import.meta.dir, "../../dist")
const fixture = join(import.meta.dir, "fixtures/instance-load.mjs")
const marker = "go-like.core.instances"
const duplicateCode = "GO_LIKE_CORE_DUPLICATE_INSTANCE"

interface LoadResult {
  readonly loaded: readonly string[]
  readonly failed: string | null
  readonly name: string
  readonly code: string
  readonly message: string
}

function javascriptFiles(directory: string, root: string, files: Map<string, string>): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      javascriptFiles(path, root, files)
      continue
    }
    if (!entry.endsWith(".js")) continue
    files.set(
      path
        .slice(root.length + 1)
        .split("\\")
        .join("/"),
      readFileSync(path, "utf8")
    )
  }
}

function localImports(source: string): string[] {
  const specs: string[] = []
  const pattern = /(?:\bfrom|\bimport)\s*(?:\(\s*)?["'](\.[^"']+)["']/g
  for (const match of source.matchAll(pattern)) {
    const spec = match[1]
    if (spec !== undefined) specs.push(spec)
  }
  return specs
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null
  const parts = from.split("/").slice(0, -1)
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  const resolved = parts.join("/")
  return resolved.endsWith(".js") ? resolved : null
}

function reachesDetector(entry: string, files: Map<string, string>): boolean {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const source = files.get(current)
    if (source === undefined) return false
    if (source.includes(marker) && source.includes(duplicateCode)) return true
    for (const spec of localImports(source)) {
      const next = resolveSpecifier(current, spec)
      if (next !== null) pending.push(next)
    }
  }
  return false
}

function publishedEntries(distDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(distDir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>
  }
  if (manifest.exports === undefined) throw new Error("dist package.json has no exports")
  const entries: string[] = []
  for (const value of Object.values(manifest.exports)) {
    const target =
      typeof value === "string"
        ? value
        : typeof value === "object" &&
            value !== null &&
            typeof Reflect.get(value, "import") === "string"
          ? (Reflect.get(value, "import") as string)
          : ""
    if (target.startsWith("./") && target.endsWith(".js")) entries.push(target.slice(2))
  }
  return entries
}

function fileUrl(path: string): string {
  return pathToFileURL(path).href
}

async function loadIn(runtime: "bun" | "node", urls: readonly string[]): Promise<LoadResult> {
  const command =
    runtime === "bun" ? [process.execPath, fixture, ...urls] : ["node", fixture, ...urls]
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 20_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  clearTimeout(watchdog)
  if (exitCode !== 0) {
    throw new Error(
      `instance loader ${runtime} exited ${exitCode}\nstdout=${stdout}\nstderr=${stderr}`
    )
  }
  return JSON.parse(stdout) as LoadResult
}

test("built copies detect a second core instance in Bun and Node", async () => {
  expect(statSync(join(dist, "index.js")).isFile()).toBe(true)
  const files = new Map<string, string>()
  javascriptFiles(dist, dist, files)
  const entries = publishedEntries(dist)
  expect(entries.includes("index.js")).toBe(true)
  const brandEntries = [
    "index.js",
    "context/index.js",
    "metadata/index.js",
    "struct/index.js",
    "telemetry/index.js",
    "transport/index.js",
    "broker/provider.js"
  ]
  for (const entry of brandEntries) {
    expect(entries.includes(entry)).toBe(true)
    expect(reachesDetector(entry, files)).toBe(true)
  }
  const detectors = [...files.keys()].filter((path) => {
    const source = files.get(path)
    return source?.includes(marker) === true && source.includes(duplicateCode)
  })
  expect(detectors.length).toBe(1)
  const detector = detectors[0]
  if (detector === undefined) throw new Error("missing detector chunk")

  const root = await mkdtemp(join(tmpdir(), "go-like-core-instance-"))
  const copyA = join(root, "a")
  const copyB = join(root, "b")
  try {
    await cp(dist, copyA, { recursive: true })
    await cp(dist, copyB, { recursive: true })
    const positive = fileUrl(join(dist, detector))
    const shared = entries.map((entry) => fileUrl(join(copyA, entry)))
    for (const runtime of ["bun", "node"] as const) {
      const repeated = await loadIn(runtime, [positive, `${positive}?t=1`])
      expect(repeated.failed).toBeNull()
      const oneCopy = await loadIn(runtime, shared)
      expect(oneCopy.failed).toBeNull()
      const duplicate = await loadIn(runtime, [
        fileUrl(join(copyA, "index.js")),
        fileUrl(join(copyB, "index.js"))
      ])
      expect(duplicate.failed).toBe(fileUrl(join(copyB, "index.js")))
      expect(duplicate.name).toBe("CoreInstanceError")
      expect(duplicate.code).toBe(duplicateCode)
      expect(duplicate.message).toContain(basename(root))
      expect(duplicate.message).toContain("/a/")
      expect(duplicate.message).toContain("/b/")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
