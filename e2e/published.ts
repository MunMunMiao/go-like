import { createHash, X509Certificate } from "node:crypto"
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile
} from "node:fs/promises"
import { basename, dirname, join, posix, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { collectCleanupFailure, type CleanupFailure, finalizeWithCleanup } from "./harness/cleanup"
import { boundedTail, errorSummary, sanitizeArgv } from "./harness/diagnostics"
import { runCommand, type CommandResult } from "./harness/process"
import { errorValue } from "./harness/result"
import {
  createTempDirectory,
  createTempSubdirectories,
  isPathContained,
  removeTempDirectory,
  type TempDirectory,
  verifyTempDirectory
} from "./harness/temp"

interface PublishedPackage {
  readonly name: string
  readonly root: string
}

interface PublishedStagePaths {
  readonly tarballs: string
  readonly nodeOutput: string
  readonly nativeOutput: string
  readonly nativeMetafile: string
  readonly upstreamOutput: string
  readonly upstreamMetafile: string
  readonly browserOutput: string
  readonly browserMetafile: string
  readonly markers: string
}

export interface PublishedNativeRuntimeEvidence {
  readonly runtime: "bun" | "deno" | "node"
  readonly version: string
  readonly exitCode: 0
  readonly stdout: string
  readonly cleanup: true
  readonly lifecycle: PublishedLifecycleEvidence
  readonly faults: Readonly<Record<string, unknown>>
}

export interface PublishedLifecycleEvidence {
  readonly servers: 1
  readonly serverStreaming: {
    readonly nextCanonical: true
    readonly handlerCanonical: true
  }
  readonly bidi: {
    readonly nextCanonical: true
    readonly handlerCanonical: true
  }
  readonly forcedStop: {
    readonly waiterCanonical: true
    readonly activeNextRejected: true
    readonly handlerCanonical: true
    readonly backgroundStop: true
    readonly running: true
  }
  readonly selectionCompletions: readonly [1, 1, 1]
  readonly handlerFinally: { readonly serverStreaming: 1; readonly bidi: 1; readonly forcedBidi: 1 }
  readonly cleanup: { readonly client: true; readonly server: true; readonly running: true }
}

interface PublishedCardinalityResult {
  readonly unary: { readonly id: string; readonly state: string }
  readonly serverStreaming: readonly {
    readonly orderId: string
    readonly type: string
    readonly sequence: number
  }[]
  readonly clientStreaming: { readonly count: number }
  readonly bidi: readonly {
    readonly orderId: string
    readonly type: string
    readonly sequence: number
  }[]
}

export interface PublishedInteropRuntimeEvidence {
  readonly runtime: PublishedNativeRuntimeEvidence["runtime"]
  readonly version: string
  readonly upstream: {
    readonly exitCode: 0
    readonly result: PublishedCardinalityResult
    readonly managerCleanup: true
  }
  readonly buf: {
    readonly exitCodes: {
      readonly unary: 0
      readonly serverStreaming: 0
      readonly clientStreaming: 0
      readonly bidi: 0
    }
    readonly result: PublishedCardinalityResult
  }
  readonly server: {
    readonly exitCode: 0
    readonly reason: "SIGTERM"
    readonly counters: {
      readonly unary: 2
      readonly serverStreaming: 2
      readonly clientStreaming: 2
      readonly bidi: 2
    }
    readonly cleanup: true
  }
}

export interface PublishedInteropEvidence {
  readonly entry: "compiled/native-upstream.js"
  readonly sha256: string
  readonly runtimes: readonly PublishedInteropRuntimeEvidence[]
}

export interface PublishedMtlsRuntimeEvidence {
  readonly runtime: PublishedNativeRuntimeEvidence["runtime"]
  readonly version: string
  readonly upstream: {
    readonly exitCode: 0
    readonly cases: {
      readonly none: "rejected"
      readonly untrusted: "rejected"
      readonly wrongTrust: "rejected"
      readonly trusted: { readonly id: "mtls-order"; readonly state: "READY" }
    }
    readonly managerCleanups: 4
    readonly rejectionErrors: Readonly<
      Record<
        "none" | "untrusted" | "wrongTrust",
        {
          readonly code: number
          readonly message: string
          readonly cause: { readonly name: string; readonly message: string } | null
        }
      >
    >
    readonly rejectionContexts: {
      readonly noneTimedOut: false
      readonly untrustedTimedOut: false
      readonly wrongTrustTimedOut: false
    }
  }
  readonly buf: null | {
    readonly exitCode: 0
    readonly result: { readonly id: "mtls-buf-order"; readonly state: "READY" }
  }
  readonly server: {
    readonly exitCode: 0
    readonly reason: "SIGTERM"
    readonly counters: {
      readonly unary: number
      readonly serverStreaming: 0
      readonly clientStreaming: 0
      readonly bidi: 0
    }
    readonly cleanup: true
  }
}

export interface PublishedMtlsEvidence {
  readonly opensslVersion: string
  readonly certificates: PublishedMtlsFixture["evidence"]
  readonly runtimes: readonly PublishedMtlsRuntimeEvidence[]
}

export interface PublishedNativeEvidence {
  readonly entry: "compiled/native-runtime.js"
  readonly sha256: string
  readonly runtimes: readonly PublishedNativeRuntimeEvidence[]
  readonly interoperability: PublishedInteropEvidence
  readonly mtls: PublishedMtlsEvidence
  readonly browser: PublishedBrowserEvidence
}

export interface PublishedBrowserEvidence {
  readonly entry: "compiled/browser.js"
  readonly sha256: string
  readonly bytes: number
  readonly inputCount: number
  readonly portableRoot: true
  readonly generatedGlue: true
  readonly forbiddenModules: false
}

export interface PublishedMtlsFixture {
  readonly opensslVersion: string
  readonly paths: {
    readonly directory: string
    readonly trustedCaCertificate: string
    readonly trustedCaKey: string
    readonly untrustedCaCertificate: string
    readonly untrustedCaKey: string
    readonly serverCertificate: string
    readonly serverKey: string
    readonly clientKey: string
    readonly trustedClientCertificate: string
    readonly untrustedClientCertificate: string
  }
  readonly evidence: {
    readonly serverIdentity: {
      readonly dnsLocalhost: true
      readonly ipLoopback: true
      readonly serverAuth: true
    }
    readonly clientEquivalence: {
      readonly subject: true
      readonly spki: true
      readonly publicKeyAlgorithm: true
      readonly serial: true
      readonly validFrom: true
      readonly validTo: true
      readonly clientAuth: true
    }
    readonly chainTrust: {
      readonly issuersDifferent: true
      readonly trustedByTrustedCa: true
      readonly untrustedByUntrustedCa: true
      readonly untrustedByTrustedCaRejected: true
    }
  }
}

const FixtureFiles = Object.freeze([
  "package.json",
  "browser.ts",
  "portable.ts",
  "node.ts",
  "bun.ts",
  "deno.ts",
  "deno.json",
  "tsconfig.authoring.json",
  "tsconfig.types.json",
  "tsconfig.node.json",
  "authoring-stubs/go-like.d.ts",
  "buf.yaml",
  "buf.gen.yaml",
  "proto/published/v1/probe.proto",
  "proto/order/v1/order.proto"
])

const NativeSourceFiles = Object.freeze([
  "native-faults.ts",
  "native-harness.ts",
  "native-runtime.ts",
  "native-upstream.ts"
])

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("published package metadata must be an object")
  }
  return value as Record<string, unknown>
}

/** Parses the concatenated top-level JSON objects emitted by streaming `buf curl`. */
export function parsePublishedJsonValues(output: string): readonly Record<string, unknown>[] {
  const values: Record<string, unknown>[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]
    if (character === undefined) throw new Error("published JSON output index is unavailable")
    if (start === -1) {
      if (/\s/u.test(character)) continue
      if (character !== "{") throw new Error("published JSON output must contain objects")
      start = index
      depth = 1
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) {
        values.push(record(JSON.parse(output.slice(start, index + 1))))
        start = -1
      }
    }
  }
  if (start !== -1 || inString || escaped) {
    throw new Error("published JSON output ended before its object completed")
  }
  if (values.length === 0) throw new Error("published JSON output contained no objects")
  return Object.freeze(values)
}

function stagePath(paths: readonly string[], index: number, label: string): string {
  const path = paths[index]
  if (path === undefined) throw new Error(`published stage did not create ${label}`)
  return path
}

