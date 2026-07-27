import { createServer } from "node:http"
import { once } from "node:events"
import { cp, mkdir, readFile, readlink, rm, symlink, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface WebHandler {
  (request: Request): Response | Promise<Response>
}

interface FetchApplication {
  fetch(request: Request): Response | Promise<Response>
}

interface HonoContext {
  readonly req: {
    param(name: string): string
  }
  json(value: unknown): Response
}

interface HonoApplication extends FetchApplication {
  get(path: string, handler: (context: HonoContext) => Response): HonoApplication
}

interface H3Application {
  use(handler: unknown): H3Application
}

interface H3Router {
  readonly handler: unknown
  get(path: string, handler: unknown): H3Router
}

interface ElysiaContext {
  readonly params: Readonly<Record<string, string>>
}

interface ElysiaApplication extends FetchApplication {
  get(path: string, handler: (context: ElysiaContext) => unknown): ElysiaApplication
}

type ZeroArgumentConstructor<Value> = new () => Value
type FrameworkHandlerFactory = (application: FetchApplication) => WebHandler

interface ManagedServer {
  start(ctx: unknown): Promise<void>
  stop(ctx: unknown): Promise<void>
  endpoint(ctx: unknown): string | PromiseLike<string>
}

interface FrameworkContract {
  readonly scenario: string
  readonly path: string
  readonly frameworkPackage: "hono" | "h3" | "elysia" | null
  readonly expectedFramework: string | null
}

const Contracts: Readonly<Record<string, FrameworkContract>> = Object.freeze({
  vanilla: {
    scenario: "vanilla-fetch-live-listener",
    path: "/live",
    frameworkPackage: null,
    expectedFramework: null
  },
  hono: {
    scenario: "hono-fetch-live-listener",
    path: "/users/99",
    frameworkPackage: "hono",
    expectedFramework: "hono"
  },
  elysia: {
    scenario: "elysia-fetch-live-listener",
    path: "/users/99",
    frameworkPackage: "elysia",
    expectedFramework: "elysia"
  },
  h3: {
    scenario: "h3-fetch-live-listener",
    path: "/status",
    frameworkPackage: "h3",
    expectedFramework: "h3"
  }
})

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const e2eNodeModules = resolve(repoRoot, "e2e/node_modules")

/** Reports whether one unknown failure exposes a stable filesystem error code. */
function hasErrorCode(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
  )
}

/** Loads one package by runtime identity without importing its vendor declaration graph. */
async function runtimePackage(packageName: string): Promise<Readonly<Record<string, unknown>>> {
  const value: unknown = await import(packageName)
  if (typeof value !== "object" || value === null) {
    throw new Error(`${packageName} did not expose an ESM package namespace`)
  }
  return value as Readonly<Record<string, unknown>>
}

/** Reads one required named runtime export from a validated package namespace. */
function packageExport<Value>(
  packageName: string,
  namespace: Readonly<Record<string, unknown>>,
  exportName: string
): Value {
  const value = namespace[exportName]
  if (value === undefined) throw new Error(`${packageName} does not export ${exportName}`)
  return value as Value
}

/** Creates one exact package-resolution link for the standalone Node evidence process. */
async function ensurePackageLink(packageName: string, target: string): Promise<void> {
  const link = resolve(e2eNodeModules, ...packageName.split("/"))
  await mkdir(dirname(link), { recursive: true })
  for (;;) {
    let current: string | null = null
    try {
      current = resolve(dirname(link), await readlink(link))
    } catch (error: unknown) {
      if (!hasErrorCode(error) || error.code !== "ENOENT") throw error
    }
    if (current === target) return
    if (current !== null) {
      try {
        await unlink(link)
      } catch (error: unknown) {
        if (!hasErrorCode(error) || error.code !== "ENOENT") throw error
      }
      continue
    }
    try {
      await symlink(target, link, "dir")
      return
    } catch (error: unknown) {
      if (!hasErrorCode(error) || error.code !== "EEXIST") throw error
    }
  }
}

/** Installs one built workspace package as a physical Node package tree. */
async function installBuiltPackage(packageName: string, target: string): Promise<void> {
  const destination = resolve(e2eNodeModules, ...packageName.split("/"))
  await mkdir(dirname(destination), { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await cp(target, destination, { recursive: true })
}

/** Installs only the final package identities needed by the native Web evidence process. */
async function ensurePackageLinks(): Promise<void> {
  for (const name of ["context", "core", "health", "web", "hono", "h3", "elysia"]) {
    await installBuiltPackage(`@likego/${name}`, resolve(repoRoot, "packages", name, "dist"))
  }
  await ensurePackageLink("hono", resolve(repoRoot, "packages/hono/node_modules/hono"))
  await ensurePackageLink("h3", resolve(repoRoot, "packages/h3/node_modules/h3"))
  await ensurePackageLink("elysia", resolve(repoRoot, "packages/elysia/node_modules/elysia"))
  await ensurePackageLink(
    "@hono/node-server",
    resolve(repoRoot, "packages/web/node_modules/@hono/node-server")
  )
}

/** Reads an installed package version without trusting a suite-authored service label. */
async function packageVersion(packageName: string): Promise<string> {
  const path = resolve(e2eNodeModules, ...packageName.split("/"), "package.json")
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`${packageName} package metadata has no version`)
  }
  return value.version
}

