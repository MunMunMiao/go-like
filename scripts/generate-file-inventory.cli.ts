import { join, relative } from "node:path"

import { collectFileInventory, renderFileInventory } from "./file-inventory"

const root = process.cwd()
const inventory = await collectFileInventory(root)
const outputPath = join(root, "docs/file-inventory.md")
const rendered = renderFileInventory(inventory)
const arguments_ = process.argv.slice(2)
const check = arguments_.length === 1 && arguments_[0] === "--check"
if (arguments_.length > 0 && !check) {
  throw new Error("usage: bun scripts/generate-file-inventory.cli.ts [--check]")
}
let valid = true
if (check) {
  valid = (await Bun.file(outputPath).exists()) && (await Bun.file(outputPath).text()) === rendered
  if (!valid) {
    console.error("LIKEGO_FILE_INVENTORY_DRIFT docs/file-inventory.md")
    process.exitCode = 1
  }
} else {
  await Bun.write(outputPath, rendered)
}
console.log(
  `LIKEGO_FILE_INVENTORY=${JSON.stringify({
    path: relative(root, outputPath),
    directories: inventory.directories.length,
    files: inventory.files.length,
    mode: check ? "check" : "write",
    valid
  })}`
)