async function createStagePaths(directory: TempDirectory): Promise<PublishedStagePaths> {
  const paths = await createTempSubdirectories(directory, [
    ["authoring-stubs"],
    ["tarballs"],
    ["home"],
    ["cache"],
    ["cache", "npm"],
    ["cache", "bun"],
    ["cache", "deno"],
    ["config"],
    ["npm-prefix"],
    ["compiled"],
    ["compiled", "node"],
    ["markers"],
    ["proto"],
    ["proto", "published"],
    ["proto", "published", "v1"],
    ["proto", "order"],
    ["proto", "order", "v1"],
    ["test"],
    ["test", "e2e"]
  ])
  return Object.freeze({
    tarballs: stagePath(paths, 1, "tarball directory"),
    nodeOutput: stagePath(paths, 10, "Node output directory"),
    nativeOutput: join(directory.path, "compiled/native-runtime.js"),
    nativeMetafile: join(directory.path, "compiled/native-runtime.meta.json"),
    upstreamOutput: join(directory.path, "compiled/native-upstream.js"),
    upstreamMetafile: join(directory.path, "compiled/native-upstream.meta.json"),
    browserOutput: join(directory.path, "compiled/browser.js"),
    browserMetafile: join(directory.path, "compiled/browser.meta.json"),
    markers: stagePath(paths, 11, "marker directory")
  })
}

/** Removes ambient module/config search inputs and pins tool state beneath the stage. */
export function publishedEnvironment(
  stage: string,
  ambient: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {}
  for (const name of Object.keys(ambient)) {
    const upperName = name.toUpperCase()
    if (
      /^npm_config_/iu.test(name) ||
      /^bun_/iu.test(name) ||
      /^deno_/iu.test(name) ||
      upperName === "NODE_OPTIONS" ||
      upperName === "NODE_PATH" ||
      upperName === "INIT_CWD" ||
      upperName === "HOME" ||
      upperName === "XDG_CACHE_HOME" ||
      upperName === "XDG_CONFIG_HOME"
    ) {
      environment[name] = undefined
    }
  }
  Object.assign(environment, {
    HOME: join(stage, "home"),
    XDG_CACHE_HOME: join(stage, "cache"),
    XDG_CONFIG_HOME: join(stage, "config"),
    npm_config_cache: join(stage, "cache/npm"),
    npm_config_userconfig: join(stage, "config/npmrc"),
    npm_config_globalconfig: join(stage, "config/npmrc-global"),
    npm_config_prefix: join(stage, "npm-prefix"),
    npm_config_ignore_scripts: "true",
    BUN_INSTALL_CACHE_DIR: join(stage, "cache/bun"),
    DENO_DIR: join(stage, "cache/deno"),
    NODE_OPTIONS: undefined,
    NODE_PATH: undefined,
    INIT_CWD: undefined
  })
  return Object.freeze(environment)
}

function commandFailure(argv: readonly string[], result: CommandResult): Error | null {
  const rendered = sanitizeArgv(argv).join(" ")
  if (result.cleanupFailures.length > 0) {
    return new Error(
      `${rendered} had process cleanup failures: ${errorSummary(result.cleanupFailures)}`
    )
  }
  if (result.timedOut) return new Error(`${rendered} timed out`)
  if (result.termination !== "exit" || result.exitCode === null) {
    return new Error(`${rendered} ended with ${result.termination}`)
  }
  if (result.exitCode !== 0) {
    return new Error(
      `${rendered} exited ${result.exitCode}: ${boundedTail(result.stderr || result.stdout, 4_000)}`
    )
  }
  return null
}

async function execute(
  root: string,
  directory: TempDirectory,
  cwd: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  await verifyTempDirectory(directory)
  return await runCommand(root, {
    cwd,
    command: argv,
    timeoutMs,
    signal,
    environment
  })
}

async function command(
  root: string,
  directory: TempDirectory,
  cwd: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const result = await execute(root, directory, cwd, argv, environment, timeoutMs, signal)
  const failure = commandFailure(argv, result)
  if (failure !== null) throw failure
  return result.stdout.trim()
}

