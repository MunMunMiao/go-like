import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { collectFileInventory, renderFileInventory } from "./file-inventory"

const Roots: string[] = []
const InventoryCliPath = fileURLToPath(new URL("./generate-file-inventory.cli.ts", import.meta.url))

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("file inventory fails closed when a declared workspace is a symbolic link", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-file-inventory-"))
  const outside = await mkdtemp(join(tmpdir(), "likego-file-inventory-outside-"))
  Roots.push(root, outside)
  await mkdir(join(root, "packages"), { recursive: true })
  await mkdir(join(root, "docs"), { recursive: true })
  await Bun.write(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "likego-file-inventory-fixture",
      private: true,
      workspaces: ["packages/*"]
    })}\n`
  )
  await Bun.write(
    join(outside, "package.json"),
    `${JSON.stringify({
      name: "@likego/linked",
      private: false
    })}\n`
  )
  await symlink(outside, join(root, "packages/linked"))

  const subprocess = Bun.spawn({
    cmd: [process.execPath, InventoryCliPath, "--check"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text()
  ])

  expect(exitCode).toBe(1)
  expect(stderr).toContain("workspace root must not be symbolic link")
})

test("file inventory assigns parent and child files to the deepest canonical workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-file-inventory-ownership-"))
  Roots.push(root)
  await mkdir(join(root, "packages/config/consul/src"), { recursive: true })
  await mkdir(join(root, "packages/config/src"), { recursive: true })
  await Bun.write(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "likego-file-inventory-fixture",
      private: true,
      workspaces: ["packages/*", "packages/config/consul"]
    })}\n`
  )
  await Bun.write(join(root, "packages/config/package.json"), '{"name":"@likego/config"}\n')
  await Bun.write(
    join(root, "packages/config/consul/package.json"),
    '{"name":"@likego/config-consul"}\n'
  )
  await Bun.write(join(root, "packages/config/src/index.ts"), "export const parent = true\n")
  await Bun.write(join(root, "packages/config/consul/src/index.ts"), "export const child = true\n")
  await Bun.write(join(root, "README.md"), "# fixture\n")

  const inventory = await collectFileInventory(root)
  const ownership = new Map(inventory.files.map((entry) => [entry.path, entry.workspaceRoot]))

  expect(ownership.get("README.md")).toBeNull()
  expect(ownership.get("packages/config/src/index.ts")).toBe("packages/config")
  expect(ownership.get("packages/config/consul/src/index.ts")).toBe("packages/config/consul")
  expect(inventory.files.filter((entry) => entry.path.endsWith("src/index.ts"))).toHaveLength(2)
  expect(Object.isFrozen(inventory)).toBe(true)
  expect(Object.isFrozen(inventory.files)).toBe(true)
  expect(inventory.files.every((entry) => Object.isFrozen(entry))).toBe(true)
})

test("file inventory renders root nested and empty directories deterministically", () => {
  expect(
    renderFileInventory({
      directories: [".", "empty", "nested"],
      files: [
        { path: "README.md", workspaceRoot: null },
        { path: "nested/index.ts", workspaceRoot: "nested" }
      ]
    })
  ).toBe(
    [
      "# LikeGo 文件交付清单",
      "",
      "本清单按目录列出仓库中可审查的真实文件。",
      "以下生成物、依赖目录、IDE 状态、Git 内部数据、覆盖率数据和私有工作流临时文件不在清单内：",
      "`.artifacts`, `.git`, `.idea`, `.superpowers`, `coverage`, `dist`, `node_modules`, `reports`, `test-build`,",
      "以及 `.DS_Store` 和 `*.tsbuildinfo`。",
      "",
      "目录数：3。文件数：2。",
      "",
      "## .",
      "",
      "- `README.md`",
      "",
      "## empty",
      "",
      "- _（当前目录无直属文件）_",
      "",
      "## nested",
      "",
      "- `index.ts`",
      ""
    ].join("\n")
  )
})
