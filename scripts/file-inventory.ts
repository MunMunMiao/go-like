import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { discoverWorkspaces } from "../tools/workspaces/discovery"

export interface FileInventoryEntry {
  readonly path: string
  readonly workspaceRoot: string | null
}

export interface FileInventory {
  readonly directories: readonly string[]
  readonly files: readonly FileInventoryEntry[]
}

const ExcludedNames = new Set([
  ".artifacts",
  ".git",
  ".idea",
  ".superpowers",
  "coverage",
  "dist",
  "node_modules",
  "reports",
  "test-build"
])

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function OwnerFor(path: string, workspaceRoots: readonly string[]): string | null {
  for (const workspaceRoot of workspaceRoots) {
    if (path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)) return workspaceRoot
  }
  return null
}

/** Collects the canonical reviewable repository file inventory. */
export async function collectFileInventory(root: string): Promise<FileInventory> {
  const workspaces = await discoverWorkspaces(root)
  const workspaceRoots = workspaces
    .map((workspace) => workspace.root)
    .sort(
      (left, right) =>
        right.split("/").length - left.split("/").length || CompareCodeUnits(left, right)
    )
  const directories = new Set<string>(["."])
  const paths = new Set<string>()

  async function Walk(directory: string): Promise<void> {
    const entries = await readdir(join(root, directory), { withFileTypes: true })
    entries.sort((left, right) => CompareCodeUnits(left.name, right.name))
    for (const entry of entries) {
      if (
        ExcludedNames.has(entry.name) ||
        entry.name === ".DS_Store" ||
        entry.name.endsWith(".tsbuildinfo")
      ) {
        continue
      }
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        directories.add(path)
        await Walk(path)
      } else if (entry.isFile()) {
        paths.add(path)
      }
    }
  }

  await Walk("")
  paths.add("docs/file-inventory.md")
  const files = [...paths].sort(CompareCodeUnits).map((path) =>
    Object.freeze({
      path,
      workspaceRoot: OwnerFor(path, workspaceRoots)
    })
  )
  const sortedDirectories = [...directories].sort((left, right) => {
    if (left === ".") return -1
    if (right === ".") return 1
    return CompareCodeUnits(left, right)
  })
  return Object.freeze({
    directories: Object.freeze(sortedDirectories),
    files: Object.freeze(files)
  })
}

/** Renders a stable directory-grouped Markdown inventory. */
export function renderFileInventory(inventory: FileInventory): string {
  const filesByDirectory = new Map<string, string[]>()
  for (const entry of inventory.files) {
    const separator = entry.path.lastIndexOf("/")
    const directory = separator < 0 ? "." : entry.path.slice(0, separator)
    const name = separator < 0 ? entry.path : entry.path.slice(separator + 1)
    const names = filesByDirectory.get(directory) ?? []
    names.push(name)
    filesByDirectory.set(directory, names)
  }

  const lines = [
    "# LikeGo 文件交付清单",
    "",
    "本清单按目录列出仓库中可审查的真实文件。",
    "以下生成物、依赖目录、IDE 状态、Git 内部数据、覆盖率数据和私有工作流临时文件不在清单内：",
    "`.artifacts`, `.git`, `.idea`, `.superpowers`, `coverage`, `dist`, `node_modules`, `reports`, `test-build`,",
    "以及 `.DS_Store` 和 `*.tsbuildinfo`。",
    "",
    `目录数：${inventory.directories.length}。文件数：${inventory.files.length}。`,
    ""
  ]
  for (const directory of inventory.directories) {
    lines.push(`## ${directory}`, "")
    const names = filesByDirectory.get(directory) ?? []
    if (names.length === 0) lines.push("- _（当前目录无直属文件）_")
    else for (const name of names) lines.push(`- \`${name}\``)
    lines.push("")
  }
  return lines.join("\n")
}