function certificateSpki(certificate: X509Certificate): string {
  return createHash("sha256")
    .update(certificate.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")
}

/** Generates and programmatically validates the single physical-stage mTLS fixture. */
export async function createPublishedMtlsFixture(
  root: string,
  directory: TempDirectory,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal
): Promise<PublishedMtlsFixture> {
  const created = await createTempSubdirectories(directory, [["tls"]])
  const tlsDirectory = stagePath(created, 0, "TLS directory")
  const path = (name: string): string => join(tlsDirectory, name)
  const paths = Object.freeze({
    directory: tlsDirectory,
    trustedCaCertificate: path("trusted-ca.pem"),
    trustedCaKey: path("trusted-ca-key.pem"),
    untrustedCaCertificate: path("untrusted-ca.pem"),
    untrustedCaKey: path("untrusted-ca-key.pem"),
    serverCertificate: path("server.pem"),
    serverKey: path("server-key.pem"),
    clientKey: path("client-key.pem"),
    trustedClientCertificate: path("trusted-client.pem"),
    untrustedClientCertificate: path("untrusted-client.pem")
  })
  const serverRequest = path("server.csr")
  const clientRequest = path("client.csr")
  const serverExtensions = path("server.ext")
  const clientExtensions = path("client.ext")
  const privateFiles = [
    paths.trustedCaKey,
    paths.untrustedCaKey,
    paths.serverKey,
    paths.clientKey
  ] as const
  const openssl = async (...args: readonly string[]): Promise<string> =>
    await command(
      root,
      directory,
      directory.path,
      ["openssl", ...args],
      environment,
      30_000,
      signal
    )
  const generateKey = async (key: string): Promise<void> => {
    await openssl("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", key)
    await chmod(key, 0o600)
  }
  const generateCa = async (key: string, certificate: string, subject: string): Promise<void> => {
    await generateKey(key)
    await openssl(
      "req",
      "-new",
      "-x509",
      "-key",
      key,
      "-out",
      certificate,
      "-subj",
      subject,
      "-sha256",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign"
    )
  }

  const opensslVersion = await openssl("version")
  await generateCa(paths.trustedCaKey, paths.trustedCaCertificate, "/CN=LikeGo Trusted Test CA")
  await generateCa(
    paths.untrustedCaKey,
    paths.untrustedCaCertificate,
    "/CN=LikeGo Untrusted Test CA"
  )
  await writeFile(
    serverExtensions,
    [
      "[server_cert]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  )
  await writeFile(
    clientExtensions,
    [
      "[client_cert]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth",
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  )

  await generateKey(paths.serverKey)
  await openssl(
    "req",
    "-new",
    "-key",
    paths.serverKey,
    "-out",
    serverRequest,
    "-subj",
    "/CN=localhost",
    "-sha256"
  )
  await openssl(
    "x509",
    "-req",
    "-in",
    serverRequest,
    "-CA",
    paths.trustedCaCertificate,
    "-CAkey",
    paths.trustedCaKey,
    "-set_serial",
    "0x1001",
    "-days",
    "1",
    "-sha256",
    "-extfile",
    serverExtensions,
    "-extensions",
    "server_cert",
    "-out",
    paths.serverCertificate
  )

  await generateKey(paths.clientKey)
  await openssl(
    "req",
    "-new",
    "-key",
    paths.clientKey,
    "-out",
    clientRequest,
    "-subj",
    "/CN=LikeGo mTLS Client",
    "-sha256"
  )
  for (const [caCertificate, caKey, output] of [
    [paths.trustedCaCertificate, paths.trustedCaKey, paths.trustedClientCertificate],
    [paths.untrustedCaCertificate, paths.untrustedCaKey, paths.untrustedClientCertificate]
  ] as const) {
    await openssl(
      "x509",
      "-req",
      "-in",
      clientRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-set_serial",
      "0x2001",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      clientExtensions,
      "-extensions",
      "client_cert",
      "-out",
      output
    )
  }
  for (const key of privateFiles) await chmod(key, 0o600)

  await openssl(
    "verify",
    "-purpose",
    "sslserver",
    "-verify_hostname",
    "localhost",
    "-CAfile",
    paths.trustedCaCertificate,
    paths.serverCertificate
  )
  await openssl(
    "verify",
    "-purpose",
    "sslclient",
    "-CAfile",
    paths.trustedCaCertificate,
    paths.trustedClientCertificate
  )
  await openssl(
    "verify",
    "-purpose",
    "sslclient",
    "-CAfile",
    paths.untrustedCaCertificate,
    paths.untrustedClientCertificate
  )
  const rejected = await execute(
    root,
    directory,
    directory.path,
    [
      "openssl",
      "verify",
      "-purpose",
      "sslclient",
      "-CAfile",
      paths.trustedCaCertificate,
      paths.untrustedClientCertificate
    ],
    environment,
    30_000,
    signal
  )
  if (
    rejected.timedOut ||
    rejected.termination !== "exit" ||
    rejected.exitCode === null ||
    rejected.exitCode === 0 ||
    rejected.cleanupFailures.length > 0
  ) {
    throw new Error("published untrusted client certificate did not fail trusted CA verification")
  }

  const server = new X509Certificate(await readFile(paths.serverCertificate))
  const trusted = new X509Certificate(await readFile(paths.trustedClientCertificate))
  const untrusted = new X509Certificate(await readFile(paths.untrustedClientCertificate))
  const trustedCa = new X509Certificate(await readFile(paths.trustedCaCertificate))
  const untrustedCa = new X509Certificate(await readFile(paths.untrustedCaCertificate))
  const serverEku = await openssl(
    "x509",
    "-in",
    paths.serverCertificate,
    "-noout",
    "-ext",
    "extendedKeyUsage"
  )
  const trustedEku = await openssl(
    "x509",
    "-in",
    paths.trustedClientCertificate,
    "-noout",
    "-ext",
    "extendedKeyUsage"
  )
  const untrustedEku = await openssl(
    "x509",
    "-in",
    paths.untrustedClientCertificate,
    "-noout",
    "-ext",
    "extendedKeyUsage"
  )
  const serverIdentity = {
    dnsLocalhost: server.checkHost("localhost") === "localhost",
    ipLoopback: server.checkIP("127.0.0.1") === "127.0.0.1",
    serverAuth: serverEku.includes("TLS Web Server Authentication")
  }
  const clientEquivalence = {
    subject: trusted.subject === untrusted.subject,
    spki: certificateSpki(trusted) === certificateSpki(untrusted),
    publicKeyAlgorithm:
      trusted.publicKey.asymmetricKeyType === untrusted.publicKey.asymmetricKeyType,
    serial: trusted.serialNumber === untrusted.serialNumber,
    validFrom: trusted.validFrom === untrusted.validFrom,
    validTo: trusted.validTo === untrusted.validTo,
    clientAuth: trustedEku === untrustedEku && trustedEku.includes("TLS Web Client Authentication")
  }
  const chainTrust = {
    issuersDifferent:
      trusted.issuer !== untrusted.issuer &&
      trusted.issuer === trustedCa.subject &&
      untrusted.issuer === untrustedCa.subject,
    trustedByTrustedCa: trusted.verify(trustedCa.publicKey),
    untrustedByUntrustedCa: untrusted.verify(untrustedCa.publicKey),
    untrustedByTrustedCaRejected: !untrusted.verify(trustedCa.publicKey)
  }
  if (
    !Object.values(serverIdentity).every(Boolean) ||
    !Object.values(clientEquivalence).every(Boolean) ||
    !Object.values(chainTrust).every(Boolean)
  ) {
    throw new Error("published mTLS certificate invariants were not satisfied")
  }

  return Object.freeze({
    opensslVersion,
    paths,
    evidence: Object.freeze({
      serverIdentity: Object.freeze(
        serverIdentity
      ) as PublishedMtlsFixture["evidence"]["serverIdentity"],
      clientEquivalence: Object.freeze(
        clientEquivalence
      ) as PublishedMtlsFixture["evidence"]["clientEquivalence"],
      chainTrust: Object.freeze(chainTrust) as PublishedMtlsFixture["evidence"]["chainTrust"]
    })
  })
}

async function packageRoots(root: string): Promise<readonly PublishedPackage[]> {
  const packages: PublishedPackage[] = []
  const names = new Set<string>()
  for await (const path of new Bun.Glob("packages/**/package.json").scan({
    cwd: root,
    onlyFiles: true
  })) {
    if (path.includes("/dist/") || path.includes("/node_modules/")) continue
    const manifest = record(await Bun.file(join(root, path)).json())
    if (manifest.private === true) continue
    if (typeof manifest.name !== "string" || !/^@go-like\/[a-z0-9-]+$/u.test(manifest.name)) {
      throw new Error(`public package at ${path} has an invalid name`)
    }
    if (names.has(manifest.name)) throw new Error(`duplicate public package ${manifest.name}`)
    names.add(manifest.name)
    packages.push(
      Object.freeze({
        name: manifest.name,
        root: resolve(root, path, "..", "dist")
      })
    )
  }
  return Object.freeze(packages.sort((left, right) => left.name.localeCompare(right.name, "en-US")))
}

function safePackPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path) ||
    posix.normalize(path) !== path
  ) {
    return false
  }
  return path
    .split("/")
    .every((component) => component.length > 0 && component !== "." && component !== "..")
}

/** Parses npm's structured pack output and rejects unsafe or incomplete archive inventories. */
export function parseNpmPackOutput(output: string, expectedName: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON for ${expectedName}`, { cause: error })
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack returned an invalid result count for ${expectedName}`)
  }
  const result = record(parsed[0])
  if (result.name !== expectedName) throw new Error(`npm pack returned the wrong package name`)
  if (
    typeof result.filename !== "string" ||
    !safePackPath(result.filename) ||
    basename(result.filename) !== result.filename ||
    !result.filename.endsWith(".tgz")
  ) {
    throw new Error(`npm pack returned an unsafe filename for ${expectedName}`)
  }
  if (!Array.isArray(result.files) || result.files.length === 0) {
    throw new Error(`npm pack returned no file inventory for ${expectedName}`)
  }
  const paths = new Set<string>()
  for (const value of result.files) {
    const file = record(value)
    if (typeof file.path !== "string" || !safePackPath(file.path)) {
      throw new Error(`npm pack returned an unsafe entry for ${expectedName}`)
    }
    if (paths.has(file.path))
      throw new Error(`npm pack returned a duplicate entry for ${expectedName}`)
    paths.add(file.path)
    if (
      !Number.isInteger(file.mode) ||
      (file.mode as number) < 0 ||
      (file.mode as number) > 0o777
    ) {
      throw new Error(`npm pack returned an invalid file mode for ${expectedName}`)
    }
  }
  if (!paths.has("package.json") || !Array.from(paths).some((path) => path.endsWith(".js"))) {
    throw new Error(`npm pack returned an incomplete runtime contract for ${expectedName}`)
  }
  if (!Array.from(paths).some((path) => path.endsWith(".d.ts"))) {
    throw new Error(`npm pack returned an incomplete type contract for ${expectedName}`)
  }
  return result.filename
}

async function assertRegularContained(root: string, path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile()) {
    throw new Error(`published file is not a regular file: ${basename(path)}`)
  }
  const physical = await realpath(path)
  if (!isPathContained(root, physical)) {
    throw new Error(`published file escaped its stage: ${basename(path)}`)
  }
}

/** Requires the controller to be the real Node 22+ process used by the staged binary. */
export function validatePublishedNodeVersion(version: string): void {
  const major = Number(/^v(\d+)\./u.exec(version)?.[1])
  if (!(major >= 22)) {
    throw new Error(`published plugin requires Node 22 or newer, received ${version}`)
  }
}

