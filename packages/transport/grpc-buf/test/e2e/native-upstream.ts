import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node"
import { ConnectError } from "@connectrpc/connect"
import { background, withTimeout } from "@go-like/context"
import type { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"

import { newOrderServiceClient } from "../../.artifacts/gen/order/v1/order_like.js"

interface RuntimeIdentity {
  readonly runtime: "bun" | "deno" | "node"
  readonly version: string
  readonly args: readonly string[]
}

const ExpectedResult = Object.freeze({
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

function identity(): RuntimeIdentity {
  const runtimes = globalThis as typeof globalThis & {
    readonly Bun?: { readonly argv: readonly string[]; readonly version: string }
    readonly Deno?: {
      readonly args: readonly string[]
      readonly version: { readonly deno: string }
    }
    readonly process?: {
      readonly argv: readonly string[]
      readonly versions: { readonly node: string }
    }
  }
  if (runtimes.Bun !== undefined) {
    return { runtime: "bun", version: runtimes.Bun.version, args: runtimes.Bun.argv.slice(2) }
  }
  if (runtimes.Deno !== undefined) {
    return { runtime: "deno", version: runtimes.Deno.version.deno, args: runtimes.Deno.args }
  }
  if (runtimes.process === undefined) throw new Error("upstream runtime identity is unavailable")
  return {
    runtime: "node",
    version: runtimes.process.versions.node,
    args: runtimes.process.argv.slice(2)
  }
}

async function* uploadEvents() {
  yield { orderId: "upstream-upload-1", type: "CREATED" }
  yield { orderId: "upstream-upload-2", type: "PAID" }
  yield { orderId: "upstream-upload-3", type: "SHIPPED" }
}

async function* syncCommands() {
  yield { orderId: "upstream-sync-1", action: "CREATE" }
  yield { orderId: "upstream-sync-2", action: "SHIP" }
}

async function exercise(endpoint: string) {
  const manager = new Http2SessionManager(endpoint)
  let primary: unknown = null
  let result: unknown = null
  try {
    const orders = newOrderServiceClient(
      createGrpcTransport({ baseUrl: endpoint, sessionManager: manager })
    )
    const unary = await orders.getOrder(background(), { id: "upstream-order" })
    const serverStreaming = []
    for await (const event of orders.watchOrders(background(), {
      customerId: "upstream-customer"
    })) {
      serverStreaming.push({
        orderId: event.orderId,
        type: event.type,
        sequence: event.sequence
      })
    }
    const clientStreaming = await orders.uploadEvents(background(), uploadEvents())
    const bidi = []
    for await (const event of orders.syncOrders(background(), syncCommands())) {
      bidi.push({ orderId: event.orderId, type: event.type, sequence: event.sequence })
    }
    result = {
      unary: { id: unary.id, state: unary.state },
      serverStreaming,
      clientStreaming: { count: clientStreaming.count },
      bidi
    }
    if (JSON.stringify(result) !== JSON.stringify(ExpectedResult)) {
      throw new Error("upstream standard-gRPC result mismatch")
    }
  } catch (error) {
    primary = error
  }

  let cleanup: unknown = null
  try {
    manager.abort(new Error("upstream client complete"))
  } catch (error) {
    cleanup = error
  }
  if (primary !== null && cleanup !== null) {
    throw new AggregateError([primary, cleanup], "upstream call and manager cleanup failed")
  }
  if (primary !== null) throw primary
  if (cleanup !== null) throw cleanup
  return Object.freeze({ result, cleanup: { manager: true as const } })
}

type MtlsCredential =
  | { readonly kind: "none" }
  | { readonly kind: "complete"; readonly certificate: Buffer; readonly key: Buffer }

interface MtlsRejection {
  readonly code: number
  readonly message: string
  readonly cause: { readonly name: string; readonly message: string } | null
}

async function mtlsCase(
  endpoint: string,
  ca: Buffer,
  credential: MtlsCredential,
  expected: "reject" | "success"
): Promise<MtlsRejection | { readonly id: string; readonly state: string }> {
  const manager = new Http2SessionManager(endpoint, undefined, {
    ca,
    ...(credential.kind === "none" ? {} : { cert: credential.certificate, key: credential.key }),
    servername: "localhost",
    rejectUnauthorized: true
  })
  const [ctx, cancel] = withTimeout(background(), 5_000)
  let primary: unknown = null
  let output: MtlsRejection | { readonly id: string; readonly state: string } | null = null
  try {
    const orders = newOrderServiceClient(
      createGrpcTransport({ baseUrl: endpoint, sessionManager: manager })
    )
    let response: Awaited<ReturnType<typeof orders.getOrder>> | null = null
    try {
      response = await orders.getOrder(ctx, { id: "mtls-order" })
    } catch (error) {
      if (expected === "success") throw error
      if (ctx.err() !== null) throw new Error("mTLS rejection exceeded its Context deadline")
      if (!(error instanceof ConnectError)) throw error
      output = {
        code: error.code,
        message: error.message,
        cause:
          error.cause instanceof Error
            ? { name: error.cause.name, message: error.cause.message }
            : null
      }
    }
    if (response !== null) {
      if (expected === "reject") throw new Error("mTLS rejection case reached the handler")
      output = { id: response.id, state: response.state }
    }
  } catch (error) {
    primary = error
  }
  cancel()
  let cleanup: unknown = null
  try {
    manager.abort(new Error("upstream mTLS case complete"))
  } catch (error) {
    cleanup = error
  }
  if (primary !== null && cleanup !== null) {
    throw new AggregateError([primary, cleanup], "upstream mTLS call and cleanup failed")
  }
  if (primary !== null) throw primary
  if (cleanup !== null) throw cleanup
  if (output === null) throw new Error("upstream mTLS case produced no result")
  return output
}

async function exerciseMtls(args: readonly string[]) {
  const [
    endpoint,
    caPath,
    trustedCertificatePath,
    untrustedCertificatePath,
    clientKeyPath,
    wrongCaPath
  ] = args
  if (
    endpoint === undefined ||
    caPath === undefined ||
    trustedCertificatePath === undefined ||
    untrustedCertificatePath === undefined ||
    clientKeyPath === undefined ||
    wrongCaPath === undefined
  ) {
    throw new TypeError("upstream mTLS probe requires endpoint and credential paths")
  }
  const url = new URL(endpoint)
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("upstream mTLS endpoint must be a TLS origin root")
  }
  const [ca, trustedCertificate, untrustedCertificate, clientKey, wrongCa] = await Promise.all([
    readFile(caPath),
    readFile(trustedCertificatePath),
    readFile(untrustedCertificatePath),
    readFile(clientKeyPath),
    readFile(wrongCaPath)
  ])
  const none = await mtlsCase(url.href, ca, { kind: "none" }, "reject")
  const untrusted = await mtlsCase(
    url.href,
    ca,
    { kind: "complete", certificate: untrustedCertificate, key: clientKey },
    "reject"
  )
  const trusted = await mtlsCase(
    url.href,
    ca,
    { kind: "complete", certificate: trustedCertificate, key: clientKey },
    "success"
  )
  const wrongTrust = await mtlsCase(
    url.href,
    wrongCa,
    { kind: "complete", certificate: trustedCertificate, key: clientKey },
    "reject"
  )
  if (!("code" in none) || !("code" in untrusted) || !("code" in wrongTrust)) {
    throw new Error("upstream mTLS rejection evidence was invalid")
  }
  if (!("id" in trusted) || trusted.id !== "mtls-order" || trusted.state !== "READY") {
    throw new Error("upstream trusted mTLS result was invalid")
  }
  return Object.freeze({
    cases: Object.freeze({
      none: "rejected",
      untrusted: "rejected",
      wrongTrust: "rejected",
      trusted
    }),
    rejectionErrors: Object.freeze({ none, untrusted, wrongTrust }),
    cleanup: Object.freeze({ managers: 4 as const }),
    rejectionContexts: Object.freeze({
      noneTimedOut: false,
      untrustedTimedOut: false,
      wrongTrustTimedOut: false
    })
  })
}

const runtime = identity()
if (runtime.args[0] === "mtls-unary") {
  console.log(
    JSON.stringify({
      kind: "upstream-mtls",
      runtime: runtime.runtime,
      version: runtime.version,
      ...(await exerciseMtls(runtime.args.slice(1)))
    })
  )
} else {
  const endpoint = runtime.args[0]
  if (endpoint === undefined) throw new TypeError("upstream client requires one endpoint")
  const url = new URL(endpoint)
  if (url.protocol !== "http:" || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("upstream client endpoint must be an h2c origin root")
  }
  const output = await exercise(url.href)
  console.log(
    JSON.stringify({
      kind: "upstream-client",
      runtime: runtime.runtime,
      version: runtime.version,
      ...output
    })
  )
}