/** Creates the selected minimal native framework application through final package exports. */
async function frameworkHandler(kind: string): Promise<WebHandler> {
  if (kind === "vanilla") {
    return function vanillaHandler(request: Request): Response {
      return Response.json({ method: request.method, path: new URL(request.url).pathname })
    }
  }
  if (kind === "hono") {
    const [framework, bridge] = await Promise.all([
      runtimePackage("hono"),
      runtimePackage("@likego/hono")
    ])
    const Hono = packageExport<ZeroArgumentConstructor<HonoApplication>>("hono", framework, "Hono")
    const newHonoHandler = packageExport<FrameworkHandlerFactory>(
      "@likego/hono",
      bridge,
      "newHonoHandler"
    )
    const app = new Hono().get("/users/:id", (context) =>
      context.json({
        framework: "hono",
        id: context.req.param("id")
      })
    )
    return newHonoHandler(app)
  }
  if (kind === "h3") {
    const [framework, bridge] = await Promise.all([
      runtimePackage("h3"),
      runtimePackage("@likego/h3")
    ])
    const createApp = packageExport<() => H3Application>("h3", framework, "createApp")
    const createRouter = packageExport<() => H3Router>("h3", framework, "createRouter")
    const defineEventHandler = packageExport<(handler: () => unknown) => unknown>(
      "h3",
      framework,
      "defineEventHandler"
    )
    const newH3Handler = packageExport<(application: H3Application) => WebHandler>(
      "@likego/h3",
      bridge,
      "newH3Handler"
    )
    const router = createRouter().get(
      "/status",
      defineEventHandler(() => ({ framework: "h3", ok: true }))
    )
    const app = createApp().use(router.handler)
    return newH3Handler(app)
  }
  if (kind === "elysia") {
    const [framework, bridge] = await Promise.all([
      runtimePackage("elysia"),
      runtimePackage("@likego/elysia")
    ])
    const Elysia = packageExport<ZeroArgumentConstructor<ElysiaApplication>>(
      "elysia",
      framework,
      "Elysia"
    )
    const newElysiaHandler = packageExport<FrameworkHandlerFactory>(
      "@likego/elysia",
      bridge,
      "newElysiaHandler"
    )
    const app = new Elysia().get("/users/:id", ({ params }) => ({
      framework: "elysia",
      id: params.id
    }))
    return newElysiaHandler(app)
  }
  throw new Error(`unknown web framework evidence target ${kind}`)
}

await ensurePackageLinks()

const kind = process.argv[2] ?? ""
const contract = Contracts[kind]
if (contract === undefined) throw new Error(`unknown web framework evidence target ${kind}`)

const [{ background }, { newNodeServer }] = await Promise.all([
  import("@likego/context"),
  import("@likego/web/node")
])
const server: ManagedServer = newNodeServer(await frameworkHandler(kind))
const running = server.start(background())
void running.catch(() => {})
const endpoint = new URL(await server.endpoint(background()))
let responseStatus = -1
let responseBody: Readonly<Record<string, unknown>> = {}
let terminalCompleted = false
let portReleased = false
try {
  const response = await fetch(new URL(contract.path, endpoint))
  responseStatus = response.status
  const value: unknown = await response.json()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${kind} live listener returned a non-object payload`)
  }
  responseBody = value as Readonly<Record<string, unknown>>
  if (responseStatus !== 200) throw new Error(`${kind} live listener returned ${responseStatus}`)
  if (kind === "vanilla") {
    if (responseBody.method !== "GET" || responseBody.path !== "/live") {
      throw new Error("vanilla Web listener changed method or path")
    }
  } else if (responseBody.framework !== contract.expectedFramework) {
    throw new Error(`${kind} framework identity changed`)
  }
  if ((kind === "hono" || kind === "elysia") && responseBody.id !== "99") {
    throw new Error(`${kind} route parameter changed`)
  }
  if (kind === "h3" && responseBody.ok !== true) throw new Error("H3 status payload changed")
} finally {
  await server.stop(background())
  await running
  terminalCompleted = true
}

const listener = createServer(function respond(_request, response) {
  response.end("rebound")
})
listener.listen(Number(endpoint.port), "127.0.0.1")
await once(listener, "listening")
await new Promise<void>(function close(resolveClose, rejectClose) {
  listener.close(function closed(error) {
    if (error === undefined) resolveClose()
    else rejectClose(error)
  })
})
portReleased = true

const frameworkVersion =
  contract.frameworkPackage === null ? null : await packageVersion(contract.frameworkPackage)
const hostVersion = await packageVersion("@hono/node-server")
const scenarioValue =
  kind === "vanilla"
    ? { status: responseStatus, method: responseBody.method, path: responseBody.path }
    : kind === "h3"
      ? {
          status: responseStatus,
          framework: responseBody.framework,
          ok: responseBody.ok
        }
      : {
          status: responseStatus,
          framework: responseBody.framework,
          id: responseBody.id
        }

process.stdout.write(
  `LIKEGO_WEB_FRAMEWORK_E2E_RESULT=${JSON.stringify({
    valid: true,
    runtime: `Node.js ${process.versions.node}`,
    frameworkVersion,
    hostVersion,
    scenarios: [contract.scenario],
    scenarioEvidence: { [contract.scenario]: scenarioValue },
    cleanup: { terminalCompleted, portReleased }
  })}\n`
)