/** Validates the installed package target rather than npm's normal .bin symlink. */
export async function validateInstalledProtocGenLike(stage: string): Promise<string> {
  const packageRoot = join(stage, "node_modules/@go-like/protoc-gen-like")
  const manifest = record(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")))
  let engines: Record<string, unknown>
  let bin: Record<string, unknown>
  try {
    engines = record(manifest.engines)
    bin = record(manifest.bin)
  } catch (error) {
    throw new Error("installed protoc-gen-like manifest contract is incomplete", { cause: error })
  }
  if (engines.node !== ">=22" || bin["protoc-gen-like"] !== "bin/protoc-gen-like.cjs") {
    throw new Error("installed protoc-gen-like manifest contract is incomplete")
  }

  const binary = join(packageRoot, "bin/protoc-gen-like.cjs")
  await assertRegularContained(packageRoot, binary)
  if (((await lstat(binary)).mode & 0o111) === 0) {
    throw new Error("installed protoc-gen-like target is not executable")
  }
  if ((await readFile(binary, "utf8")).split("\n", 1)[0] !== "#!/usr/bin/env node") {
    throw new Error("installed protoc-gen-like target does not have the exact Node shebang")
  }
  return binary
}

/** Returns the physical staged Buf launcher after validating its package-owned target. */
export async function validateInstalledBuf(stage: string): Promise<string> {
  const packageRoot = join(stage, "node_modules/@bufbuild/buf")
  const manifest = record(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")))
  const bin = record(manifest.bin)
  if (bin.buf !== "./bin/buf") throw new Error("installed Buf manifest contract is incomplete")
  const target = join(packageRoot, "bin/buf")
  await assertRegularContained(packageRoot, target)
  if (((await lstat(target)).mode & 0o111) === 0) {
    throw new Error("installed Buf target is not executable")
  }
  const launcher = join(stage, "node_modules/.bin/buf")
  if ((await realpath(launcher)) !== (await realpath(target))) {
    throw new Error("installed Buf launcher did not resolve to its package target")
  }
  return launcher
}

function dependencyValues(manifest: Record<string, unknown>): readonly unknown[] {
  const fields = ["dependencies", "peerDependencies", "optionalDependencies"] as const
  return fields.flatMap((field) => {
    const value = manifest[field]
    return value === undefined ? [] : Object.values(record(value))
  })
}

async function validateInstalledPackages(stage: string, packages: readonly PublishedPackage[]) {
  const nodeModules = join(stage, "node_modules")
  for (const entry of packages) {
    const packagePath = join(nodeModules, ...entry.name.split("/"))
    const metadata = await lstat(packagePath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`installed package is not a physical directory: ${entry.name}`)
    }
    const physical = await realpath(packagePath)
    if (!isPathContained(nodeModules, physical)) {
      throw new Error(`installed package escaped stage node_modules: ${entry.name}`)
    }
    const manifest = record(JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")))
    if (
      manifest.name !== entry.name ||
      manifest.exports === undefined ||
      typeof manifest.types !== "string"
    ) {
      throw new Error(`installed package contract is incomplete: ${entry.name}`)
    }
    if (
      dependencyValues(manifest).some(
        (value) => typeof value === "string" && value.startsWith("workspace:")
      )
    ) {
      throw new Error(`installed package retained a workspace dependency: ${entry.name}`)
    }
    const typesPath = resolve(packagePath, manifest.types)
    if (!isPathContained(packagePath, typesPath) || !(await lstat(typesPath)).isFile()) {
      throw new Error(`installed package types escaped or are missing: ${entry.name}`)
    }
  }
}

/** Requires every public package root import to resolve inside the staged physical node_modules. */
export function validatePublishedTrace(
  trace: string,
  stage: string,
  packageNames: readonly string[]
): void {
  const nodeModules = join(resolve(stage), "node_modules")
  const resolved = new Map<string, string>()
  const pattern = /Module name '(@go-like\/[^']+)' was successfully resolved to '([^']+)'/gu
  for (const match of trace.matchAll(pattern)) {
    const specifier = match[1]
    const path = match[2]
    if (specifier === undefined || path === undefined) continue
    if (!isPathContained(nodeModules, path)) {
      throw new Error(`published type resolution escaped staged node_modules: ${specifier}`)
    }
    resolved.set(specifier, path)
  }
  if (resolved.size === 0) throw new Error("published type trace contained no @go-like resolutions")
  const missing = packageNames.filter((name) => !resolved.has(name))
  if (missing.length > 0) {
    throw new Error(`published type trace missed public packages: ${missing.join(", ")}`)
  }
}

async function validateNodeOutput(paths: PublishedStagePaths): Promise<void> {
  const entries = (await readdir(paths.nodeOutput)).sort()
  if (entries.length !== 2 || entries[0] !== "node.js" || entries[1] !== "portable.js") {
    throw new Error(`published Node emit produced unexpected files: ${entries.join(", ")}`)
  }
}

async function validatePublishedMetafile(
  stage: string,
  metafilePath: string,
  label: string,
  requiredInputs: readonly string[]
): Promise<void> {
  const metafile = record(JSON.parse(await readFile(metafilePath, "utf8")))
  const inputs = record(metafile.inputs)
  const inputPaths = Object.keys(inputs)
  if (inputPaths.length === 0) throw new Error(`published ${label} compile recorded no inputs`)
  for (const input of inputPaths) {
    const path = resolve(stage, input)
    if (!isPathContained(stage, path)) {
      throw new Error(`published ${label} compile escaped its stage: ${input}`)
    }
    await assertRegularContained(stage, path)
  }
  for (const required of requiredInputs) {
    if (!inputPaths.some((input) => resolve(stage, input) === resolve(stage, required))) {
      throw new Error(`published ${label} compile missed staged input: ${required}`)
    }
  }
}

export async function validatePublishedNativeMetafile(
  stage: string,
  metafilePath: string
): Promise<void> {
  await validatePublishedMetafile(stage, metafilePath, "native", [
    "test/e2e/native-runtime.ts",
    "test/e2e/native-harness.ts",
    "test/e2e/native-faults.ts",
    ".artifacts/gen/order/v1/order_pb.ts",
    ".artifacts/gen/order/v1/order_like.ts"
  ])
}

export async function validatePublishedUpstreamMetafile(
  stage: string,
  metafilePath: string
): Promise<void> {
  await validatePublishedMetafile(stage, metafilePath, "upstream", [
    "test/e2e/native-upstream.ts",
    ".artifacts/gen/order/v1/order_pb.ts",
    ".artifacts/gen/order/v1/order_like.ts"
  ])
}

/** Requires one non-empty physical browser graph containing only the portable package lane. */
export async function validatePublishedBrowserBundle(
  stage: string,
  metafilePath: string,
  outputPath: string
): Promise<PublishedBrowserEvidence> {
  const requiredInputs = [
    "browser.ts",
    ".artifacts/gen/published/v1/probe_pb.ts",
    ".artifacts/gen/published/v1/probe_like.ts",
    "node_modules/@go-like/transport-grpc-buf/index.js"
  ]
  await validatePublishedMetafile(stage, metafilePath, "browser", requiredInputs)
  await assertRegularContained(stage, outputPath)

  const metafile = record(JSON.parse(await readFile(metafilePath, "utf8")))
  const inputs = record(metafile.inputs)
  const outputs = record(metafile.outputs)
  const outputEntry = Object.entries(outputs).find(
    ([path]) => resolve(dirname(metafilePath), path) === outputPath
  )
  if (outputEntry === undefined) {
    throw new Error("published browser metafile missed its physical output")
  }
  const bundledInputs = record(record(outputEntry[1]).inputs)
  for (const required of requiredInputs) {
    const contribution = Object.entries(bundledInputs).find(
      ([path]) => resolve(stage, path) === resolve(stage, required)
    )
    if (
      contribution === undefined ||
      typeof record(contribution[1]).bytesInOutput !== "number" ||
      record(contribution[1]).bytesInOutput === 0
    ) {
      throw new Error(`published browser bundle omitted required input: ${required}`)
    }
  }
  const output = await readFile(outputPath)
  if (output.byteLength <= 62) {
    throw new Error("published browser bundle was empty")
  }

  const graph = JSON.stringify({ inputs, outputs })
  if (
    /node:|@connectrpc[/\\]connect-node|@grpc[/\\]grpc-js|@go-like[/\\]transport-grpc-buf[/\\]native|transport-grpc-buf[/\\](?:client|server|native)\.[cm]?[jt]s|Http2SessionManager|connectNodeAdapter|gRPC client is closed|gRPC server is stopped/u.test(
      graph
    )
  ) {
    throw new Error("published browser bundle contains forbidden native module")
  }

  const runtimeCommand = [
    process.execPath,
    "-e",
    `await import(${JSON.stringify(pathToFileURL(outputPath).href)})`
  ] as const
  const runtime = await runCommand(stage, {
    cwd: ".",
    command: runtimeCommand,
    timeoutMs: 30_000,
    environment: publishedEnvironment(stage)
  })
  const runtimeFailure = commandFailure(runtimeCommand, runtime)
  if (runtimeFailure !== null) throw runtimeFailure

  return Object.freeze({
    entry: "compiled/browser.js" as const,
    sha256: createHash("sha256").update(output).digest("hex"),
    bytes: output.byteLength,
    inputCount: Object.keys(inputs).length,
    portableRoot: true as const,
    generatedGlue: true as const,
    forbiddenModules: false as const
  })
}

const ExpectedLifecycleEvidence: PublishedLifecycleEvidence = Object.freeze({
  servers: 1,
  serverStreaming: Object.freeze({ nextCanonical: true, handlerCanonical: true }),
  bidi: Object.freeze({ nextCanonical: true, handlerCanonical: true }),
  forcedStop: Object.freeze({
    waiterCanonical: true,
    activeNextRejected: true,
    handlerCanonical: true,
    backgroundStop: true,
    running: true
  }),
  selectionCompletions: Object.freeze([1, 1, 1] as const),
  handlerFinally: Object.freeze({ serverStreaming: 1, bidi: 1, forcedBidi: 1 }),
  cleanup: Object.freeze({ client: true, server: true, running: true })
})

export function parsePublishedNativeRuntimeEvidence(
  output: string,
  expectedRuntime: PublishedNativeRuntimeEvidence["runtime"]
): PublishedNativeRuntimeEvidence {
  let value: Record<string, unknown>
  try {
    value = record(JSON.parse(output))
  } catch (error) {
    throw new Error(`${expectedRuntime} published native output was not one JSON record`, {
      cause: error
    })
  }
  if (
    value.kind !== "managed-self-test" ||
    value.runtime !== expectedRuntime ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error(`${expectedRuntime} published native identity was invalid`)
  }
  const expected = {
    result: {
      unary: { id: "managed-order", state: "READY" },
      serverStreaming: [
        { orderId: "managed-customer-1", type: "CREATED", sequence: 1 },
        { orderId: "managed-customer-2", type: "READY", sequence: 2 }
      ],
      clientStreaming: { count: 3 },
      bidi: [
        { orderId: "sync-1", type: "ACK:CREATE", sequence: 1 },
        { orderId: "sync-2", type: "ACK:SHIP", sequence: 2 }
      ]
    },
    counters: { unary: 1, serverStreaming: 1, clientStreaming: 1, bidi: 1 },
    cleanup: { client: true, server: true, running: true }
  }
  for (const field of ["result", "counters", "cleanup"] as const) {
    if (JSON.stringify(value[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`${expectedRuntime} published native ${field} was invalid`)
    }
  }
  if (JSON.stringify(value.lifecycle) !== JSON.stringify(ExpectedLifecycleEvidence)) {
    throw new Error(`${expectedRuntime} published native lifecycle was invalid`)
  }
  const faults = record(value.faults)
  const peerReset = record(faults.peerReset)
  const code = peerReset.errorCode
  if (typeof code !== "number" || !Number.isInteger(code) || code < 1 || code > 16) {
    throw new Error(`${expectedRuntime} published native peer reset error code was invalid`)
  }
  assertExactJson(
    faults,
    {
      canceledRequestsAndClose: {
        preCanceledCardinalities: 4,
        counts: {
          unary: 1,
          upload: 1,
          producer: 1,
          uploadFinally: 1,
          producerFinally: 1,
          unaryFinally: 1,
          serverStreaming: 0,
          bidi: 0
        },
        repeatedClose: true
      },
      gracefulDrain: {
        inflightUnaryCompleted: true,
        messages: 16,
        payloadBytes: 65536,
        delayedReadMs: 2,
        handlerFinally: 1
      },
      peerReset: { receivedPrefix: 1, requests: 1, completions: 1, errorCode: code }
    },
    `${expectedRuntime} native faults`
  )
  return Object.freeze({
    runtime: expectedRuntime,
    version: value.version,
    exitCode: 0 as const,
    stdout: output,
    cleanup: true as const,
    lifecycle: ExpectedLifecycleEvidence,
    faults
  })
}

const ExpectedUpstreamResult: PublishedCardinalityResult = Object.freeze({
  unary: { id: "upstream-order", state: "READY" },
  serverStreaming: [
    { orderId: "upstream-customer-1", type: "CREATED", sequence: 1 },
    { orderId: "upstream-customer-2", type: "READY", sequence: 2 }
  ],
  clientStreaming: { count: 3 },
  bidi: [
    { orderId: "upstream-sync-1", type: "ACK:CREATE", sequence: 1 },
    { orderId: "upstream-sync-2", type: "ACK:SHIP", sequence: 2 }
  ]
})

const ExpectedBufResult: PublishedCardinalityResult = Object.freeze({
  unary: { id: "buf-order", state: "READY" },
  serverStreaming: [
    { orderId: "buf-customer-1", type: "CREATED", sequence: 1 },
    { orderId: "buf-customer-2", type: "READY", sequence: 2 }
  ],
  clientStreaming: { count: 3 },
  bidi: [
    { orderId: "buf-sync-1", type: "ACK:CREATE", sequence: 1 },
    { orderId: "buf-sync-2", type: "ACK:SHIP", sequence: 2 }
  ]
})

function assertExactJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`published ${label} result was invalid`)
  }
}

