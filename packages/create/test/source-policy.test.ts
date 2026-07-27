import { readFile } from "node:fs/promises"

import { expect, test } from "bun:test"

import { projectFiles } from "../src/templates"

test("generates only the reviewed internal unary stack without speculative tooling", () => {
  const files = projectFiles("policy-service", {
    "@likego/core": "9.8.7",
    "@likego/server": "9.8.7",
    "@likego/transport": "9.8.7",
    "@likego/transport-http": "9.8.7"
  })
  const source = files.map((file) => file.content).join("\n")
  expect(files.map((file) => file.path)).toEqual([
    ".gitignore",
    "package.json",
    "tsconfig.json",
    "README.md",
    "src/contract.ts",
    "src/service.ts",
    "src/main.ts",
    "test/service.test.ts"
  ])
  expect(source).toContain('"@likego/core": "9.8.7"')
  expect(source).toContain('"@likego/server": "9.8.7"')
  expect(source).toContain('"@likego/transport": "9.8.7"')
  expect(source).toContain('"@likego/transport-http": "9.8.7"')
  expect(source).toContain('import { jsonCodec } from "@likego/transport/json"')
  expect(source).not.toContain("type BodyCodec")
  expect(source).not.toContain("@likego/web")
  expect(source).not.toContain("git init")
  expect(source).not.toContain("Docker")
  expect(source).not.toContain("proto")
  expect(source).not.toContain("fetch(")
})

test("keeps the create implementation on explicit local Node filesystem APIs", async () => {
  const project = await readFile(`${import.meta.dir}/../src/project.ts`, "utf8")
  const cli = await readFile(`${import.meta.dir}/../src/cli-run.ts`, "utf8")
  expect(project).toContain('from "node:fs/promises"')
  expect(project).toContain("await filesystem.mkdir(identity.directory)")
  expect(project).not.toContain("filesystem.rm(")
  expect(project).not.toContain("rename(")
  expect(cli).not.toContain("readline")
  expect(cli).not.toContain("fetch(")
})
