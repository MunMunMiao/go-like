import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, symlink, unlink } from "node:fs/promises"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"

import { discoverWorkspaces } from "./discovery"

const Roots: string[] = []

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function Repository(workspaces: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-workspace-discovery-"))
  Roots.push(root)
  await Bun.write(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "likego-workspace-fixture",
      private: true,
      workspaces
    })}\n`
  )
  return root
}

async function WriteWorkspace(
  root: string,
  location: string,
  name: string,
  privatePackage = false
): Promise<void> {
  await mkdir(join(root, location), { recursive: true })
  await Bun.write(
    join(root, location, "package.json"),
    `${JSON.stringify({
      name,
      private: privatePackage
    })}\n`
  )
}

async function WithWorkspaceGlob(
  scan: () => AsyncGenerator<string>,
  run: () => Promise<void>
): Promise<void> {
  const OriginalGlob = Bun.Glob
  const FixtureGlob = class {
    scan(): AsyncGenerator<string> {
      return scan()
    }
  }
  Object.defineProperty(Bun, "Glob", { value: FixtureGlob })
  try {
    await run()
  } finally {
    Object.defineProperty(Bun, "Glob", { value: OriginalGlob })
  }
}

test("discovers sorted frozen direct and nested workspaces with overlapping globs deduplicated", async () => {
  const root = await Repository([
    "packages/*",
    "packages/config/*",
    "packages/config/consul",
    "packages/registry/mdns",
    "packages/transport/http",
    "examples/*"
  ])
  await WriteWorkspace(root, "packages/config", "@likego/config")
  await WriteWorkspace(root, "packages/config/consul", "@likego/config-consul")
  await WriteWorkspace(root, "packages/registry", "@likego/registry")
  await WriteWorkspace(root, "packages/registry/mdns", "@likego/registry-mdns")
  await WriteWorkspace(root, "packages/transport", "@likego/transport")
  await WriteWorkspace(root, "packages/transport/http", "@likego/transport-http")
  await WriteWorkspace(root, "examples/demo", "@likego/example-demo", true)

  const workspaces = await discoverWorkspaces(root)

  expect(workspaces.map((workspace) => workspace.root)).toEqual([
    "examples/demo",
    "packages/config",
    "packages/config/consul",
    "packages/registry",
    "packages/registry/mdns",
    "packages/transport",
    "packages/transport/http"
  ])
  expect(workspaces.map((workspace) => workspace.manifestPath)).toEqual(
    workspaces.map((workspace) => `${workspace.root}/package.json`)
  )
  expect(workspaces.map((workspace) => workspace.private)).toEqual([
    true,
    false,
    false,
    false,
    false,
    false,
    false
  ])
  expect(Object.isFrozen(workspaces)).toBe(true)
  expect(workspaces.every((workspace) => Object.isFrozen(workspace))).toBe(true)
})

test("fails closed for duplicate package names and malformed workspace manifests", async () => {
  const duplicateRoot = await Repository(["packages/*"])
  await WriteWorkspace(duplicateRoot, "packages/one", "@likego/duplicate")
  await WriteWorkspace(duplicateRoot, "packages/two", "@likego/duplicate")
  await expect(discoverWorkspaces(duplicateRoot)).rejects.toThrow(
    "duplicate workspace package name"
  )

  const malformedRoot = await Repository(["packages/*"])
  await mkdir(join(malformedRoot, "packages/broken"), { recursive: true })
  await Bun.write(join(malformedRoot, "packages/broken/package.json"), "{\n")
  await expect(discoverWorkspaces(malformedRoot)).rejects.toThrow(
    "workspace manifest must be valid JSON"
  )

  const missingRoot = await Repository(["packages/*"])
  await mkdir(join(missingRoot, "packages/missing"), { recursive: true })
  await expect(discoverWorkspaces(missingRoot)).rejects.toThrow("workspace manifest is missing")

  const irregularRoot = await Repository(["packages/*"])
  await mkdir(join(irregularRoot, "packages/irregular/package.json"), { recursive: true })
  await expect(discoverWorkspaces(irregularRoot)).rejects.toThrow(
    "workspace manifest must be a regular file"
  )

  const unnamedRoot = await Repository(["packages/*"])
  await WriteWorkspace(unnamedRoot, "packages/unnamed", "@likego/unnamed")
  await Bun.write(join(unnamedRoot, "packages/unnamed/package.json"), "{}\n")
  await expect(discoverWorkspaces(unnamedRoot)).rejects.toThrow(
    "workspace manifest must declare a non-empty name"
  )

  const invalidPrivateRoot = await Repository(["packages/*"])
  await WriteWorkspace(invalidPrivateRoot, "packages/private", "@likego/private")
  await Bun.write(
    join(invalidPrivateRoot, "packages/private/package.json"),
    JSON.stringify({
      name: "@likego/private",
      private: "false"
    })
  )
  await expect(discoverWorkspaces(invalidPrivateRoot)).rejects.toThrow(
    "workspace manifest private must be boolean"
  )

  const malformedRepositoryRoot = await Repository(["packages/*"])
  await Bun.write(join(malformedRepositoryRoot, "package.json"), "{\n")
  await expect(discoverWorkspaces(malformedRepositoryRoot)).rejects.toThrow(
    "root package manifest must be valid JSON"
  )
})

test("fails closed for invalid root workspace declarations", async () => {
  const objectRoot = await Repository({ packages: ["packages/*"] })
  await expect(discoverWorkspaces(objectRoot)).rejects.toThrow(
    "root workspaces must be a non-empty string array"
  )

  const mixedRoot = await Repository(["packages/*", 1])
  await expect(discoverWorkspaces(mixedRoot)).rejects.toThrow(
    "root workspaces must be a non-empty string array"
  )

  const broadRoot = await Repository(["packages/**"])
  await expect(discoverWorkspaces(broadRoot)).rejects.toThrow(
    "recursive workspace globs are not allowed"
  )

  const absoluteRoot = await Repository([join(tmpdir(), "packages/*")])
  await expect(discoverWorkspaces(absoluteRoot)).rejects.toThrow(
    "workspace glob must be repository-relative"
  )

  const windowsAbsoluteRoot = await Repository(["C:/outside/packages/*"])
  await expect(discoverWorkspaces(windowsAbsoluteRoot)).rejects.toThrow(
    "workspace glob must be repository-relative"
  )

  const windowsDriveRelativeRoot = await Repository(["C:outside/packages/*"])
  await expect(discoverWorkspaces(windowsDriveRelativeRoot)).rejects.toThrow(
    "workspace glob must be repository-relative"
  )

  const windowsUncRoot = await Repository(["\\\\server\\share\\packages\\*"])
  await expect(discoverWorkspaces(windowsUncRoot)).rejects.toThrow(
    "workspace glob must be repository-relative"
  )
})

test("fails closed when a workspace pattern matches no directory", async () => {
  const literalRoot = await Repository(["packages/missing"])
  await expect(discoverWorkspaces(literalRoot)).rejects.toThrow(
    "workspace glob did not match a directory"
  )

  const wildcardRoot = await Repository(["packages/*"])
  await expect(discoverWorkspaces(wildcardRoot)).rejects.toThrow(
    "root workspaces must discover at least one directory"
  )

  const fileRoot = await Repository(["packages/*"])
  await mkdir(join(fileRoot, "packages"), { recursive: true })
  await Bun.write(join(fileRoot, "packages/not-a-directory"), "fixture\n")
  await expect(discoverWorkspaces(fileRoot)).rejects.toThrow(
    "root workspaces must discover at least one directory"
  )
})

test("rejects malformed glob syntax without rejecting an optional empty wildcard family", async () => {
  const malformedBracketRoot = await Repository(["packages/one", "packages/missing]"])
  await WriteWorkspace(malformedBracketRoot, "packages/one", "@likego/one")
  await expect(discoverWorkspaces(malformedBracketRoot)).rejects.toThrow(
    "workspace glob syntax is invalid"
  )

  const malformedBraceRoot = await Repository(["packages/one", "packages/{missing"])
  await WriteWorkspace(malformedBraceRoot, "packages/one", "@likego/one")
  await expect(discoverWorkspaces(malformedBraceRoot)).rejects.toThrow(
    "workspace glob syntax is invalid"
  )

  for (const pattern of [
    "packages/{one,[broken}",
    "packages/{one,broken[}",
    "packages/{one,broken]}",
    "packages/{one,}",
    "packages/{one,,two}",
    "packages/{one,{two,three}}",
    "packages/{1..2..3..4,one}",
    "packages/{one}"
  ]) {
    const malformedAlternativeRoot = await Repository([pattern])
    await WriteWorkspace(malformedAlternativeRoot, "packages/one", "@likego/one")
    await expect(discoverWorkspaces(malformedAlternativeRoot)).rejects.toThrow(
      "workspace glob syntax is invalid"
    )
  }

  const optionalRoot = await Repository(["packages/one", "adapters/*"])
  await WriteWorkspace(optionalRoot, "packages/one", "@likego/one")
  await expect(discoverWorkspaces(optionalRoot)).resolves.toEqual([
    {
      root: "packages/one",
      manifestPath: "packages/one/package.json",
      name: "@likego/one",
      private: false
    }
  ])
})

test("rejects unsafe brace alternatives even when another alternative matches", async () => {
  for (const pattern of [
    "packages/{context,C:outside}",
    "packages/{context,..}",
    "packages/{context,/outside}",
    "packages/{context,one..C:outside}"
  ]) {
    const root = await Repository([pattern])
    await WriteWorkspace(root, "packages/context", "@likego/context")
    await expect(discoverWorkspaces(root)).rejects.toThrow(
      /repository-relative|escapes repository root/
    )
  }
})

test("accepts brace alternatives whose bracket class contains range-like text", async () => {
  const root = await Repository(["packages/{[a..z..0..9],core}"])
  await WriteWorkspace(root, "packages/a", "@likego/a")
  await WriteWorkspace(root, "packages/core", "@likego/core")

  await expect(discoverWorkspaces(root)).resolves.toEqual([
    {
      root: "packages/a",
      manifestPath: "packages/a/package.json",
      name: "@likego/a",
      private: false
    },
    {
      root: "packages/core",
      manifestPath: "packages/core/package.json",
      name: "@likego/core",
      private: false
    }
  ])
})

test("expands brace path alternatives into scan-safe workspace patterns", async () => {
  const root = await Repository(["packages/{a/b,c}"])
  await WriteWorkspace(root, "packages/a/b", "@likego/a-b")
  await WriteWorkspace(root, "packages/c", "@likego/c")

  await expect(discoverWorkspaces(root)).resolves.toEqual([
    {
      root: "packages/a/b",
      manifestPath: "packages/a/b/package.json",
      name: "@likego/a-b",
      private: false
    },
    {
      root: "packages/c",
      manifestPath: "packages/c/package.json",
      name: "@likego/c",
      private: false
    }
  ])
})

test("rejects brace ranges that Bun workspace scanning cannot discover", async () => {
  const root = await Repository(["fallback", "packages/{1..3}"])
  await WriteWorkspace(root, "fallback", "@likego/fallback")
  await WriteWorkspace(root, "packages/1", "@likego/one")

  await expect(discoverWorkspaces(root)).rejects.toThrow("workspace glob syntax is invalid")
})

test("accepts Bun bracket classes with leading closing and literal opening brackets", async () => {
  const leadingClosingRoot = await Repository(["packages/{[]a],core}"])
  await WriteWorkspace(leadingClosingRoot, "packages/]", "@likego/closing-bracket")
  await WriteWorkspace(leadingClosingRoot, "packages/a", "@likego/a")
  await WriteWorkspace(leadingClosingRoot, "packages/core", "@likego/core")
  await expect(discoverWorkspaces(leadingClosingRoot)).resolves.toEqual([
    {
      root: "packages/]",
      manifestPath: "packages/]/package.json",
      name: "@likego/closing-bracket",
      private: false
    },
    {
      root: "packages/a",
      manifestPath: "packages/a/package.json",
      name: "@likego/a",
      private: false
    },
    {
      root: "packages/core",
      manifestPath: "packages/core/package.json",
      name: "@likego/core",
      private: false
    }
  ])

  const closingOnlyRoot = await Repository(["packages/[]]"])
  await WriteWorkspace(closingOnlyRoot, "packages/]", "@likego/closing-only")
  await expect(discoverWorkspaces(closingOnlyRoot)).resolves.toEqual([
    {
      root: "packages/]",
      manifestPath: "packages/]/package.json",
      name: "@likego/closing-only",
      private: false
    }
  ])

  const literalOpeningRoot = await Repository(["packages/[[]"])
  await WriteWorkspace(literalOpeningRoot, "packages/[", "@likego/opening-bracket")
  await expect(discoverWorkspaces(literalOpeningRoot)).resolves.toEqual([
    {
      root: "packages/[",
      manifestPath: "packages/[/package.json",
      name: "@likego/opening-bracket",
      private: false
    }
  ])
})

test("fails closed for workspace symlinks and root escape patterns", async () => {
  const root = await Repository(["packages/*"])
  const outside = await mkdtemp(join(tmpdir(), "likego-workspace-outside-"))
  Roots.push(outside)
  await WriteWorkspace(outside, ".", "@likego/outside")
  await mkdir(join(root, "packages"), { recursive: true })
  await symlink(outside, join(root, "packages/linked"))
  await expect(discoverWorkspaces(root)).rejects.toThrow("workspace root must not be symbolic link")

  const escapeRoot = await Repository([`../${basename(outside)}`])
  await expect(discoverWorkspaces(escapeRoot)).rejects.toThrow(
    "workspace glob escapes repository root"
  )
})

test("fails closed when a matched workspace becomes a regular file after scanning", async () => {
  const root = await Repository(["packages/*"])
  await WriteWorkspace(root, "packages/changing", "@likego/changing")

  await WithWorkspaceGlob(
    async function* () {
      yield "packages/changing"
      await rm(join(root, "packages/changing"), { recursive: true })
      await Bun.write(join(root, "packages/changing"), "not a directory\n")
    },
    async () => {
      await expect(discoverWorkspaces(root)).rejects.toThrow("workspace root must be a directory")
    }
  )
})

test("fails closed when the repository root moves outside its resolved boundary after scanning", async () => {
  const root = await Repository(["packages/*"])
  await WriteWorkspace(root, "packages/changing", "@likego/original")
  const outside = await mkdtemp(join(tmpdir(), "likego-workspace-replacement-"))
  const movedRoot = `${root}-moved`
  Roots.push(outside)
  await WriteWorkspace(outside, "packages/changing", "@likego/replacement")

  await WithWorkspaceGlob(
    async function* () {
      yield "packages/changing"
      await rename(root, movedRoot)
      await symlink(outside, root)
    },
    async () => {
      try {
        await expect(discoverWorkspaces(root)).rejects.toThrow(
          "workspace root escapes repository root"
        )
      } finally {
        await unlink(root)
        await rename(movedRoot, root)
      }
    }
  )
})

test("fails closed when a workspace scanner returns a repository escape", async () => {
  const root = await Repository(["packages/*"])

  await WithWorkspaceGlob(
    async function* () {
      yield "../outside"
    },
    async () => {
      await expect(discoverWorkspaces(root)).rejects.toThrow(
        "workspace glob escapes repository root"
      )
    }
  )
})
