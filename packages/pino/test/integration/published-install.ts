import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

interface NativeEvidence {
  readonly valid?: boolean
  readonly pinoVersion?: string
  readonly pinoOwnedSonicBoomVersion?: string
  readonly threadStreamVersion?: string
  readonly scenarioEvidence?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly cleanup?: Readonly<Record<string, unknown>>
}

/** Runs one child process and captures its complete output. */
async function run(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn(Array.from(command), { cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  return Object.freeze({ exitCode: await child.exited, stdout: await stdout, stderr: await stderr })
}

/** Requires one command to complete successfully without hiding stderr. */
function requireSuccess(label: string, result: CommandResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${result.stdout}${result.stderr}`
    )
  }
}

/** Reads one generated JSON file through an explicitly narrow manifest shape. */
async function manifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest
}

const packageRoot = resolve(import.meta.dir, "../..")
const repositoryRoot = resolve(packageRoot, "../..")
const workspaceRoots = Object.freeze([
  resolve(repositoryRoot, "packages/context"),
  resolve(repositoryRoot, "packages/registry"),
  resolve(repositoryRoot, "packages/core"),
  resolve(repositoryRoot, "packages/metadata"),
  resolve(repositoryRoot, "packages/resilience"),
  resolve(repositoryRoot, "packages/transport"),
  resolve(repositoryRoot, "packages/broker"),
  resolve(repositoryRoot, "packages/client"),
  resolve(repositoryRoot, "packages/server"),
  packageRoot
])
const stage = await mkdtemp(join(tmpdir(), "likego-pino-published-install-"))

try {
  const sourcePino = await manifest(join(packageRoot, "package.json"))
  for (const root of workspaceRoots) {
    const build = await run(["bun", "run", "build"], root)
    requireSuccess(`build ${root}`, build)
  }

  const tarballRoot = join(stage, "tarballs")
  await mkdir(tarballRoot, { recursive: true })
  for (const root of workspaceRoots) {
    const pack = await run(
      ["bun", "pm", "pack", "--destination", tarballRoot, "--ignore-scripts", "--quiet"],
      join(root, "dist")
    )
    requireSuccess(`pack ${root}`, pack)
  }

  const tarballs = (await readdir(tarballRoot)).filter((name) => name.endsWith(".tgz")).sort()
  if (tarballs.length !== workspaceRoots.length) {
    throw new Error(
      `published install expected ${workspaceRoots.length} tarballs, found ${tarballs.length}`
    )
  }
  const dependencies: Record<string, string> = Object.create(null)
  for (const name of tarballs) {
    if (name.includes("broker")) dependencies["@likego/broker"] = `file:tarballs/${name}`
    else if (name.includes("client")) dependencies["@likego/client"] = `file:tarballs/${name}`
    else if (name.includes("context")) dependencies["@likego/context"] = `file:tarballs/${name}`
    else if (name.includes("core")) dependencies["@likego/core"] = `file:tarballs/${name}`
    else if (name.includes("metadata")) dependencies["@likego/metadata"] = `file:tarballs/${name}`
    else if (name.includes("pino")) dependencies["@likego/pino"] = `file:tarballs/${name}`
    else if (name.includes("registry")) dependencies["@likego/registry"] = `file:tarballs/${name}`
    else if (name.includes("resilience"))
      dependencies["@likego/resilience"] = `file:tarballs/${name}`
    else if (name.includes("server")) dependencies["@likego/server"] = `file:tarballs/${name}`
    else if (name.includes("transport")) dependencies["@likego/transport"] = `file:tarballs/${name}`
  }
  if (Object.keys(dependencies).length !== workspaceRoots.length)
    throw new Error("published tarball identities were incomplete")
  dependencies["sonic-boom"] = "5.0.0"

  await Bun.write(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        name: "likego-pino-published-consumer",
        private: true,
        type: "module",
        dependencies
      },
      null,
      2
    )}\n`
  )
  const install = await run(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--loglevel=error"
    ],
    stage
  )
  requireSuccess("isolated npm install", install)
  if (await Bun.file(join(stage, "package-lock.json")).exists()) {
    throw new Error("isolated npm consumer unexpectedly created a lockfile")
  }

  const installed = await manifest(join(stage, "node_modules/@likego/pino/package.json"))
  if (
    installed.name !== sourcePino.name ||
    installed.version !== sourcePino.version ||
    installed.dependencies?.pino !== "10.3.1" ||
    installed.dependencies?.["sonic-boom"] !== undefined ||
    installed.peerDependencies?.["sonic-boom"] !== undefined
  ) {
    throw new Error(
      "published @likego/pino did not retain Pino ownership of the SonicBoom implementation dependency"
    )
  }
  const consumerSonicBoom = await manifest(join(stage, "node_modules/sonic-boom/package.json"))
  if (consumerSonicBoom.version !== "5.0.0") {
    throw new Error("isolated consumer did not install its explicit SonicBoom 5 dependency")
  }

  await copyFile(resolve(packageRoot, "test/e2e/native-e2e.ts"), join(stage, "native-e2e.ts"))
  const native = await run(["node", "native-e2e.ts"], stage)
  requireSuccess("published native lifecycle", native)
  const line = native.stdout
    .split(/\r?\n/)
    .find((value) => value.startsWith("LIKEGO_PINO_E2E_RESULT="))
  if (line === undefined) throw new Error("published native lifecycle emitted no evidence")
  const evidence = JSON.parse(line.slice("LIKEGO_PINO_E2E_RESULT=".length)) as NativeEvidence
  const destination = evidence.scenarioEvidence?.["pino-native-destination-lifecycle"]
  if (
    evidence.valid !== true ||
    evidence.pinoVersion !== "10.3.1" ||
    evidence.pinoOwnedSonicBoomVersion !== "4.2.1" ||
    evidence.threadStreamVersion !== "4.2.0" ||
    destination?.structuralFileDestinationAccepted !== true ||
    destination.endingWindowRejected !== true ||
    destination.startPrototypeMutationRejected !== true ||
    destination.startPrototypeMutationOwnershipCalls !== 0 ||
    destination.startPrototypeMutationListenersRestored !== true ||
    destination.startOwnMethodMutationRejected !== true ||
    destination.startOwnMethodMutationOwnershipCalls !== 0 ||
    destination.startOwnMethodMutationListenersRestored !== true ||
    destination.startLoggerBindingDriftRejected !== true ||
    destination.startLoggerBindingOwnershipUnchanged !== true ||
    destination.startLoggerBindingListenersRestored !== true ||
    destination.startRegistrationReentryRejected !== true ||
    destination.startRegistrationReentryOwnershipCalls !== 0 ||
    destination.startRegistrationReentryListenersRestored !== true ||
    destination.startCaptureDestroyRejected !== true ||
    destination.startCaptureDestroyOwnershipCalls !== 0 ||
    destination.startCaptureDestroyListenersRestored !== true ||
    destination.startCaptureErrorRejected !== true ||
    destination.startCaptureErrorIdentityPreserved !== true ||
    destination.startCaptureErrorOwnershipCalls !== 0 ||
    destination.startCaptureErrorListenersRestored !== true ||
    destination.startCaptureCloseRejected !== true ||
    destination.startCaptureCloseOwnershipCalls !== 0 ||
    destination.startCaptureCloseListenersRestored !== true ||
    destination.startCaptureCloseDestinationOpen !== true ||
    destination.ownerPrototypeMethodCaptured !== true ||
    destination.ownerPrototypeReplacementCalls !== 0 ||
    destination.ownerOwnMethodsCaptured !== true ||
    destination.ownerOwnEndCalls !== 0 ||
    destination.ownerOwnDestroyCalls !== 0 ||
    destination.ownerLoggerMethodCaptured !== true ||
    destination.ownerAdmittedFlushCalls !== 1 ||
    destination.ownerReplacementFlushCalls !== 0 ||
    destination.ownerStreamDriftRejected !== true ||
    destination.ownerStreamDriftErrorStable !== true ||
    destination.ownerStreamOriginalClosed !== true ||
    destination.ownerStreamReplacementOpen !== true ||
    evidence.cleanup?.directoryRemoved !== true
  ) {
    throw new Error(
      `published native lifecycle evidence was incomplete: ${JSON.stringify(evidence)}`
    )
  }

  process.stdout.write(
    `LIKEGO_PINO_PUBLISHED_INSTALL=${JSON.stringify({
      valid: true,
      packageLockInherited: false,
      pinoVersion: evidence.pinoVersion,
      consumerSonicBoomVersion: consumerSonicBoom.version,
      pinoOwnedSonicBoomVersion: evidence.pinoOwnedSonicBoomVersion,
      threadStreamVersion: evidence.threadStreamVersion,
      structuralFileDestinationAccepted: destination.structuralFileDestinationAccepted,
      endingWindowRejected: destination.endingWindowRejected,
      startPrototypeMutationRejected: destination.startPrototypeMutationRejected,
      startOwnMethodMutationRejected: destination.startOwnMethodMutationRejected,
      startLoggerBindingDriftRejected: destination.startLoggerBindingDriftRejected,
      startRegistrationReentryRejected: destination.startRegistrationReentryRejected,
      startCaptureDestroyRejected: destination.startCaptureDestroyRejected,
      startCaptureErrorRejected: destination.startCaptureErrorRejected,
      startCaptureCloseRejected: destination.startCaptureCloseRejected,
      ownerPrototypeMethodCaptured: destination.ownerPrototypeMethodCaptured,
      ownerOwnMethodsCaptured: destination.ownerOwnMethodsCaptured,
      ownerLoggerMethodCaptured: destination.ownerLoggerMethodCaptured,
      ownerStreamDriftRejected: destination.ownerStreamDriftRejected,
      sonicBoomMajorCoexistence: true,
      directoryRemoved: evidence.cleanup.directoryRemoved
    })}\n`
  )
} finally {
  await rm(stage, { recursive: true, force: true })
}