function upstreamRuntimeEvidence(
  output: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  version: string
): PublishedInteropRuntimeEvidence["upstream"] {
  const value = record(JSON.parse(output))
  if (value.kind !== "upstream-client" || value.runtime !== runtime || value.version !== version) {
    throw new Error(`${runtime} published upstream identity was invalid`)
  }
  const cleanup = record(value.cleanup)
  if (cleanup.manager !== true) {
    throw new Error(`${runtime} published upstream manager cleanup was invalid`)
  }
  assertExactJson(value.result, ExpectedUpstreamResult, `${runtime} upstream`)
  return Object.freeze({
    exitCode: 0 as const,
    result: value.result as unknown as PublishedCardinalityResult,
    managerCleanup: true as const
  })
}

export function parsePublishedMtlsUpstreamEvidence(
  output: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  version: string
): PublishedMtlsRuntimeEvidence["upstream"] {
  const value = record(JSON.parse(output))
  if (
    value.kind !== "upstream-mtls" ||
    value.runtime !== runtime ||
    value.version !== version ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([
        "cases",
        "cleanup",
        "kind",
        "rejectionContexts",
        "rejectionErrors",
        "runtime",
        "version"
      ])
  ) {
    throw new Error(`${runtime} published mTLS upstream identity was invalid`)
  }
  assertExactJson(
    value.cases,
    {
      none: "rejected",
      untrusted: "rejected",
      wrongTrust: "rejected",
      trusted: { id: "mtls-order", state: "READY" }
    },
    `${runtime} mTLS upstream cases`
  )
  assertExactJson(value.cleanup, { managers: 4 }, `${runtime} mTLS manager cleanup`)
  assertExactJson(
    value.rejectionContexts,
    { noneTimedOut: false, untrustedTimedOut: false, wrongTrustTimedOut: false },
    `${runtime} mTLS rejection contexts`
  )
  const rejectionErrors = record(value.rejectionErrors)
  for (const kind of ["none", "untrusted", "wrongTrust"] as const) {
    const error = record(rejectionErrors[kind])
    const cause = error.cause === null ? null : record(error.cause)
    if (
      typeof error.code !== "number" ||
      !Number.isInteger(error.code) ||
      error.code < 1 ||
      error.code > 16 ||
      typeof error.message !== "string" ||
      error.message.length === 0 ||
      (cause !== null && (typeof cause.name !== "string" || typeof cause.message !== "string"))
    ) {
      throw new Error(`${runtime} mTLS ${kind} rejection error was invalid`)
    }
  }
  return Object.freeze({
    exitCode: 0 as const,
    cases: Object.freeze({
      none: "rejected" as const,
      untrusted: "rejected" as const,
      wrongTrust: "rejected" as const,
      trusted: Object.freeze({ id: "mtls-order" as const, state: "READY" as const })
    }),
    managerCleanups: 4 as const,
    rejectionErrors: rejectionErrors as PublishedMtlsRuntimeEvidence["upstream"]["rejectionErrors"],
    rejectionContexts: Object.freeze({
      noneTimedOut: false as const,
      untrustedTimedOut: false as const,
      wrongTrustTimedOut: false as const
    })
  })
}

function runtimeArgv(
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  entry: string,
  ...args: readonly string[]
): readonly string[] {
  if (runtime === "node") return ["node", entry, ...args]
  if (runtime === "bun") return ["bun", entry, ...args]
  return ["deno", "run", "--no-prompt", "--allow-net", "--allow-read", entry, ...args]
}

