import { background } from "@likego/context"
import { connect, type NatsConnection } from "@nats-io/transport-node"
import { newNatsCoreServer } from "@likego/nats"

/** Throws when one package-install runtime invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Waits for one installed-package behavior with a bounded deadline. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("installed NATS Core package smoke timed out")
}

/** Closes the application-owned connection after the smoke completes. */
async function closeConnection(connection: NatsConnection | null): Promise<void> {
  if (connection === null || connection.isClosed()) return
  try {
    await connection.drain()
  } catch {
    await connection.close()
  }
}

/** Runs one package-name smoke against a real NATS server. */
async function main(): Promise<void> {
  const serverUrl = process.env.LIKEGO_NATS_URL
  assert(serverUrl !== undefined, "LIKEGO_NATS_URL is required")
  const subject = `likego.smoke.${crypto.randomUUID().replaceAll("-", "")}`
  let connection: NatsConnection | null = null
  try {
    connection = await connect({ servers: serverUrl })
    const payloads: string[] = []
    const subscription = connection.subscribe(subject)
    const server = newNatsCoreServer(subscription)
    const running = server.start(background())
    const consuming = (async () => {
      for await (const message of subscription) {
        assert(message.subject === subject, "application did not receive raw Msg")
        payloads.push(message.string())
      }
    })()
    connection.publish(subject, "installed")
    await connection.flush()
    await waitUntil(() => payloads.length === 1)
    await server.stop(background())
    await running
    await consuming
    assert(payloads[0] === "installed", "installed package changed the payload")
    assert(
      !connection.isClosed() && !connection.isDraining(),
      "installed adapter took connection ownership"
    )
    const runtime = typeof Bun === "undefined" ? process.version : `bun-${Bun.version}`
    console.log(
      `LIKEGO_NATS_CORE_RUNTIME_RESULT=${JSON.stringify({
        valid: true,
        runtime,
        package: "@likego/nats",
        connectionOwnedBy: "application",
        consumptionOwnedBy: "application"
      })}`
    )
  } finally {
    await closeConnection(connection)
  }
}

await main()
