import { afterStart, newApp, telemetry } from "@go-like/core"
import { background } from "@go-like/core/context"
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { newTelemetryRecorder } from "@go-like/core/testing"
import { newTelemetry, withTelemetry } from "@go-like/core/telemetry"
import { endpoint } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const Input = struct.object({ n: struct.number() })
const ping = endpoint("published", "ping", Input, Input)

/** Waits for one ended server span and one ended client span of the same unit. */
async function waitForUnit(
  recorder: ReturnType<typeof newTelemetryRecorder>,
  unit: string
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const ended = recorder.spans().filter((span) => span.name === unit && span.ended)
    const servers = ended.filter((span) => span.kind === "server")
    const clients = ended.filter((span) => span.kind === "client")
    if (servers.length > 1 || clients.length > 1) {
      throw new Error(`published telemetry recorded duplicate ${unit} spans`)
    }
    if (servers.length === 1 && clients.length === 1) return
    if (Date.now() - started > 2000) {
      throw new Error(
        `published telemetry did not record one server and one client span for ${unit}`
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

/** RV3(b): constructs, starts, and stops the App and Telemetry bundles. */
async function runLifecycle(): Promise<void> {
  const bundle = newTelemetry()
  let notifyStarted!: () => void
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const app = newApp(
    telemetry(bundle),
    afterStart(() => {
      notifyStarted()
    })
  )
  const running = app.run()
  try {
    await started
  } finally {
    await app.stop()
    await running
  }
}

/**
 * RV3(c): a recorder installed through `@go-like/core/telemetry` observes a
 * unit opened by the built `/client`, `/server`, and `/transport/memory` entries.
 */
async function runCrossEntryTelemetry(): Promise<void> {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const memory = newMemoryTransport()
  const location = "memory://published-telemetry"
  const server = newServer(transport(memory), address(location))
  server.registerHandler(ping, (_ctx, request) => ({
    n: (request as { readonly n: number }).n + 1
  }))
  const running = server.start(ctx)
  await server.endpoint(background())
  const client = newClient(withTransport(memory), withEndpoint(location))
  try {
    const response = (await client.call(ctx, ping, { n: 1 })) as { readonly n: number }
    if (response.n !== 2) {
      throw new Error(`published telemetry smoke returned ${response.n}, expected 2`)
    }
  } finally {
    await client.close(background())
    await server.stop(background())
    await running
  }
  await waitForUnit(recorder, "published/ping")
}

/** Runs the release checks every published lane shares. */
export async function runPublishedSmoke(): Promise<void> {
  await runLifecycle()
  await runCrossEntryTelemetry()
}
