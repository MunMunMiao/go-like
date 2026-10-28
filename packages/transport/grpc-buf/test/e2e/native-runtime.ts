import process from "node:process"
import { readFile } from "node:fs/promises"

import { clientAuth, tlsConfig, type ServerOption } from "@go-like/transport-grpc-buf/native"

import {
  runManagedSelfTest,
  startManagedServer,
  type NativeRuntimeIdentity
} from "./native-harness.js"

function identity(): NativeRuntimeIdentity {
  const runtimes = globalThis as typeof globalThis & {
    readonly Bun?: { readonly version: string }
    readonly Deno?: { readonly version: { readonly deno: string } }
  }
  if (runtimes.Bun !== undefined) return { runtime: "bun", version: runtimes.Bun.version }
  if (runtimes.Deno !== undefined) return { runtime: "deno", version: runtimes.Deno.version.deno }
  return { runtime: "node", version: process.versions.node }
}

async function waitForShutdown(): Promise<"SIGINT" | "SIGTERM"> {
  return await new Promise((resolve) => {
    const finish = (signal: "SIGINT" | "SIGTERM") => {
      process.removeListener("SIGINT", onSigint)
      process.removeListener("SIGTERM", onSigterm)
      resolve(signal)
    }
    const onSigint = () => finish("SIGINT")
    const onSigterm = () => finish("SIGTERM")
    process.once("SIGINT", onSigint)
    process.once("SIGTERM", onSigterm)
  })
}

async function runServer(
  runtime: NativeRuntimeIdentity,
  ...options: readonly ServerOption[]
): Promise<void> {
  const owner = await startManagedServer(...options)
  console.log(
    JSON.stringify({
      kind: "managed-server-ready",
      ...runtime,
      endpoint: owner.endpoint,
      pid: process.pid
    })
  )
  const reason = await waitForShutdown()
  await owner.stop()
  console.log(
    JSON.stringify({
      kind: "managed-server-terminal",
      ...runtime,
      reason,
      counters: { ...owner.counters },
      cleanup: { server: true, running: true }
    })
  )
}

const runtime = identity()
const mode = process.argv[2] ?? "self-test"
if (mode === "self-test") {
  console.log(JSON.stringify(await runManagedSelfTest(runtime)))
} else if (mode === "server") {
  await runServer(runtime)
} else if (mode === "mtls-server") {
  const ca = process.argv[3]
  const certificate = process.argv[4]
  const key = process.argv[5]
  if (ca === undefined || certificate === undefined || key === undefined) {
    throw new TypeError("mTLS server requires CA, certificate, and key paths")
  }
  const pem = (bytes: Uint8Array) => ({ encoding: "pem" as const, bytes })
  await runServer(
    runtime,
    tlsConfig({
      serverName: null,
      caCertificate: pem(await readFile(ca)),
      certificateChain: pem(await readFile(certificate)),
      privateKey: pem(await readFile(key))
    }),
    clientAuth("require")
  )
} else {
  throw new TypeError("native runtime mode must be self-test, server, or mtls-server")
}
