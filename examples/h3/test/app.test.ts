import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"
import { newNodeServer } from "@likego/web/node"

import { newHandler } from "../src/app"

test("binds H3 through the published LikeGo framework bridge", async () => {
  const response = await newHandler()(new Request("https://example.test/status"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ framework: "h3", ok: true })
})

test("declares and documents the H3 bridge as the example boundary", async () => {
  const source = await readFile(join(import.meta.dir, "../src/app.ts"), "utf8")
  const packageJson = await readFile(join(import.meta.dir, "../package.json"), "utf8")
  const readme = await readFile(join(import.meta.dir, "../README.md"), "utf8")

  expect(source).toContain('import { newH3Handler } from "@likego/h3"')
  expect(source).not.toContain("function fetch(")
  expect(packageJson).toContain('"@likego/h3": "workspace:*"')
  expect(readme).toContain("`@likego/h3`")
  expect(readme).not.toContain("不需要 H3 专用 LikeGo 包")
})

test("composes H3 into the managed Node host", () => {
  expect(typeof newNodeServer(newHandler()).start).toBe("function")
})
