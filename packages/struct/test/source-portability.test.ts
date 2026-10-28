import { describe, expect, test } from "bun:test"

const srcRoot = `${import.meta.dir}/../src`

function isSourceFile(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/.test(path)
}

describe("struct source portability", () => {
  test("src does not import node: modules", async () => {
    const violations: string[] = []
    const pattern = /(?:from\s+|require\s*\(\s*)["']node:/
    const glob = new Bun.Glob("**/*")
    for await (const relative of glob.scan({ cwd: srcRoot, onlyFiles: true })) {
      if (!isSourceFile(relative)) continue
      const text = await Bun.file(`${srcRoot}/${relative}`).text()
      if (pattern.test(text)) violations.push(`packages/struct/src/${relative}`)
    }
    violations.sort()
    expect(violations, `node: imports in struct src:\n${violations.join("\n")}`).toEqual([])
  })
})