export async function runBufMatrix(
  root: string,
  directory: TempDirectory,
  stage: string,
  environment: Readonly<Record<string, string | undefined>>,
  launcher: string,
  endpoint: string,
  signal?: AbortSignal
): Promise<PublishedInteropRuntimeEvidence["buf"]> {
  const call = async (method: string, data: string): Promise<readonly Record<string, unknown>[]> =>
    parsePublishedJsonValues(
      await command(
        root,
        directory,
        stage,
        [
          launcher,
          "curl",
          "--schema",
          "proto",
          "--reflect=false",
          "--protocol",
          "grpc",
          "--http2-prior-knowledge",
          "--data",
          data,
          `${endpoint}order.v1.OrderService/${method}`
        ],
        environment,
        60_000,
        signal
      )
    )

  const single = async (method: string, data: string): Promise<Record<string, unknown>> => {
    const values = await call(method, data)
    const value = values[0]
    if (values.length !== 1 || value === undefined) {
      throw new Error(`published Buf ${method} must return exactly one response object`)
    }
    return value
  }

  const unary = await single("GetOrder", '{"id":"buf-order"}')
  const serverStreaming = await call("WatchOrders", '{"customerId":"buf-customer"}')
  const clientStreaming = await single(
    "UploadEvents",
    [
      '{"orderId":"buf-upload-1","type":"CREATED"}',
      '{"orderId":"buf-upload-2","type":"PAID"}',
      '{"orderId":"buf-upload-3","type":"SHIPPED"}'
    ].join("\n")
  )
  const bidi = await call(
    "SyncOrders",
    ['{"orderId":"buf-sync-1","action":"CREATE"}', '{"orderId":"buf-sync-2","action":"SHIP"}'].join(
      "\n"
    )
  )
  const result = {
    unary,
    serverStreaming,
    clientStreaming,
    bidi
  }
  assertExactJson(result, ExpectedBufResult, "Buf curl")
  return Object.freeze({
    exitCodes: Object.freeze({
      unary: 0 as const,
      serverStreaming: 0 as const,
      clientStreaming: 0 as const,
      bidi: 0 as const
    }),
    result: result as PublishedCardinalityResult
  })
}

interface PublishedServerReady {
  readonly endpoint: string
  readonly pid: number
  readonly version: string
}

const PublishedServerReadyTimeoutMs = 15_000

function serverReadyRecord(
  line: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  version: string,
  protocol: "http:" | "https:" = "http:"
): PublishedServerReady {
  const value = record(JSON.parse(line))
  if (
    value.kind !== "managed-server-ready" ||
    value.runtime !== runtime ||
    value.version !== version ||
    typeof value.endpoint !== "string" ||
    !Number.isSafeInteger(value.pid) ||
    !(Number(value.pid) > 0)
  ) {
    throw new Error(`${runtime} published server ready record was invalid`)
  }
  const endpoint = new URL(value.endpoint)
  if (
    endpoint.protocol !== protocol ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port.length === 0 ||
    endpoint.pathname !== "/" ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new Error(`${runtime} published server endpoint was invalid`)
  }
  return Object.freeze({ endpoint: endpoint.href, pid: Number(value.pid), version })
}

function serverTerminalEvidence(
  output: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  ready: PublishedServerReady,
  expectedCounters: Readonly<{
    unary: number
    serverStreaming: number
    clientStreaming: number
    bidi: number
  }>,
  protocol: "http:" | "https:"
) {
  const lines = output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length !== 2) throw new Error(`${runtime} published server emitted unexpected records`)
  const first = lines[0]
  const last = lines[1]
  if (first === undefined || last === undefined) {
    throw new Error(`${runtime} published server records were unavailable`)
  }
  const observedReady = serverReadyRecord(first, runtime, ready.version, protocol)
  if (observedReady.endpoint !== ready.endpoint || observedReady.pid !== ready.pid) {
    throw new Error(`${runtime} published server ready record changed`)
  }
  const terminal = record(JSON.parse(last))
  if (
    terminal.kind !== "managed-server-terminal" ||
    terminal.runtime !== runtime ||
    terminal.version !== ready.version ||
    terminal.reason !== "SIGTERM"
  ) {
    throw new Error(`${runtime} published server terminal identity was invalid`)
  }
  assertExactJson(terminal.counters, expectedCounters, `${runtime} server counters`)
  assertExactJson(terminal.cleanup, { server: true, running: true }, `${runtime} server cleanup`)
  return Object.freeze({
    exitCode: 0 as const,
    reason: "SIGTERM" as const,
    counters: Object.freeze({ ...expectedCounters }),
    cleanup: true as const
  })
}

async function runExternalClients(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  launcher: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  ready: PublishedServerReady,
  signal?: AbortSignal
): Promise<Pick<PublishedInteropRuntimeEvidence, "upstream" | "buf">> {
  const upstreamOutput = await command(
    root,
    directory,
    stage,
    runtimeArgv(runtime, paths.upstreamOutput, ready.endpoint),
    environment,
    60_000,
    signal
  )
  const upstream = upstreamRuntimeEvidence(upstreamOutput, runtime, ready.version)
  const buf = await runBufMatrix(
    root,
    directory,
    stage,
    environment,
    launcher,
    ready.endpoint,
    signal
  )
  return Object.freeze({ upstream, buf })
}

async function runBufMtlsUnary(
  root: string,
  directory: TempDirectory,
  stage: string,
  environment: Readonly<Record<string, string | undefined>>,
  launcher: string,
  endpoint: string,
  fixture: PublishedMtlsFixture,
  signal?: AbortSignal
): Promise<NonNullable<PublishedMtlsRuntimeEvidence["buf"]>> {
  const values = parsePublishedJsonValues(
    await command(
      root,
      directory,
      stage,
      [
        launcher,
        "curl",
        "--schema",
        "proto",
        "--reflect=false",
        "--protocol",
        "grpc",
        "--cacert",
        fixture.paths.trustedCaCertificate,
        "--cert",
        fixture.paths.trustedClientCertificate,
        "--key",
        fixture.paths.clientKey,
        "--servername",
        "localhost",
        "--data",
        '{"id":"mtls-buf-order"}',
        `${endpoint}order.v1.OrderService/GetOrder`
      ],
      environment,
      60_000,
      signal
    )
  )
  const result = values[0]
  if (values.length !== 1 || result === undefined) {
    throw new Error("published Buf mTLS unary must return exactly one response object")
  }
  assertExactJson(result, { id: "mtls-buf-order", state: "READY" }, "Buf mTLS unary")
  return Object.freeze({
    exitCode: 0 as const,
    result: Object.freeze({ id: "mtls-buf-order" as const, state: "READY" as const })
  })
}

async function runMtlsClients(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  launcher: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  ready: PublishedServerReady,
  fixture: PublishedMtlsFixture,
  signal?: AbortSignal
): Promise<Pick<PublishedMtlsRuntimeEvidence, "upstream" | "buf">> {
  const output = await command(
    root,
    directory,
    stage,
    runtimeArgv(
      runtime,
      paths.upstreamOutput,
      "mtls-unary",
      ready.endpoint,
      fixture.paths.trustedCaCertificate,
      fixture.paths.trustedClientCertificate,
      fixture.paths.untrustedClientCertificate,
      fixture.paths.clientKey,
      fixture.paths.untrustedCaCertificate
    ),
    environment,
    60_000,
    signal
  )
  const upstream = parsePublishedMtlsUpstreamEvidence(output, runtime, ready.version)
  const buf =
    runtime === "node"
      ? await runBufMtlsUnary(
          root,
          directory,
          stage,
          environment,
          launcher,
          ready.endpoint,
          fixture,
          signal
        )
      : null
  return Object.freeze({ upstream, buf })
}

async function runClientsAndStop<Evidence>(
  clients: () => Promise<Evidence>,
  pid: number
): Promise<Evidence> {
  let evidence: Evidence | null = null
  let primary: Error | null = null
  try {
    evidence = await clients()
  } catch (error) {
    primary = errorValue(error, "published external clients failed")
  }
  let signalFailure: Error | null = null
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    signalFailure = errorValue(error, "published server SIGTERM failed")
  }
  if (primary !== null && signalFailure !== null) {
    throw new AggregateError([primary, signalFailure], "clients failed and server signal failed")
  }
  if (primary !== null) throw primary
  if (signalFailure !== null) throw signalFailure
  if (evidence === null) throw new Error("published external clients produced no evidence")
  return evidence
}

