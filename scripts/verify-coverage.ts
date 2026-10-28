import { relative, resolve } from "node:path"

interface Manifest {
  scripts?: Record<string, string>
  workspaces?: string[]
}

const root = resolve(process.argv[2] ?? process.cwd())
const transpiler = new Bun.Transpiler({ loader: "ts" })

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"))
}

async function manifests(): Promise<Map<string, Manifest>> {
  const rootManifest = (await Bun.file(resolve(root, "package.json")).json()) as Manifest
  if (!Array.isArray(rootManifest.workspaces))
    throw new Error("root package.json must declare workspaces")

  const found = new Map<string, Manifest>()
  for (const workspace of rootManifest.workspaces) {
    const glob = new Bun.Glob(`${workspace}/package.json`)
    for await (const path of glob.scan({ absolute: true, cwd: root, onlyFiles: true })) {
      found.set(resolve(path, ".."), (await Bun.file(path).json()) as Manifest)
    }
  }
  return found
}

async function sources(): Promise<string[]> {
  const found = new Set<string>()
  for (const pattern of [
    "packages/**/src/**/*.ts",
    "packages/**/src/**/*.mts",
    "packages/**/src/**/*.cts",
    "examples/**/src/**/*.ts",
    "examples/**/src/**/*.mts",
    "examples/**/src/**/*.cts"
  ]) {
    for await (const path of new Bun.Glob(pattern).scan({
      absolute: true,
      cwd: root,
      onlyFiles: true
    })) {
      found.add(resolve(path))
    }
  }
  return [...found].sort()
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`
}

async function verify(): Promise<void> {
  const workspaceManifests = await manifests()
  const inventory = await sources()
  const typeOnly: string[] = []
  const compositionRoots: string[] = []
  const executable: string[] = []

  for (const path of inventory) {
    const repositoryPath = relative(root, path).replaceAll("\\", "/")
    if (
      /\.d\.(?:ts|mts|cts)$/.test(path) ||
      transpiler.transformSync(await Bun.file(path).text()).trim() === ""
    ) {
      typeOnly.push(path)
    } else if (/^examples\/[^/]+\/src\/main\.ts$/.test(repositoryPath)) {
      compositionRoots.push(path)
    } else {
      executable.push(path)
    }
  }

  for (const path of compositionRoots) {
    const directory = resolve(path, "../..")
    const manifest = workspaceManifests.get(directory)
    if (!manifest || !manifest.scripts?.["test:e2e"]) {
      throw new Error(
        `${relative(root, path)} requires one workspace manifest with a test:e2e script`
      )
    }
  }
  for (const [directory, manifest] of workspaceManifests) {
    if (!/^examples\/[^/]+$/.test(relative(root, directory).replaceAll("\\", "/"))) continue
    const roots = compositionRoots.filter((path) => resolve(path, "../..") === directory)
    if (roots.length !== 1) {
      throw new Error(
        `${relative(root, resolve(directory, "package.json"))} requires exactly one src/main.ts composition root`
      )
    }
    if (!manifest.scripts?.["test:e2e"]) {
      throw new Error(
        `${relative(root, roots[0])} requires one workspace manifest with a test:e2e script`
      )
    }
  }

  const coverageWorkspaces = [...workspaceManifests].filter(
    ([, manifest]) => manifest.scripts?.["test:unit:coverage"]
  )
  const records = new Map<string, string>()

  for (const [directory] of coverageWorkspaces) {
    const report = resolve(directory, ".artifacts/coverage/lcov.info")
    const text = await Bun.file(report).text()
    if (!text.trim() || !text.trimEnd().endsWith("end_of_record")) {
      throw new Error(`${relative(root, report)} contains an incomplete LCOV record`)
    }
    for (const block of text.split("end_of_record")) {
      if (!block.trim()) continue
      const fields = new Map<string, string[]>()
      for (const line of block.trim().split(/\r?\n/)) {
        const separator = line.indexOf(":")
        if (separator < 0)
          throw new Error(`${relative(root, report)} contains a malformed LCOV line: ${line}`)
        const key = line.slice(0, separator)
        const values = fields.get(key) ?? []
        values.push(line.slice(separator + 1))
        fields.set(key, values)
      }

      const source = fields.get("SF")
      const lf = fields.get("LF")
      const lh = fields.get("LH")
      const fnf = fields.get("FNF")
      const fnh = fields.get("FNH")
      if (
        source?.length !== 1 ||
        lf?.length !== 1 ||
        lh?.length !== 1 ||
        fnf?.length !== 1 ||
        fnh?.length !== 1
      ) {
        throw new Error(`${relative(root, report)} contains an incomplete LCOV record`)
      }

      const sourcePath = resolve(directory, source[0])
      if (
        !inside(root, sourcePath) ||
        !inside(directory, sourcePath) ||
        !inventory.includes(sourcePath)
      ) {
        throw new Error(
          `${relative(root, report)} references a source outside the production inventory: ${source[0]}`
        )
      }
      if (records.has(sourcePath))
        throw new Error(`duplicate LCOV source record: ${relative(root, sourcePath)}`)
      const summaries = [lf[0], lh[0], fnf[0], fnh[0]]
      if (!summaries.every((value) => /^\d+$/.test(value))) {
        throw new Error(`${relative(root, report)} contains malformed LF/LH/FNF/FNH summaries`)
      }
      records.set(sourcePath, summaries.join("/"))
    }
  }

  const missing = executable.filter((path) => !records.has(path))
  if (missing.length > 0)
    throw new Error(
      `missing executable modules:\n${missing.map((path) => `- ${relative(root, path)}`).join("\n")}`
    )

  for (const path of executable) {
    const summary = records.get(path)
    if (!summary) continue
    const [lf, lh, fnf, fnh] = summary.split("/").map(Number)
    if (![lf, lh, fnf, fnh].every(Number.isSafeInteger) || lf < 0 || lh < 0 || fnf < 0 || fnh < 0) {
      throw new Error(`${relative(root, path)} has malformed LF/LH/FNF/FNH summaries`)
    }
    if (lf !== lh || fnf !== fnh)
      throw new Error(
        `${relative(root, path)} is not fully covered: LF=${lf} LH=${lh} FNF=${fnf} FNH=${fnh}`
      )
  }

  console.log(
    `Coverage verified: ${count(executable.length, "executable module")}, ${count(typeOnly.length, "type-only module")}, ${count(compositionRoots.length, "example composition root")} across ${count(coverageWorkspaces.length, "report")}.`
  )
}

try {
  await verify()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
