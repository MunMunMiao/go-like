import { relative, resolve } from "node:path"

interface Manifest {
  scripts?: Record<string, string>
  workspaces?: string[]
}

const root = resolve(process.cwd())
const mode = process.argv[2]
if (mode !== "parallel" && mode !== "stability") {
  throw new Error("expected test mode: parallel or stability")
}
const rootArguments =
  mode === "parallel"
    ? ["--no-orphans", "--parallel=2"]
    : ["--isolate", "--no-orphans", "--randomize", "--rerun-each=2"]
const workspaceArguments =
  mode === "parallel" ? ["--parallel=2"] : ["--randomize", "--rerun-each=2"]

async function run(label: string, command: string[], cwd = root): Promise<void> {
  console.log(`\n[${mode}] ${label}`)
  const child = Bun.spawn(command, {
    cwd,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit"
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exit(exitCode)
}

const manifest = (await Bun.file(resolve(root, "package.json")).json()) as Manifest
if (!Array.isArray(manifest.workspaces)) {
  throw new Error("root package.json must declare workspaces")
}

const rootTests: string[] = []
for await (const path of new Bun.Glob("test/*.test.ts").scan({
  absolute: true,
  cwd: root,
  onlyFiles: true
})) {
  rootTests.push(path)
}
rootTests.sort()
if (rootTests.length === 0) throw new Error("root test directory has no unit tests")

await run("root", [process.execPath, "test", ...rootArguments, ...rootTests])

const workspaces = new Map<string, Manifest>()
for (const workspace of manifest.workspaces) {
  const glob = new Bun.Glob(`${workspace}/package.json`)
  for await (const path of glob.scan({ absolute: true, cwd: root, onlyFiles: true })) {
    workspaces.set(resolve(path, ".."), (await Bun.file(path).json()) as Manifest)
  }
}

for (const [directory, workspace] of [...workspaces].sort(([left], [right]) =>
  left.localeCompare(right)
)) {
  if (!workspace.scripts?.["test:unit"]) continue
  await run(
    relative(root, directory),
    [process.execPath, "run", "test:unit", "--", ...workspaceArguments],
    directory
  )
}
