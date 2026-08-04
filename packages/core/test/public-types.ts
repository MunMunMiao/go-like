import { background, type Context } from "@go-like/context"
import type { Registrar } from "@go-like/registry"
import * as Core from "../src/index"
import {
  afterStart,
  afterStop,
  fromContext,
  beforeStart,
  beforeStop,
  context,
  endpoint,
  id,
  metadata,
  name,
  newApp,
  registrar,
  registrarTimeout,
  server,
  startTimeout,
  stopTimeout,
  version,
  newContext,
  type App,
  type AppHook,
  type AppInfo,
  type AppOption,
  type Endpointer,
  type Server
} from "../src/index"
import { waitForContext } from "../src/lifecycle"
import { signal } from "../src/node"

const structural: Server = {
  async start() {},
  async stop() {}
}
const endpointer: Endpointer = {
  endpoint: () => "https://typed.example"
}
declare const registry: Registrar
const hook: AppHook = async () => {}
const options: AppOption[] = [
  context(background()),
  id("typed-id"),
  name("typed"),
  version("v1"),
  metadata({ role: "test" }),
  endpoint("https://typed.example"),
  registrar(registry),
  registrarTimeout(10_000),
  startTimeout(30_000),
  stopTimeout(1_000),
  beforeStart(hook),
  afterStart(hook),
  beforeStop(hook),
  afterStop(hook),
  server(structural),
  signal()
]
const app: App = newApp(...options)
const running: Promise<void> = app.run()
const stopping: Promise<void> = app.stop()
const waited: Promise<number> = waitForContext(background(), Promise.resolve(1))
const info: AppInfo = app
const infoContext: Context = newContext(background(), info)
const readInfo: AppInfo | null = fromContext(infoContext)

void [endpointer, running, stopping, waited, info, infoContext, readInfo]

// @ts-expect-error Public interfaces are type-only.
Core.App
// @ts-expect-error Removed handle type is not exported.
type RemovedHandle = import("../src/index").AppHandle
// @ts-expect-error App is run directly rather than started for a handle.
app.start(background())
// @ts-expect-error Server start does not return a handle.
const invalidStart: Promise<{ done(): Promise<void> }> = structural.start(background())
// @ts-expect-error Runtime values remain lowerCamelCase.
Core.NewApp()
// @ts-expect-error waitForContext remains on its established subpath.
Core.waitForContext(background(), Promise.resolve())

void (null as RemovedHandle | null)
void invalidStart