async function runRuntimeServer<Evidence>(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  version: string,
  serverArgs: readonly string[],
  protocol: "http:" | "https:",
  expectedCounters: Readonly<{
    unary: number
    serverStreaming: number
    clientStreaming: number
    bidi: number
  }>,
  clientsFor: (ready: PublishedServerReady) => Promise<Evidence>,
  signal?: AbortSignal,
  readyTimeoutMs = PublishedServerReadyTimeoutMs
) {
  const state: {
    live: string
    ready: PublishedServerReady | null
    clients: Promise<Evidence> | null
    callbackError: Error | null
  } = { live: "", ready: null, clients: null, callbackError: null }

  const readyController = new AbortController()
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  const clearReadyTimer = (): void => {
    if (readyTimer === null) return
    clearTimeout(readyTimer)
    readyTimer = null
  }

  const onStdout = (chunk: string): void => {
    if (state.ready !== null || state.callbackError !== null) return
    state.live += chunk
    const newline = state.live.indexOf("\n")
    if (newline === -1) return
    try {
      const ready = serverReadyRecord(
        state.live.slice(0, newline).trim(),
        runtime,
        version,
        protocol
      )
      state.ready = ready
      clearReadyTimer()
      state.clients = runClientsAndStop(() => clientsFor(ready), ready.pid)
      void state.clients.catch(() => {})
    } catch (error) {
      state.callbackError = errorValue(error, `${runtime} server ready callback failed`)
      clearReadyTimer()
      readyController.abort(state.callbackError)
    }
  }

  await verifyTempDirectory(directory)
  readyTimer = setTimeout(() => {
    const failure = new Error(
      `${runtime} published server ready deadline exceeded ${readyTimeoutMs}ms`
    )
    state.callbackError = failure
    readyController.abort(failure)
  }, readyTimeoutMs)
  const abortFromCaller = (): void => {
    clearReadyTimer()
    readyController.abort(signal?.reason)
  }
  if (signal?.aborted === true) abortFromCaller()
  else signal?.addEventListener("abort", abortFromCaller, { once: true })
  const serverArgv = runtimeArgv(runtime, paths.nativeOutput, ...serverArgs)
  let serverResult: CommandResult | null = null
  let serverThrown: Error | null = null
  try {
    serverResult = await runCommand(root, {
      cwd: stage,
      command: serverArgv,
      timeoutMs: 180_000,
      signal: readyController.signal,
      environment,
      onStdout
    })
  } catch (error) {
    serverThrown = errorValue(error, `${runtime} published server failed`)
  } finally {
    clearReadyTimer()
    signal?.removeEventListener("abort", abortFromCaller)
  }

  let clients: Evidence | null = null
  let clientFailure: Error | null = null
  if (state.clients === null) {
    clientFailure = new Error(`${runtime} published server emitted no ready record`)
  } else {
    try {
      clients = await state.clients
    } catch (error) {
      clientFailure = errorValue(error, `${runtime} published external clients failed`)
    }
  }

  const failures = [serverThrown, state.callbackError, clientFailure].filter(
    (failure): failure is Error => failure !== null
  )
  if (serverResult !== null) {
    const failure = commandFailure(serverArgv, serverResult)
    if (failure !== null) failures.push(failure)
  }
  if (serverResult === null && serverThrown === null) {
    failures.push(new Error(`${runtime} published server produced no process result`))
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${runtime} interop failed`)
  if (serverResult === null || clients === null || state.ready === null) {
    throw new Error(`${runtime} interop produced incomplete evidence`)
  }
  return Object.freeze({
    clients,
    server: serverTerminalEvidence(
      serverResult.stdout,
      runtime,
      state.ready,
      expectedCounters,
      protocol
    )
  })
}

export async function runRuntimeInterop(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  launcher: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  version: string,
  signal?: AbortSignal,
  readyTimeoutMs = PublishedServerReadyTimeoutMs
): Promise<PublishedInteropRuntimeEvidence> {
  const result = await runRuntimeServer(
    root,
    directory,
    stage,
    paths,
    environment,
    runtime,
    version,
    ["server"],
    "http:",
    { unary: 2, serverStreaming: 2, clientStreaming: 2, bidi: 2 },
    async (ready) =>
      await runExternalClients(
        root,
        directory,
        stage,
        paths,
        environment,
        launcher,
        runtime,
        ready,
        signal
      ),
    signal,
    readyTimeoutMs
  )
  return Object.freeze({
    runtime,
    version,
    ...result.clients,
    server: result.server as PublishedInteropRuntimeEvidence["server"]
  })
}

async function runRuntimeMtls(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  launcher: string,
  runtime: PublishedNativeRuntimeEvidence["runtime"],
  version: string,
  fixture: PublishedMtlsFixture,
  signal?: AbortSignal
): Promise<PublishedMtlsRuntimeEvidence> {
  const unary = runtime === "node" ? 2 : 1
  const result = await runRuntimeServer(
    root,
    directory,
    stage,
    paths,
    environment,
    runtime,
    version,
    [
      "mtls-server",
      fixture.paths.trustedCaCertificate,
      fixture.paths.serverCertificate,
      fixture.paths.serverKey
    ],
    "https:",
    { unary, serverStreaming: 0, clientStreaming: 0, bidi: 0 },
    async (ready) =>
      await runMtlsClients(
        root,
        directory,
        stage,
        paths,
        environment,
        launcher,
        runtime,
        ready,
        fixture,
        signal
      ),
    signal
  )
  return Object.freeze({
    runtime,
    version,
    ...result.clients,
    server: result.server as PublishedMtlsRuntimeEvidence["server"]
  })
}

async function runNativeMatrix(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal
): Promise<PublishedNativeEvidence> {
  const nativeEntry = join(stage, "test/e2e/native-runtime.ts")
  await assertRegularContained(stage, nativeEntry)
  await assertRegularContained(stage, join(stage, "test/e2e/native-harness.ts"))
  await command(
    root,
    directory,
    stage,
    [
      "bun",
      "build",
      nativeEntry,
      "--target=node",
      "--format=esm",
      "--packages=external",
      `--outfile=${paths.nativeOutput}`,
      `--metafile=${paths.nativeMetafile}`
    ],
    environment,
    120_000,
    signal
  )
  await assertRegularContained(stage, paths.nativeOutput)
  await assertRegularContained(stage, paths.nativeMetafile)
  await validatePublishedNativeMetafile(stage, paths.nativeMetafile)
  const sha256 = createHash("sha256")
    .update(await readFile(paths.nativeOutput))
    .digest("hex")

  const upstreamEntry = join(stage, "test/e2e/native-upstream.ts")
  await assertRegularContained(stage, upstreamEntry)
  await command(
    root,
    directory,
    stage,
    [
      "bun",
      "build",
      upstreamEntry,
      "--target=node",
      "--format=esm",
      "--packages=external",
      `--outfile=${paths.upstreamOutput}`,
      `--metafile=${paths.upstreamMetafile}`
    ],
    environment,
    120_000,
    signal
  )
  await assertRegularContained(stage, paths.upstreamOutput)
  await assertRegularContained(stage, paths.upstreamMetafile)
  await validatePublishedUpstreamMetafile(stage, paths.upstreamMetafile)
  const upstreamSha256 = createHash("sha256")
    .update(await readFile(paths.upstreamOutput))
    .digest("hex")

  const browserEntry = join(stage, "browser.ts")
  await assertRegularContained(stage, browserEntry)
  await command(
    root,
    directory,
    stage,
    [
      "bun",
      "build",
      browserEntry,
      "--target=browser",
      "--format=esm",
      `--outfile=${paths.browserOutput}`,
      `--metafile=${paths.browserMetafile}`
    ],
    environment,
    120_000,
    signal
  )
  const browser = await validatePublishedBrowserBundle(
    stage,
    paths.browserMetafile,
    paths.browserOutput
  )

  const invocations = [
    { runtime: "node" as const, argv: ["node", paths.nativeOutput, "self-test"] },
    { runtime: "bun" as const, argv: ["bun", paths.nativeOutput, "self-test"] },
    {
      runtime: "deno" as const,
      argv: ["deno", "run", "--allow-net", "--allow-read", paths.nativeOutput, "self-test"]
    }
  ]
  const runtimes: PublishedNativeRuntimeEvidence[] = []
  for (const invocation of invocations) {
    const output = await command(
      root,
      directory,
      stage,
      invocation.argv,
      environment,
      120_000,
      signal
    )
    runtimes.push(parsePublishedNativeRuntimeEvidence(output, invocation.runtime))
  }
  const launcher = await validateInstalledBuf(stage)
  const mtlsFixture = await createPublishedMtlsFixture(root, directory, environment, signal)
  const interopRuntimes: PublishedInteropRuntimeEvidence[] = []
  for (const runtime of runtimes) {
    interopRuntimes.push(
      await runRuntimeInterop(
        root,
        directory,
        stage,
        paths,
        environment,
        launcher,
        runtime.runtime,
        runtime.version,
        signal
      )
    )
  }
  const mtlsRuntimes: PublishedMtlsRuntimeEvidence[] = []
  for (const runtime of runtimes) {
    mtlsRuntimes.push(
      await runRuntimeMtls(
        root,
        directory,
        stage,
        paths,
        environment,
        launcher,
        runtime.runtime,
        runtime.version,
        mtlsFixture,
        signal
      )
    )
  }
  return Object.freeze({
    entry: "compiled/native-runtime.js" as const,
    sha256,
    runtimes: Object.freeze(runtimes),
    interoperability: Object.freeze({
      entry: "compiled/native-upstream.js" as const,
      sha256: upstreamSha256,
      runtimes: Object.freeze(interopRuntimes)
    }),
    mtls: Object.freeze({
      opensslVersion: mtlsFixture.opensslVersion,
      certificates: mtlsFixture.evidence,
      runtimes: Object.freeze(mtlsRuntimes)
    }),
    browser
  })
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
  throw new Error(`unexpected published marker exists: ${basename(path)}`)
}

async function expectConsumerFailure(
  root: string,
  directory: TempDirectory,
  stage: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  marker: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await execute(root, directory, stage, argv, environment, 120_000, signal)
  const failure = commandFailure(argv, result)
  if (failure === null) {
    await writeFile(marker, "unexpected success\n", { encoding: "utf8", flag: "wx", mode: 0o600 })
    throw new Error(`${sanitizeArgv(argv).join(" ")} unexpectedly resolved a hidden package`)
  }
  if (
    result.cleanupFailures.length > 0 ||
    result.timedOut ||
    result.termination !== "exit" ||
    result.exitCode === null
  ) {
    throw failure
  }
  if (!`${result.stdout}\n${result.stderr}`.includes("@go-like/context")) {
    throw new Error(`${sanitizeArgv(argv).join(" ")} failed for an unrelated reason`, {
      cause: failure
    })
  }
  await assertMissing(marker)
}

async function runHidePackageNegatives(
  root: string,
  directory: TempDirectory,
  stage: string,
  paths: PublishedStagePaths,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal
): Promise<void> {
  const installed = join(stage, "node_modules/@go-like/context")
  const hidden = join(stage, "node_modules/@go-like/.context-hidden")
  await rename(installed, hidden)
  let primary: Error | null = null
  try {
    await expectConsumerFailure(
      root,
      directory,
      stage,
      ["node", "compiled/node/node.js"],
      environment,
      join(paths.markers, "node-hidden"),
      signal
    )
    await expectConsumerFailure(
      root,
      directory,
      stage,
      ["bun", "--no-install", "bun.ts"],
      environment,
      join(paths.markers, "bun-hidden"),
      signal
    )
  } catch (error) {
    primary = errorValue(error, "published hide-package negative failed")
  }
  const cleanupFailures: CleanupFailure[] = []
  await collectCleanupFailure(cleanupFailures, "published hidden package restore", () =>
    rename(hidden, installed)
  )
  finalizeWithCleanup(primary, cleanupFailures, "published negative failed and restore failed")
}

export async function copyPublishedFixture(
  root: string,
  directory: TempDirectory
): Promise<PublishedStagePaths> {
  const paths = await createStagePaths(directory)
  const stage = directory.path
  const fixture = join(root, "e2e/fixtures/published-consumer")
  for (const path of FixtureFiles) await copyFile(join(fixture, path), join(stage, path))
  const nativeSource = join(root, "packages/transport/grpc-buf/test/e2e")
  for (const path of NativeSourceFiles) {
    await copyFile(join(nativeSource, path), join(stage, "test/e2e", path))
  }
  return paths
}

async function writeMarker(paths: PublishedStagePaths, name: string): Promise<void> {
  await writeFile(join(paths.markers, name), "passed\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  })
}

export async function runPublishedE2e(
  root: string,
  signal?: AbortSignal
): Promise<PublishedNativeEvidence> {
  signal?.throwIfAborted()
  const directory = await createTempDirectory("go-like-published-")
  const stage = directory.path
  let primary: Error | null = null
  let nativeEvidence: PublishedNativeEvidence | null = null
  try {
    const paths = await copyPublishedFixture(root, directory)
    const environment = publishedEnvironment(stage)
    const packages = await packageRoots(root)
    const tarballs: string[] = []
    for (const entry of packages) {
      const output = await command(
        root,
        directory,
        entry.root,
        ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", paths.tarballs],
        environment,
        120_000,
        signal
      )
      const tarball = join(paths.tarballs, parseNpmPackOutput(output, entry.name))
      await assertRegularContained(paths.tarballs, tarball)
      tarballs.push(tarball)
    }

    await command(
      root,
      directory,
      stage,
      [
        "npm",
        "install",
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--loglevel=error",
        ...tarballs
      ],
      environment,
      300_000,
      signal
    )
    await validateInstalledPackages(stage, packages)
    const pluginTarget = await validateInstalledProtocGenLike(stage)
    const nodeVersion = await command(
      root,
      directory,
      stage,
      ["node", "--version"],
      environment,
      120_000,
      signal
    )
    validatePublishedNodeVersion(nodeVersion)

    const pluginLauncher = join(stage, "node_modules/.bin/protoc-gen-like")
    if ((await realpath(pluginLauncher)) !== (await realpath(pluginTarget))) {
      throw new Error("installed protoc-gen-like launcher did not resolve to its package target")
    }
    const pluginVersion = await command(
      root,
      directory,
      stage,
      [pluginLauncher, "--version"],
      environment,
      120_000,
      signal
    )
    if (pluginVersion !== "protoc-gen-like 0.0.1") {
      throw new Error(`installed protoc-gen-like returned an unexpected version: ${pluginVersion}`)
    }
    await command(
      root,
      directory,
      stage,
      ["npm", "run", "proto:generate"],
      environment,
      120_000,
      signal
    )
    const generatedProbe = join(stage, ".artifacts/gen/published/v1")
    await assertRegularContained(generatedProbe, join(generatedProbe, "probe_pb.ts"))
    await assertRegularContained(generatedProbe, join(generatedProbe, "probe_like.ts"))
    const generatedOrder = join(stage, ".artifacts/gen/order/v1")
    await assertRegularContained(generatedOrder, join(generatedOrder, "order_pb.ts"))
    await assertRegularContained(generatedOrder, join(generatedOrder, "order_like.ts"))

    const trace = await command(
      root,
      directory,
      stage,
      [
        resolve(root, "node_modules/.bin/tsc"),
        "-p",
        "tsconfig.types.json",
        "--traceResolution",
        "--pretty",
        "false"
      ],
      environment,
      120_000,
      signal
    )
    validatePublishedTrace(
      trace,
      stage,
      packages.map((entry) => entry.name)
    )
    await command(
      root,
      directory,
      stage,
      [resolve(root, "node_modules/.bin/tsc"), "-p", "tsconfig.node.json", "--pretty", "false"],
      environment,
      120_000,
      signal
    )
    await validateNodeOutput(paths)
    nativeEvidence = await runNativeMatrix(root, directory, stage, paths, environment, signal)

    await command(
      root,
      directory,
      stage,
      ["node", "compiled/node/node.js"],
      environment,
      120_000,
      signal
    )
    await writeMarker(paths, "node")
    await command(
      root,
      directory,
      stage,
      ["bun", "--no-install", "bun.ts"],
      environment,
      120_000,
      signal
    )
    await writeMarker(paths, "bun")
    await command(
      root,
      directory,
      stage,
      ["deno", "check", "--config", "deno.json", "--node-modules-dir=manual", "deno.ts"],
      environment,
      120_000,
      signal
    )
    await command(
      root,
      directory,
      stage,
      [
        "deno",
        "run",
        "--no-prompt",
        "--config",
        "deno.json",
        "--node-modules-dir=manual",
        "deno.ts"
      ],
      environment,
      120_000,
      signal
    )
    await writeMarker(paths, "deno")
    await runHidePackageNegatives(root, directory, stage, paths, environment, signal)
  } catch (error) {
    primary = errorValue(error, "published E2E failed")
  }
  const cleanupFailures: CleanupFailure[] = []
  await collectCleanupFailure(cleanupFailures, "published stage cleanup", () =>
    removeTempDirectory(directory)
  )
  finalizeWithCleanup(primary, cleanupFailures, "published E2E failed and cleanup failed")
  if (nativeEvidence === null) throw new Error("published E2E produced no native evidence")
  return nativeEvidence
}

if (import.meta.main) {
  const controller = new AbortController()
  const onSigint = () => controller.abort(new Error("published E2E interrupted by SIGINT"))
  const onSigterm = () => controller.abort(new Error("published E2E interrupted by SIGTERM"))
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    const native = await runPublishedE2e(resolve(import.meta.dir, ".."), controller.signal)
    process.stdout.write(`${JSON.stringify({ published: true, native })}\n`)
  } catch (error) {
    process.stderr.write(`${errorSummary(error)}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}
