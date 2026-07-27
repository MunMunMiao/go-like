import { readFileSync } from "node:fs"

import type { PublishedBusinessCaseRegistry } from "../../../scripts/published/business-cases"
import { identityTypeConsumer } from "./identity"

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" })

/** Transpiles one reviewed TypeScript behavior authority into a portable JavaScript case module. */
export function transpile(source: string): string {
  return transpiler.transformSync(source)
}

/** Wraps the complete Consul published behavior authority as one central exported run function. */
function registryConsulRuntimeModule(): string {
  const source = readFileSync(
    new URL(
      "../../../packages/registry/consul/test/integration/published-behavior.ts",
      import.meta.url
    ),
    "utf8"
  )
  return transpile(
    [
      'import { background } from "@likego/context"',
      'import { newConsulRegistry } from "@likego/registry-consul"',
      "export async function run() {",
      withoutImports(source),
      "}"
    ].join("\n")
  )
}

/** Reuses the portable mDNS lifecycle through the packed root with an inlined private test host. */
function mdnsPortableRuntimeModule(): string {
  const registryTesting = withoutImports(
    readFileSync(new URL("../../../packages/registry/src/testing.ts", import.meta.url), "utf8")
  ).replaceAll(/^export /gm, "")
  const testing = withoutImports(
    readFileSync(new URL("../../../packages/registry/mdns/src/testing.ts", import.meta.url), "utf8")
  ).replaceAll(/^export /gm, "")
  const portable = withoutImports(
    readFileSync(
      new URL("../../../packages/registry/mdns/test/runtime/portable-runtime.ts", import.meta.url),
      "utf8"
    )
  )
  return transpile(`
import { background, cause, withCancelCause, withTimeout } from "@likego/context"
import { waitForContext } from "@likego/core/lifecycle"
import {
  snapshotServiceInstance,
  snapshotServiceInstances
} from "@likego/registry/provider"
import {
  domain,
  families,
  interfaces,
  maxDecodedPayloadBytes,
  maxPacketBytes,
  newMDNSRegistry,
  port,
  queryTimeout,
  ttl,
  watchBufferSize
} from "@likego/registry-mdns"

${registryTesting}
${testing}

export async function run() {
${portable}
}
`)
}

/** Replays every Node host lifecycle case through the installed public constructor. */
function mdnsNodeRuntimeModule(): string {
  const cases = withoutImports(
    readFileSync(
      new URL("../../../packages/registry/mdns/test/node-host.test.ts", import.meta.url),
      "utf8"
    )
  ).replaceAll("newNodeMDNSHostWithFactory", "nodeHostWithSeams")
  const harness = behaviorHarness().replace(
    "    async toBe(expected) { synchronousMatchers(await settled()).toBe(expected) },",
    [
      "    async toBe(expected) { synchronousMatchers(await settled()).toBe(expected) },",
      "    async toBeInstanceOf(expected) { synchronousMatchers(await settled()).toBeInstanceOf(expected) },"
    ].join("\n")
  )
  return transpile(
    [
      'import { createRequire, syncBuiltinESMExports } from "node:module"',
      'import { background, deadlineExceeded, withCancelCause, withTimeout } from "@likego/context"',
      'import { newNodeMDNSHost } from "@likego/registry-mdns/node"',
      harness,
      `const require = createRequire(import.meta.url)
const dgramModule = require("node:dgram")
const osModule = require("node:os")
const originalCreateSocket = dgramModule.createSocket
const originalNetworkInterfaces = osModule.networkInterfaces
const createSocket = (...args) => originalCreateSocket(...args)
const networkInterfaces = (...args) => originalNetworkInterfaces(...args)

function nodeHostWithSeams(socketFactory, interfaceProvider) {
  dgramModule.createSocket = socketFactory
  osModule.networkInterfaces = interfaceProvider
  syncBuiltinESMExports()
  let host
  try {
    host = newNodeMDNSHost()
  } finally {
    dgramModule.createSocket = originalCreateSocket
    osModule.networkInterfaces = originalNetworkInterfaces
    syncBuiltinESMExports()
  }
  return Object.freeze({
    networkInterfaces(ctx) {
      return host.networkInterfaces(ctx)
    },
    bindDatagram(ctx, options) {
      dgramModule.createSocket = socketFactory
      syncBuiltinESMExports()
      try {
        return host.bindDatagram(ctx, options)
      } finally {
        dgramModule.createSocket = originalCreateSocket
        syncBuiltinESMExports()
      }
    }
  })
}`,
      cases,
      `export async function run() {
  try {
    for (const publishedCase of publishedCases) {
      try {
        await publishedCase.body()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error("published case \\\"" + publishedCase.name + "\\\" failed: " + message, { cause: error })
      }
    }
  } finally {
    dgramModule.createSocket = originalCreateSocket
    osModule.networkInterfaces = originalNetworkInterfaces
    syncBuiltinESMExports()
  }
}`,
      ""
    ].join("\n")
  )
}

interface FrameworkRuntimeOptions {
  readonly packageName: string
  readonly factory: string
  readonly nativePackage: string
  readonly nativeType: string
  readonly invalidApplicationMessage: string
  readonly route: string
  readonly requestURL: string
  readonly expectedFramework: string
}

/** Exercises one framework bridge against both its structural boundary and a real native route. */
function frameworkRuntimeModule(options: FrameworkRuntimeOptions): string {
  return transpile(`
import { ${options.factory} } from "${options.packageName}"
import { ${options.nativeType} } from "${options.nativePackage}"

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

export async function run() {
  for (const invalid of [null, 1, {}, { fetch: 1 }]) {
    let rejected = false
    try { ${options.factory}(invalid) } catch (error) {
      rejected = error instanceof TypeError && error.message === ${JSON.stringify(options.invalidApplicationMessage)}
    }
    requireValue(rejected, "invalid native application was accepted")
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("published"))
      controller.close()
    }
  })
  const response = new Response(stream)
  let receiver
  const structural = {
    fetch(request) {
      receiver = this
      requireValue(request.url === "https://service.test/structural", "Request identity changed")
      return response
    }
  }
  const handler = ${options.factory}(structural)
  const returned = handler(new Request("https://service.test/structural"))
  requireValue(returned === response, "Response identity changed")
  requireValue(receiver === structural, "native receiver was not bound")
  requireValue(response.body === stream, "response stream identity changed")

  const failure = new Error("published native failure")
  const failing = ${options.factory}({ fetch() { throw failure } })
  try {
    failing(new Request("https://service.test/failure"))
    throw new Error("native failure was swallowed")
  } catch (error) {
    requireValue(error === failure, "native Error identity changed")
  }

  ${options.route}
  const routedHandler = ${options.factory}(app)
  const routedResponse = await routedHandler(new Request("${options.requestURL}"))
  requireValue(routedResponse instanceof Response, "native route did not return a Response")
  const payload = await routedResponse.json()
  requireValue(payload.framework === "${options.expectedFramework}" && payload.id === "42", "native route payload drifted")
}
`)
}

/** Proves that one bridge is assignable to the common Web Handler without exporting router APIs. */
function frameworkTypeConsumer(
  packageName: string,
  factory: string,
  nativePackage: string,
  nativeType: string
): string {
  return `
import type { Handler } from "@likego/web"
import { ${factory} } from "${packageName}"
import type { ${nativeType} } from "${nativePackage}"

declare const app: ${nativeType}
const handler: Handler = ${factory}(app)
void handler
`
}

/** Removes compile-time test imports before reviewed suites receive staged package-name imports. */
export function withoutImports(source: string): string {
  return source.replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["']\s*\n/gm, "")
}

/** Provides the small assertion surface used by the reviewed package behavior authorities. */
export function behaviorHarness(): string {
  return `
const publishedCases = []
const matcherTag = "__likegoPublishedMatcher"

function fail(message) { throw new Error(message) }
function keys(value) { return Object.keys(value).sort() }
function asymmetric(value) {
  return value !== null && typeof value === "object" && matcherTag in value
}
function matches(actual, expected, subset = false) {
  if (asymmetric(expected)) {
    if (expected[matcherTag] === "stringContaining") {
      return typeof actual === "string" && actual.includes(expected.expected)
    }
    if (expected[matcherTag] === "objectContaining") return matches(actual, expected.expected, true)
  }
  if (Object.is(actual, expected)) return true
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false
    return actual.every((value, index) => matches(value, expected[index], subset))
  }
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return false
  const expectedKeys = keys(expected)
  if (!subset && keys(actual).join("\u0000") !== expectedKeys.join("\u0000")) return false
  return expectedKeys.every((key) => key in actual && matches(actual[key], expected[key], subset))
}
function contains(actual, expected) {
  if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected)
  return Array.isArray(actual) && actual.some((value) => matches(value, expected))
}
function thrownValue(callable) {
  try { callable() } catch (error) { return { threw: true, error } }
  return { threw: false, error: undefined }
}
function thrownMatches(error, expected) {
  if (expected === undefined) return true
  if (typeof expected === "string") return String(error?.message ?? error).includes(expected)
  if (asymmetric(expected)) {
    const actual = expected[matcherTag] === "stringContaining"
      ? String(error?.message ?? error)
      : error
    return matches(actual, expected)
  }
  if (expected instanceof Error) return error === expected
  if (typeof expected === "function") return error instanceof expected
  return matches(error, expected, true)
}
function synchronousMatchers(actual, negate = false) {
  function check(result, label) {
    if (negate ? result : !result) fail(\`published assertion failed: \${label}\`)
  }
  return {
    toBe(expected) { check(Object.is(actual, expected), "toBe") },
    toBeDefined() { check(actual !== undefined, "toBeDefined") },
    toBeUndefined() { check(actual === undefined, "toBeUndefined") },
    toBeNull() { check(actual === null, "toBeNull") },
    toBeTrue() { check(actual === true, "toBeTrue") },
    toBeFalse() { check(actual === false, "toBeFalse") },
    toBeGreaterThan(expected) { check(typeof actual === "number" && actual > expected, "toBeGreaterThan") },
    toBeGreaterThanOrEqual(expected) { check(typeof actual === "number" && actual >= expected, "toBeGreaterThanOrEqual") },
    toBeInstanceOf(expected) { check(actual instanceof expected, "toBeInstanceOf") },
    toContain(expected) { check(contains(actual, expected), "toContain") },
    toContainEqual(expected) { check(Array.isArray(actual) && actual.some((value) => matches(value, expected)), "toContainEqual") },
    toEqual(expected) { check(matches(actual, expected), "toEqual") },
    toHaveLength(expected) { check(actual !== null && actual !== undefined && actual.length === expected, "toHaveLength") },
    toMatch(expected) {
      const matched = typeof actual === "string" && (typeof expected === "string"
        ? actual.includes(expected)
        : expected instanceof RegExp && expected.test(actual))
      check(matched, "toMatch")
    },
    toMatchObject(expected) { check(matches(actual, expected, true), "toMatchObject") },
    toStartWith(expected) { check(typeof actual === "string" && actual.startsWith(expected), "toStartWith") },
    toThrow(expected) {
      if (typeof actual !== "function") fail("toThrow requires a function")
      const observed = thrownValue(actual)
      check(observed.threw && thrownMatches(observed.error, expected), "toThrow")
    },
    get not() { return synchronousMatchers(actual, !negate) }
  }
}
function asynchronousMatchers(actual, shouldReject) {
  async function settled() {
    try {
      const value = await actual
      if (shouldReject) fail("published assertion expected rejection")
      return value
    } catch (error) {
      if (!shouldReject) throw error
      return error
    }
  }
  return {
    async toBe(expected) { synchronousMatchers(await settled()).toBe(expected) },
    async toBeUndefined() { synchronousMatchers(await settled()).toBeUndefined() },
    async toMatchObject(expected) { synchronousMatchers(await settled()).toMatchObject(expected) },
    async toThrow(expected) {
      if (!shouldReject) fail("resolves.toThrow is unsupported")
      const error = await settled()
      if (!thrownMatches(error, expected)) {
        const observed = String(error?.message ?? error)
        fail("published assertion failed: rejects.toThrow expected " + String(expected) + " received " + observed)
      }
    }
  }
}
function expect(actual) {
  const matchers = synchronousMatchers(actual)
  Object.defineProperty(matchers, "resolves", { get() { return asynchronousMatchers(actual, false) } })
  Object.defineProperty(matchers, "rejects", { get() { return asynchronousMatchers(actual, true) } })
  return matchers
}
expect.stringContaining = (expected) => ({ [matcherTag]: "stringContaining", expected })
expect.objectContaining = (expected) => ({ [matcherTag]: "objectContaining", expected })
function describe(_name, body) { body() }
function test(name, body) { publishedCases.push({ name, body }) }
`
}

/** Appends the stable runner for every reviewed test registered by one generated module. */
export function behaviorRunner(): string {
  return `
export async function run() {
  for (const publishedCase of publishedCases) {
    try {
      await publishedCase.body()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error("published case \\\"" + publishedCase.name + "\\\" failed: " + message, { cause: error })
    }
  }
}
`
}

/** Reads the test-owned option defaults without publishing them as package code. */
function transportOptionFixture(): string {
  return withoutImports(
    readFileSync(
      new URL("../../../packages/transport/test/runtime/options-fixture.ts", import.meta.url),
      "utf8"
    )
  ).replaceAll("export function", "function")
}

/** Replays root Message, middleware, metadata, error, and option behavior through the packed root. */
function transportRootRuntimeModule(): string {
  const optionsCases = withoutImports(
    readFileSync(
      new URL("../../../packages/transport/test/options.test.ts", import.meta.url),
      "utf8"
    )
  )
  const messageCases = withoutImports(
    readFileSync(
      new URL("../../../packages/transport/test/message.test.ts", import.meta.url),
      "utf8"
    )
  )
  const middlewareCases = withoutImports(
    readFileSync(
      new URL("../../../packages/transport/test/middleware.test.ts", import.meta.url),
      "utf8"
    )
  )
  const metadataCases = withoutImports(
    readFileSync(
      new URL("../../../packages/transport/test/metadata-wire.test.ts", import.meta.url),
      "utf8"
    )
  )
  const transportInfoCases = withoutImports(
    readFileSync(
      new URL("../../../packages/transport/test/transport-info.test.ts", import.meta.url),
      "utf8"
    )
  )
  return transpile(
    [
      'const { runInNewContext } = globalThis.process.getBuiltinModule("vm")',
      'import * as TransportContextRoot from "@likego/context"',
      'import * as TransportMetadataRoot from "@likego/metadata"',
      'import * as TransportRoot from "@likego/transport"',
      'import * as TransportProvider from "@likego/transport/provider"',
      behaviorHarness(),
      transportOptionFixture(),
      "{",
      `const OptionsModule = Object.freeze({
      codec: TransportRoot.codec,
      logger: TransportRoot.logger,
      secure: TransportRoot.secure,
      timeout: TransportRoot.timeout,
      tlsConfig: TransportRoot.tlsConfig,
      withConnClose: TransportRoot.withConnClose,
      withTimeout: TransportRoot.withTimeout
    })`,
      optionsCases,
      "}",
      "{",
      "const MessageModule = Object.freeze({ snapshotMessage: TransportProvider.snapshotMessage })",
      messageCases,
      "}",
      "{",
      "const { background } = TransportContextRoot",
      "const { chain } = TransportRoot",
      middlewareCases,
      "}",
      "{",
      "const { newMetadata } = TransportMetadataRoot",
      "const { decodeMetadataHeader, encodeMetadataHeader } = TransportProvider",
      metadataCases,
      "}",
      "{",
      `const { background, canceled, withCancel, withValue } = TransportContextRoot`,
      `const { newMetadata } = TransportMetadataRoot`,
      `const {
        fromClientContext,
        fromServerContext,
        newClientContext,
        newServerContext
      } = TransportRoot`,
      transportInfoCases,
      "}",
      `test("covers the exact root exports and both stable-error cause branches", () => {
      const expected = [
        "chain", "fromClientContext", "codec", "endpoint",
        "isServiceError", "logger", "secure", "fromServerContext", "serviceError", "timeout",
        "tlsConfig", "newClientContext", "withConnClose", "newServerContext", "withTimeout"
      ].sort()
      expect(Object.keys(TransportRoot).sort()).toEqual(expected)
      expect(Object.keys(TransportProvider).sort()).toEqual([
        "decodeMetadataHeader", "decodeServiceError", "encodeMetadataHeader", "encodeServiceError",
        "internalServiceError", "newTransportClosedError", "newTransportProtocolError",
        "newTransportStateError", "newUnsupportedTransportCapabilityError", "snapshotMessage"
      ])
      const rows = [
        [TransportProvider.newTransportClosedError, "TransportClosedError", "LIKEGO_TRANSPORT_CLOSED"],
        [TransportProvider.newTransportProtocolError, "TransportProtocolError", "LIKEGO_TRANSPORT_PROTOCOL"],
        [TransportProvider.newTransportStateError, "TransportStateError", "LIKEGO_TRANSPORT_STATE"],
        [TransportProvider.newUnsupportedTransportCapabilityError, "UnsupportedTransportCapabilityError", "LIKEGO_TRANSPORT_UNSUPPORTED_CAPABILITY"]
      ]
      for (const [factory, name, code] of rows) {
        const plain = factory("plain")
        expect(plain).toMatchObject({ name, code, cause: undefined })
        const cause = new Error("published cause")
        const wrapped = factory("wrapped", cause)
        expect(wrapped).toMatchObject({ name, code, cause })
        expect(wrapped.cause).toBe(cause)
        expect(Object.isFrozen(plain)).toBe(true)
        expect(Object.isFrozen(wrapped)).toBe(true)
      }
      const serviceFailure = TransportRoot.serviceError("orders.denied", "request denied", 403, {
        tenant: "one",
        region: "east"
      })
      expect(TransportRoot.isServiceError(serviceFailure)).toBe(true)
      expect(TransportRoot.isServiceError({ name: "ServiceError", code: "orders.denied", status: 403 })).toBe(false)
      const envelope = TransportProvider.encodeServiceError("unary", serviceFailure)
      const decoded = TransportProvider.decodeServiceError("unary", 200, envelope.header, envelope.body)
      expect(decoded).toMatchObject({ code: "orders.denied", message: "request denied", status: 403, metadata: { tenant: "one" } })
      expect(TransportRoot.isServiceError(decoded)).toBe(true)
      expect(TransportProvider.internalServiceError()).toMatchObject({ code: "internal", status: 500 })
    })`,
      `test("covers public option boundary branches through the packed root", () => {
      expect(reduceTestOptions(TransportRoot.codec(null)).codec).toBeNull()
      expect(() => reduceTestOptions(TransportRoot.codec({}))).toThrow(TypeError)
      expect(() => reduceTestOptions(TransportRoot.codec({ marshal() { return new Uint8Array() } }))).toThrow(TypeError)

      const invalidMarshal = reduceTestOptions(TransportRoot.codec({
        marshal() { return [] },
        unmarshal() { return { header: {}, body: new Uint8Array() } }
      })).codec
      if (invalidMarshal === null) throw new Error("published invalid marshal codec is missing")
      expect(() => invalidMarshal.marshal({ header: {}, body: new Uint8Array() })).toThrow(TypeError)

      const invalidUnmarshal = reduceTestOptions(TransportRoot.codec({
        marshal() { return new Uint8Array() },
        unmarshal() { return null }
      })).codec
      if (invalidUnmarshal === null) throw new Error("published invalid unmarshal codec is missing")
      expect(() => Reflect.apply(invalidUnmarshal.unmarshal, invalidUnmarshal, [[]])).toThrow(TypeError)
      expect(() => invalidUnmarshal.unmarshal(new Uint8Array())).toThrow(TypeError)

      expect(() => reduceTestOptions(TransportRoot.logger({}))).toThrow(TypeError)
      const observed = []
      const boundaryLogger = reduceTestOptions(TransportRoot.logger({
        log(_level, _message, fields) { observed.push(fields); return 1 }
      })).logger
      if (boundaryLogger === null) throw new Error("published boundary logger is missing")
      const inherited = Object.create({ inherited: true })
      inherited.visible = 1
      boundaryLogger.log("info", "inherited", inherited)
      const nullPrototype = Object.create(null)
      nullPrototype.visible = 2
      boundaryLogger.log("info", "null-prototype", nullPrototype)
      expect(observed).toEqual([{}, { visible: 2 }])
      expect(Object.isFrozen(observed[0])).toBe(true)
      expect(Object.isFrozen(observed[1])).toBe(true)

      const emptyTLS = reduceTestOptions(TransportRoot.tlsConfig({
        serverName: null,
        caCertificate: null,
        certificateChain: null,
        privateKey: null
      })).tlsConfig
      expect(emptyTLS).toEqual({
        serverName: null,
        caCertificate: null,
        certificateChain: null,
        privateKey: null
      })
      const invalidBytes = TransportRoot.tlsConfig({
        serverName: null,
        caCertificate: { encoding: "pem", bytes: [] },
        certificateChain: null,
        privateKey: null
      })
      expect(() => reduceTestOptions(invalidBytes)).toThrow(TypeError)
    })`,
      behaviorRunner()
    ].join("\n")
  )
}

/** Verifies the exact public internal-transport header vocabulary. */
function transportHeadersRuntimeModule(): string {
  return transpile(`
import * as Headers from "@likego/transport/headers"

const expected = Object.freeze({
  message: "Likego-Topic",
  request: "Likego-Service",
  error: "Likego-Error",
  endpoint: "Likego-Endpoint",
  method: "Likego-Method",
  metadata: "Likego-Metadata",
  id: "Likego-ID",
  prefix: "Likego-",
  namespace: "Likego-Namespace",
  protocol: "Likego-Protocol",
  target: "Likego-Target",
  contentType: "Content-Type",
  serviceError: "Likego-Service-Error",
  serviceErrorCode: "Likego-Service-Error-Code",
  serviceErrorStatus: "Likego-Service-Error-Status",
  spanId: "Likego-Span-ID",
  traceId: "Likego-Trace-ID",
  stream: "Likego-Stream"
})

export async function run() {
  const actualKeys = Object.keys(Headers).sort()
  const expectedKeys = Object.keys(expected).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("transport header export inventory drifted")
  }
  for (const key of expectedKeys) {
    if (Headers[key] !== expected[key]) throw new Error(\`transport header drifted: \${key}\`)
  }
}
`)
}

/** Exercises the portable JSON codec through its packed public subpath. */
function transportJSONRuntimeModule(): string {
  return transpile(`
import { jsonCodec } from "@likego/transport/json"

const schema = {
  "~standard": {
    version: 1,
    vendor: "likego-published",
    validate(value) {
      return typeof value === "object" && value !== null && typeof value.name === "string"
        ? { value: { name: value.name } }
        : { issues: [{ message: "name is required" }] }
    }
  }
}

export async function run() {
  const codec = jsonCodec(schema)
  const encoded = await codec.encode({ name: "LikeGo" })
  if (new TextDecoder().decode(encoded) !== '{"name":"LikeGo"}') {
    throw new Error("transport JSON encoding drifted")
  }
  const decoded = await codec.decode(encoded)
  if (decoded.name !== "LikeGo") throw new Error("transport JSON validation drifted")
}
`)
}

/** Exercises the root declaration surface without depending on a concrete provider. */
function transportRootTypeConsumer(): string {
  return `
import type { Context } from "@likego/context"
import {
  codec,
  endpoint,
  isServiceError,
  logger,
  secure,
  serviceError,
  timeout,
  tlsConfig,
  withConnClose,
  withTimeout,
  type AcceptHandler,
  type BodyCodec,
  type Client,
  type DialOption,
  type DialOptions,
  type Endpoint,
  type ListenOption,
  type ListenOptions,
  type Listener,
  type Message,
  type MessageCodec,
  type Option,
  type Options,
  type Socket,
  type ServiceError,
  type TLSConfig,
  type TLSEncodedBytes,
  type TLSEncoding,
  type Transport,
  type TransportLogLevel,
  type TransportLogger,
} from "@likego/transport"
import {
  decodeServiceError,
  encodeServiceError,
  internalServiceError,
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  newUnsupportedTransportCapabilityError,
  snapshotMessage,
  type ServiceErrorEnvelope,
  type ServiceErrorWireKind,
  type TransportClosedError,
  type TransportProtocolError,
  type TransportStateError,
  type UnsupportedTransportCapabilityError
} from "@likego/transport/provider"

declare const ctx: Context
declare const transport: Transport
declare const client: Client
declare const listener: Listener
declare const socket: Socket
declare const handler: AcceptHandler
declare const message: Message
declare const codecValue: MessageCodec
declare const loggerValue: TransportLogger
declare const tls: TLSConfig
declare const encoded: TLSEncodedBytes
declare const encoding: TLSEncoding
declare const level: TransportLogLevel
declare const options: Options
declare const dialOptions: DialOptions
declare const listenOptions: ListenOptions
declare const bodyCodec: BodyCodec<string>
const typedEndpoint: Endpoint<string, string> = endpoint(
  "greeter",
  "Hello",
  bodyCodec,
  bodyCodec
)
const commonOptions: readonly Option[] = [codec(codecValue), logger(loggerValue), timeout(1), secure(true), tlsConfig(tls)]
const dialers: readonly DialOption[] = [withConnClose(), withTimeout(1)]
const listeners: readonly ListenOption[] = [(value) => value]
const copied: Message = snapshotMessage(message)
const closed: TransportClosedError = newTransportClosedError("closed")
const protocol: TransportProtocolError = newTransportProtocolError("protocol")
const state: TransportStateError = newTransportStateError("state")
const unsupported: UnsupportedTransportCapabilityError = newUnsupportedTransportCapabilityError("unsupported")
const wireKind: ServiceErrorWireKind = "unary"
const serviceFailure: ServiceError = serviceError("orders.denied", "request denied", 403)
const envelope: ServiceErrorEnvelope = encodeServiceError(wireKind, serviceFailure)
const decoded: ServiceError | null = decodeServiceError(wireKind, 200, envelope.header, envelope.body)
const branded: boolean = isServiceError(decoded)
const internal: ServiceError = internalServiceError()
void [ctx, transport, client, listener, socket, handler, copied, encoded, encoding, level, options, dialOptions, listenOptions, typedEndpoint, commonOptions, dialers, listeners, closed, protocol, state, unsupported, envelope, decoded, branded, internal]
`
}

/** Locks every fixed header export to its public string declaration. */
function transportHeadersTypeConsumer(): string {
  return `
import {
  contentType,
  endpoint,
  error,
  id,
  message,
  method,
  namespace,
  prefix,
  protocol,
  request,
  serviceError,
  serviceErrorCode,
  serviceErrorStatus,
  spanId,
  stream,
  target,
  traceId
} from "@likego/transport/headers"
const values: readonly string[] = [contentType, endpoint, error, id, message, method, namespace, prefix, protocol, request, serviceError, serviceErrorCode, serviceErrorStatus, spanId, stream, target, traceId]
void values
`
}

/** Compiles the portable JSON codec with one structural Standard Schema validator. */
function transportJSONTypeConsumer(): string {
  return `
import { jsonCodec } from "@likego/transport/json"

const codec = jsonCodec({
  "~standard": {
    version: 1 as const,
    vendor: "likego-published",
    validate(value: unknown) {
      return { value: { text: String(value) } }
    }
  }
})
const decoded: PromiseLike<{ text: string }> | { text: string } = codec.decode(new Uint8Array())
void decoded
`
}

/** Replays public Memory Transport behavior through installed package exports. */
function transportMemoryRuntimeModule(): string {
  const portable = withoutImports(
    readFileSync(
      new URL(
        "../../../packages/transport/memory/test/runtime/portable-runtime.ts",
        import.meta.url
      ),
      "utf8"
    )
  )
  const publicCaseSource = withoutImports(
    readFileSync(
      new URL("../../../packages/transport/memory/test/transport.test.ts", import.meta.url),
      "utf8"
    )
  )
  const privateFailureFixture = `  const foreign = await newMemoryTransport().listen(background(), "memory://foreign")
  expect(() =>
    Reflect.apply(failMemoryListener, undefined, [background(), foreign, "invalid"])
  ).toThrow("failure cause must be an Error")
  const borrowed = {
    addr: foreign.addr,
    close: foreign.close,
    accept: foreign.accept
  }
  expect(() => failMemoryListener(background(), borrowed, new Error("foreign"))).toThrow(
    "listener is not owned"
  )
  await foreign.close(background())
`
  if (!publicCaseSource.includes(privateFailureFixture)) {
    throw new Error("Memory Transport private failure fixture boundary drifted")
  }
  const publicCases = publicCaseSource.replace(privateFailureFixture, "")
  return transpile(
    [
      'const { runInNewContext } = globalThis.process.getBuiltinModule("vm")',
      'import { background, canceled, cause, deadlineExceeded, withCancel, withCancelCause } from "@likego/context"',
      'import { get } from "@likego/metadata"',
      `import {
        codec,
        secure,
        fromServerContext,
        timeout,
        tlsConfig,
        withConnClose,
	      } from "@likego/transport"`,
      'import { endpoint, request } from "@likego/transport/headers"',
      'import { newMemoryTransport } from "@likego/transport-memory"',
      behaviorHarness(),
      publicCases,
      "export async function run() {",
      portable,
      "for (const publishedCase of publishedCases) await publishedCase.body()",
      "}"
    ].join("\n")
  )
}

/** Reuses the Memory Transport public type authority through its installed package identity. */
function transportMemoryTypeConsumer(): string {
  return readFileSync(
    new URL("../../../packages/transport/memory/test/public-types.ts", import.meta.url),
    "utf8"
  ).replaceAll('from "../src/index"', 'from "@likego/transport-memory"')
}

/** Exercises every portable HTTP Transport declaration through its packed root export. */
function transportHTTPRootTypeConsumer(): string {
  return `
import type { Transport } from "@likego/transport"
import {
  executor,
  maxMessageBytes,
  newHTTPTransport,
  type HTTPExecutor,
  type HTTPTransport,
  type HTTPTransportOption,
  type HTTPTransportOptions
} from "@likego/transport-http"

const execute: HTTPExecutor = fetch
const options: HTTPTransportOptions = {
  executor: execute,
  maxMessageBytes: 1024
}
const executeOption: HTTPTransportOption = executor(execute)
const sizeOption: HTTPTransportOption = maxMessageBytes(options.maxMessageBytes)
const implementation: HTTPTransport = newHTTPTransport(executeOption, sizeOption)
const transport: Transport = implementation
void [transport, options]
`
}

/** Exercises the Node HTTP host and client-provider declarations through the packed subpath. */
function transportHTTPNodeTypeConsumer(): string {
  return `
import type { Transport } from "@likego/transport"
import { newNodeHTTPTransport } from "@likego/transport-http/node"

const transport: Transport = newNodeHTTPTransport()
void transport
`
}

/** Exercises every portable mDNS Registry declaration through the packed root export. */
function mdnsRootTypeConsumer(): string {
  return `
import type { Context } from "@likego/context"
import type { Registry } from "@likego/registry"
import type { RegistrationErrorHandler } from "@likego/registry/provider"
import {
  domain,
  families,
  interfaces,
  maxDecodedPayloadBytes,
  maxPacketBytes,
  newMDNSRegistry,
  onRegistrationError,
  port,
  queryTimeout,
  ttl,
  watchBufferSize,
  type MDNSAddress,
  type MDNSBindOptions,
  type MDNSDatagram,
  type MDNSDatagramSocket,
  type MDNSFamily,
  type MDNSHost,
  type MDNSMembership,
  type MDNSNetworkInterface,
  type MDNSOption,
  type MDNSOptions,
  type MDNSRegistry
} from "@likego/registry-mdns"
const family: MDNSFamily = "ipv4"
const address: MDNSAddress = { family, address: "224.0.0.251", port: 5353 }
const datagram: MDNSDatagram = { data: new Uint8Array([1]), remote: address, interfaceId: "en0" }
const membership: MDNSMembership = {
  leave(_ctx: Context): Promise<void> { return Promise.resolve() }
}
const socket: MDNSDatagramSocket = {
  settled(): Promise<void> { return Promise.resolve() },
  joinMulticast(_ctx: Context, _group: string, _interfaceId: string | number): Promise<MDNSMembership> { return Promise.resolve(membership) },
  setMulticastLoopback(_ctx: Context, _enabled: boolean): Promise<void> { return Promise.resolve() },
  setMulticastInterface(_ctx: Context, _interfaceId: string | number): Promise<void> { return Promise.resolve() },
  send(_ctx: Context, _data: Uint8Array, _target: MDNSAddress): Promise<void> { return Promise.resolve() },
  receive(_ctx: Context): Promise<MDNSDatagram> { return Promise.resolve(datagram) },
  close(_ctx: Context): Promise<void> { return Promise.resolve() }
}
const networkInterface: MDNSNetworkInterface = { id: "en0", name: "en0", family: "ipv4", address: "127.0.0.1", internal: false }
const host: MDNSHost = {
  networkInterfaces(): Promise<readonly MDNSNetworkInterface[]> { return Promise.resolve([networkInterface]) },
  bindDatagram(_ctx: Context, _options: MDNSBindOptions): Promise<MDNSDatagramSocket> { return Promise.resolve(socket) }
}
const registrationErrorHandler: RegistrationErrorHandler = (_error, _service) => Promise.resolve()
const snapshot: MDNSOptions = {
  domain: "mesh.local",
  interfaceIds: ["en0", 1],
  families: [family, "ipv6"],
  queryTimeoutMs: 10,
  port: 5353,
  maxPacketBytes: 1200,
  maxDecodedPayloadBytes: 65536,
  watchBufferSize: 128,
  ttlMs: 120000,
  onRegistrationError: registrationErrorHandler
}
const reducer: MDNSOption = (_current: MDNSOptions): MDNSOptions => snapshot
const registry: MDNSRegistry = newMDNSRegistry(
  host,
  domain("mesh.local"),
  interfaces("en0"),
  families("ipv4"),
  queryTimeout(10),
  port(5353),
  maxPacketBytes(1200),
  maxDecodedPayloadBytes(65536),
  watchBufferSize(128),
  ttl(120000),
  onRegistrationError(registrationErrorHandler),
  reducer
)
const common: Registry = registry
void [common, address, datagram, membership, snapshot]
`
}

/** Proves the Node constructor implements the portable mDNS host contract. */
function mdnsNodeTypeConsumer(): string {
  return `
import type { MDNSHost } from "@likego/registry-mdns"
import { newNodeMDNSHost } from "@likego/registry-mdns/node"
const host: MDNSHost = newNodeMDNSHost()
void host
`
}

/** Reuses the complete portable Consul KV behavior suite against only staged package imports. */
function configConsulRuntimeModule(): string {
  const helper = withoutImports(
    readFileSync(
      new URL("../../../packages/config/consul/test/helpers.ts", import.meta.url),
      "utf8"
    )
  )
  const cases = withoutImports(
    readFileSync(
      new URL("../../../packages/config/consul/test/consul.test.ts", import.meta.url),
      "utf8"
    )
  )
  return transpile(
    [
      'import { background, withCancelCause, withTimeout } from "@likego/context"',
      'import { consulSource, jsonConsulDecoder } from "@likego/config-consul"',
      behaviorHarness(),
      helper,
      cases,
      behaviorRunner()
    ].join("\n")
  )
}

/** Reuses the public Pino lifecycle authority against package-name-only imports. */
function pinoRuntimeModule(): string {
  const provenanceSource = readFileSync(
    new URL("../../../packages/pino/test/provenance.test.ts", import.meta.url),
    "utf8"
  )
  const publicProvenance = withoutImports(provenanceSource)
  const publicApi = withoutImports(
    readFileSync(new URL("../../../packages/pino/test/public-api.test.ts", import.meta.url), "utf8")
  )
  const publicRuntime = withoutImports(
    readFileSync(
      new URL("../../../packages/pino/test/published-runtime.test.ts", import.meta.url),
      "utf8"
    )
  )
  return transpile(
    [
      'import { EventEmitter, once } from "node:events"',
      'import { mkdtemp, readFile, rm } from "node:fs/promises"',
      'import { tmpdir } from "node:os"',
      'import { join } from "node:path"',
      'import { background, canceled, withCancelCause } from "@likego/context"',
      'import * as publicApi from "@likego/pino"',
      'import { pinoDrainTimeout, newPinoServer } from "@likego/pino"',
      'import pino, { symbols } from "pino"',
      behaviorHarness(),
      publicProvenance,
      publicApi,
      publicRuntime,
      behaviorRunner()
    ].join("\n")
  )
}

/** Reuses the public Winston lifecycle authority against package-name-only imports. */
function winstonRuntimeModule(): string {
  const sources = ["helpers.ts", "public-api.test.ts", "runtime.test.ts"].map((file) =>
    withoutImports(
      readFileSync(new URL(`../../../packages/winston/test/${file}`, import.meta.url), "utf8")
    )
  )
  return transpile(
    [
      'import { EventEmitter } from "node:events"',
      'import { background, canceled, withCancelCause, withTimeout } from "@likego/context"',
      'import * as publicApi from "@likego/winston"',
      'import { newWinstonServer } from "@likego/winston"',
      behaviorHarness(),
      ...sources,
      behaviorRunner()
    ].join("\n")
  )
}

/** Exercises the complete raw Registry and standard Web Handler behavior without a wrapper façade. */
function prometheusRuntimeModule(): string {
  return transpile(`
import { Counter, Registry, register } from "prom-client"
import { createPrometheusHandler } from "@likego/prometheus"

function requireValue(value, message) { if (!value) throw new Error(message) }
async function response(handler, path = "/metrics", method = "GET") {
  return await handler(new Request(\`https://service.test\${path}\`, { method }))
}

export async function run() {
  register.clear()
  const registry = new Registry()
  requireValue(registry instanceof Registry, "registry is not official")
  const counter = new Counter({ name: "published_requests_total", help: "Published requests.", registers: [registry] })
  counter.inc(2)
  const handler = createPrometheusHandler(registry)
  const get = await response(handler)
  const body = await get.text()
  requireValue(get.status === 200 && body.includes("published_requests_total 2"), "GET scrape failed")
  requireValue(get.headers.get("Cache-Control") === "no-store", "cache policy missing")
  requireValue(get.headers.get("Content-Length") === String(new TextEncoder().encode(body).byteLength), "GET length drifted")
  const head = await response(handler, "/metrics", "HEAD")
  requireValue(head.status === 200 && await head.text() === "", "HEAD scrape failed")
  requireValue(head.headers.get("Content-Length") === get.headers.get("Content-Length"), "HEAD length drifted")

  const openMetrics = new Registry()
  openMetrics.setContentType(Registry.OPENMETRICS_CONTENT_TYPE)
  const openResponse = await response(createPrometheusHandler(openMetrics))
  requireValue(openResponse.headers.get("Content-Type") === Registry.OPENMETRICS_CONTENT_TYPE, "OpenMetrics type drifted")

  const custom = createPrometheusHandler(new Registry(), { path: "/internal/metrics" })
  requireValue((await response(custom)).status === 404, "unknown path was accepted")
  const method = await response(custom, "/internal/metrics", "POST")
  requireValue(method.status === 405 && method.headers.get("Allow") === "GET, HEAD", "method boundary failed")

  const broken = new Registry()
  Object.defineProperty(broken, "metrics", { value: async () => { throw new Error("private-secret") } })
  const failedGet = await response(createPrometheusHandler(broken))
  requireValue(failedGet.status === 500 && await failedGet.text() === "metrics unavailable\\n", "GET failure leaked")
  const failedHead = await response(createPrometheusHandler(broken), "/metrics", "HEAD")
  requireValue(failedHead.status === 500 && await failedHead.text() === "", "HEAD failure leaked")

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const concurrent = new Registry()
  Object.defineProperty(concurrent, "metrics", { value: async () => { calls += 1; const current = calls; await gate; return \`published_concurrent \${current}\\n\` } })
  const concurrentHandler = createPrometheusHandler(concurrent)
  const first = response(concurrentHandler)
  const second = response(concurrentHandler)
  await Promise.resolve()
  release()
  const results = await Promise.all([first, second])
  requireValue(await results[0].text() === "published_concurrent 1\\n", "first concurrent scrape drifted")
  requireValue(await results[1].text() === "published_concurrent 2\\n", "second concurrent scrape drifted")

  const structural = { contentType: Registry.PROMETHEUS_CONTENT_TYPE, async metrics() { return "structural 1\\n" } }
  requireValue((await response(createPrometheusHandler(structural))).status === 200, "structural registry rejected")
  for (const invalid of [null, 1, {}, { metrics: 1 }, { metrics() {} }, { metrics() {}, contentType: "wrong" }]) {
    let rejected = false
    try { createPrometheusHandler(invalid) } catch { rejected = true }
    requireValue(rejected, "invalid registry accepted")
  }
  const hostile = Object.defineProperty({}, "metrics", { get() { throw new Error("hostile") } })
  try { createPrometheusHandler(hostile); throw new Error("hostile registry accepted") } catch (error) { if (error?.message === "hostile registry accepted") throw error }
  for (const path of ["", "metrics", "/metrics?format=text", "/metrics#fragment", "/a/../metrics"]) {
    let rejected = false
    try { createPrometheusHandler(new Registry(), { path }) } catch { rejected = true }
    requireValue(rejected, "invalid metrics path accepted")
  }
  registry.clear()
  register.clear()
}
`)
}

/** Exercises the current Kratos-style Registry contract from packed exports. */
function alignedRegistryRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import { newRoundRobinSelector } from "@likego/registry"
import {
  notifyRegistrationError,
  providerOptions,
  snapshotServiceInstance,
  snapshotServiceInstances
} from "@likego/registry/provider"

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

function backend() {
  return { services: new Map(), watchers: new Map() }
}

function memoryRegistry(shared = backend()) {
  function snapshot(name) {
    return snapshotServiceInstances(Array.from(shared.services.values()).filter((value) => value.name === name))
  }

  function publish(name) {
    for (const notify of shared.watchers.get(name) ?? []) notify(snapshot(name))
  }

  return Object.freeze({
    async register(_ctx, service) {
      const value = snapshotServiceInstance(service)
      shared.services.set(value.name + "\\0" + value.id, value)
      publish(value.name)
    },
    async deregister(_ctx, service) {
      shared.services.delete(service.name + "\\0" + service.id)
      publish(service.name)
    },
    async getService(_ctx, name) { return snapshot(name) },
    async watch(_ctx, name) {
      const initial = snapshot(name)
      const queue = initial.length === 0 ? [] : [initial]
      const waiting = []
      let stopped = false
      const watchers = shared.watchers.get(name) ?? new Set()
      shared.watchers.set(name, watchers)
      function notify(value) {
        const pending = waiting.shift()
        if (pending === undefined) queue.push(value)
        else pending.resolve(value)
      }
      watchers.add(notify)
      return Object.freeze({
        async next() {
          if (stopped) throw new Error("watcher stopped")
          const value = queue.shift()
          return value ?? await new Promise((resolve, reject) => waiting.push({ resolve, reject }))
        },
        async stop() {
          if (stopped) return
          stopped = true
          watchers.delete(notify)
          queue.length = 0
          for (const pending of waiting.splice(0)) pending.reject(new Error("watcher stopped"))
        }
      })
    }
  })
}

export async function run() {
  const fixture = (revision) => ({
    id: "orders-a",
    name: "orders",
    version: revision === "initial" ? "v1" : "v2",
    metadata: { zone: "a" },
    endpoints: [revision === "initial" ? "http://127.0.0.1:8080" : "http://127.0.0.1:8081"]
  })
  const shared = backend()
  const publisher = memoryRegistry(shared)
  const reader = memoryRegistry(shared)
  const initial = snapshotServiceInstance(fixture("initial"))
  const updated = snapshotServiceInstance(fixture("updated"))
  await publisher.register(background(), initial)
  const watcher = await reader.watch(background(), initial.name)

  requireValue((await watcher.next(background()))[0]?.id === initial.id, "Registry watch omitted initial snapshot")
  const update = watcher.next(background())
  await publisher.register(background(), updated)
  requireValue((await reader.getService(background(), updated.name))[0]?.version === "v2", "Registry update was not discoverable")
  requireValue((await update)[0]?.version === "v2", "Registry watch omitted update")
  const removal = watcher.next(background())
  await publisher.deregister(background(), updated)
  requireValue((await removal).length === 0, "Registry watch omitted deregistration")
  const stopped = watcher.next(background()).then(
    () => false,
    (error) => error instanceof Error && error.message === "watcher stopped"
  )
  await watcher.stop(background())
  requireValue(await stopped, "Registry watcher stop left next pending")

  const instance = initial
  const selected = newRoundRobinSelector().select(background(), [instance])
  requireValue(
    selected[0].instance.id === instance.id && selected[0].url === instance.endpoints[0],
    "Registry selector changed"
  )
  selected[1](background(), { error: null })

  const terminal = new Error("resident registration failed")
  let observed = null
  const options = providerOptions({
    onRegistrationError(error, service) {
      observed = { error, service }
      return Promise.reject(new Error("observer rejected"))
    }
  })
  notifyRegistrationError(options.onRegistrationError, terminal, instance)
  await Promise.resolve()
  requireValue(observed?.error === terminal, "Registry terminal error was not forwarded")
  requireValue(
    observed?.service !== instance && Object.isFrozen(observed?.service),
    "Registry terminal notification did not receive a defensive snapshot"
  )
}
`
}

/** Exercises the portable unary HTTP Transport through one injected Fetch executor. */
function alignedTransportHTTPRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import { executor, maxMessageBytes, newHTTPTransport } from "@likego/transport-http"

export async function run() {
  const execute = Object.assign(
    async () => new Response(new Uint8Array([9]), { status: 200 }),
    { preconnect() {} }
  )
  const transport = newHTTPTransport(executor(execute), maxMessageBytes(1024))
  const client = await transport.dial(background(), "service.test:8080")
  await client.send(background(), { header: { published: "yes" }, body: new Uint8Array([1]) })
  const response = await client.recv(background())
  await client.close(background())
  if (response.body[0] !== 9 || transport.kind() !== "http") {
    throw new Error("portable HTTP unary transport changed")
  }
}
`
}

/** Exercises the Node provider with one real TCP unary round trip. */
function alignedTransportHTTPNodeRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import { newNodeHTTPTransport } from "@likego/transport-http/node"

export async function run() {
  const transport = newNodeHTTPTransport()
  const listener = await transport.listen(background(), "127.0.0.1:0")
  const serving = listener.accept(background(), async (ctx, socket) => {
    const request = await socket.recv(ctx)
    await socket.send(ctx, { header: { published: "node" }, body: request.body })
  })
  const client = await transport.dial(background(), listener.addr())
  try {
    await client.send(background(), { header: {}, body: new Uint8Array([7]) })
    const response = await client.recv(background())
    if (response.header.published !== "node" || response.body[0] !== 7) {
      throw new Error("Node HTTP unary round trip changed")
    }
  } finally {
    await client.close(background())
    await listener.close(background())
    await serving
  }
}
`
}

/** Exercises the current OTel lifecycle and unary/Web instrumentation exports. */
function alignedOtelRuntimeModule(): string {
  return `
import { background } from "@likego/context"
import {
  newOtelServer,
  otelShutdownTimeout,
  traceClient,
  traceUnaryMiddleware,
  traceWebHandler
} from "@likego/otel"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { TracerProvider } from "@opentelemetry/sdk-trace"

export async function run() {
  const resource = resourceFromAttributes({ "service.name": "published" })
  const tracerProvider = new TracerProvider({ resource, spanProcessors: [] })
  const meterProvider = new MeterProvider({ resource, readers: [] })
  const tracer = tracerProvider.getTracer("published")
  const server = newOtelServer({ tracerProvider, meterProvider }, otelShutdownTimeout(1_000))
  const running = server.start(background())
  await Promise.resolve()

  const message = Object.freeze({ header: Object.freeze({}), body: new Uint8Array([1]) })
  const client = traceClient(
    {
      async call() {
        return message
      },
      async close() {}
    },
    tracer
  )
  const response = await client.call(background(), {
    service: "orders",
    endpoint: "Orders.Get",
    message
  })
  if (response !== message) throw new Error("traced Client changed the response")

  const unary = traceUnaryMiddleware(tracer)(async (_ctx, request) => request)
  const routed = { header: { "Likego-Service": "orders", "Likego-Endpoint": "Orders.Get" }, body: new Uint8Array() }
  if (await unary(background(), routed) !== routed) throw new Error("unary trace middleware changed the response")

  const webResponse = new Response("ok")
  if (traceWebHandler(() => webResponse, tracer)(new Request("https://service.test")) !== webResponse) {
    throw new Error("Web trace handler changed the response")
  }

  await server.stop(background())
  await running
}
`
}

/** Registers published cases for registry, configuration-center, and observability integrations. */
export function registerIntegrationCases(registry: PublishedBusinessCaseRegistry): void {
  registry.register({
    package: "@likego/registry",
    exports: [".", "./provider"],
    runtimeModule: alignedRegistryRuntimeModule(),
    typeConsumer: `
import {
  filterLabel,
  filterVersion,
  newEWMASelector,
  newRoundRobinSelector,
  type Discovery,
  type EWMASelectorOptions,
  type Filter,
  type Registrar,
  type SelectionDone,
  type SelectionOutcome,
  type Selector,
  type ServiceEndpoint,
  type ServiceInstance,
  type Watcher
} from "@likego/registry"
import {
  notifyRegistrationError,
  providerOptions,
  snapshotServiceInstance,
  snapshotServiceInstances,
  type ProviderOptionInput,
  type ProviderOptions,
  type RegistrationErrorHandler
} from "@likego/registry/provider"
import { background } from "@likego/context"

void newRoundRobinSelector
const ewmaOptions: EWMASelectorOptions = {
  random: () => 0,
  now: () => 0,
  isFailure: () => false
}
void newEWMASelector(ewmaOptions)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
void providerOptions({})
void snapshotServiceInstance
void snapshotServiceInstances
declare const discovery: Discovery
declare const watcher: Watcher
declare const registrar: Registrar
declare const done: SelectionDone
const outcome: SelectionOutcome = { error: null }
done(background(), outcome)
declare const selector: Selector
declare const endpoint: ServiceEndpoint
declare const instance: ServiceInstance
const registrationErrorHandler: RegistrationErrorHandler = (_error, _service) => Promise.resolve()
const providerInput: ProviderOptionInput = { onRegistrationError: registrationErrorHandler }
const normalizedProviderOptions: ProviderOptions = providerOptions(providerInput)
notifyRegistrationError(normalizedProviderOptions.onRegistrationError, new Error("terminal"), instance)
void [
  discovery,
  watcher,
  registrar,
  filters,
  done,
  outcome,
  selector,
  endpoint,
  instance,
  ewmaOptions,
  registrationErrorHandler,
  providerInput,
  normalizedProviderOptions
]
`
  })

  registry.register({
    package: "@likego/registry-consul",
    exports: ["."],
    runtimeModule: registryConsulRuntimeModule(),
    typeConsumer: `
import {
  newConsulRegistry,
  type ConsulFetch,
  type ConsulHttpError,
  type ConsulOperation,
  type ConsulRegistry,
  type ConsulRegistryOptions,
  type ConsulTransportError
} from "@likego/registry-consul"
import type { RegistrationErrorHandler } from "@likego/registry/provider"

const fetch: ConsulFetch = async (_input, _init): Promise<Response> => new Response(null)
const registrationErrorHandler: RegistrationErrorHandler = (_error, _service) => Promise.resolve()
const options: ConsulRegistryOptions = {
  fetch,
  address: "https://consul.example",
  token: "token",
  datacenter: "dc1",
  namespace: "default",
  waitMs: 30_000,
  minimumQueryIntervalMs: 25,
  retryInitialMs: 100,
  retryMaximumMs: 5_000,
  deregisterCriticalServiceAfterMs: 60_000,
  watchBufferSize: 128,
  onRegistrationError: registrationErrorHandler
}
const registry: ConsulRegistry = newConsulRegistry(options)
declare const http: ConsulHttpError
declare const transport: ConsulTransportError
const operations: readonly ConsulOperation[] = ["register", "heartbeat", "deregister", "readback", "get", "watch"]
const httpName: "ConsulHttpError" = http.name
const httpCode: "LIKEGO_CONSUL_HTTP" = http.code
const httpOperation: ConsulOperation = http.operation
const httpStatus: number = http.status
const transportName: "ConsulTransportError" = transport.name
const transportCode: "LIKEGO_CONSUL_TRANSPORT" = transport.code
const transportOperation: ConsulOperation = transport.operation
const transportCause: Error = transport.cause
void [
  registry,
  fetch,
  httpName,
  httpCode,
  httpOperation,
  httpStatus,
  operations,
  options,
  transportName,
  transportCode,
  transportOperation,
  transportCause
]
`
  })

  registry.register({
    package: "@likego/config-consul",
    exports: ["."],
    runtimeModule: configConsulRuntimeModule(),
    typeConsumer: `
import type { ConfigObject, ConfigSource } from "@likego/config"
import {
  consulSource,
  jsonConsulDecoder,
  type ConsulConsistency,
  type ConsulDecoder,
  type ConsulFetch,
  type ConsulHttpError,
  type ConsulSourceOptions
} from "@likego/config-consul"

const fetch: ConsulFetch = async (request: Request): Promise<Response> => new Response(request.url, {
  headers: { "X-Consul-Index": "1" }
})
const decoder: ConsulDecoder = (text: string, _key: string): ConfigObject => ({ text })
const consistency: ConsulConsistency = "consistent"
const options: ConsulSourceOptions = {
  fetch,
  address: "https://consul.example",
  key: "app/config",
  consistency,
  decode: decoder
}
const source: ConfigSource = consulSource(options)
const decoded: ConfigObject = jsonConsulDecoder('{"enabled":true}', "app/config")
declare const httpError: ConsulHttpError
void [source, decoded, httpError]
`
  })

  registry.register({
    package: "@likego/pino",
    exports: ["."],
    runtimeModule: pinoRuntimeModule(),
    typeConsumer: `
import type { Server } from "@likego/core"
import pino, { type Logger } from "pino"
import {
  newPinoServer,
  pinoDrainTimeout,
  type PinoAlreadyStartedError,
  type PinoDestinationClosedError,
  type PinoDrainTimeoutError,
  type PinoServer,
  type PinoServerOption
} from "@likego/pino"

declare const logger: Logger
declare const destination: ReturnType<typeof pino.destination>
declare const transport: ReturnType<typeof pino.transport>
const option: PinoServerOption = pinoDrainTimeout(25_000)
const logging: PinoServer = newPinoServer(logger, destination, option)
const transported: Server = newPinoServer(logger, transport)
const structural: Server = logging
declare const already: PinoAlreadyStartedError
declare const closed: PinoDestinationClosedError
declare const timeout: PinoDrainTimeoutError
void [structural, transported, already.status, closed.code, timeout.timeoutMs]
`
  })

  registry.register({
    package: "@likego/winston",
    exports: ["."],
    runtimeModule: winstonRuntimeModule(),
    typeConsumer: `
import type { Server } from "@likego/core"
import type { Logger } from "winston"
import {
  newWinstonServer,
  type WinstonAlreadyStartedError,
  type WinstonLoggerClosedError,
  type WinstonLoggerFinishedError,
  type WinstonServer
} from "@likego/winston"

declare const logger: Logger
const logging: WinstonServer = newWinstonServer(logger)
const structural: Server = logging
declare const already: WinstonAlreadyStartedError
declare const closed: WinstonLoggerClosedError
declare const finished: WinstonLoggerFinishedError
void [structural, already.status, closed.code, finished.code]
`
  })

  registry.register({
    package: "@likego/prometheus",
    exports: ["."],
    runtimeModule: prometheusRuntimeModule(),
    typeConsumer: `
import type { Handler } from "@likego/web"
import { Registry } from "prom-client"
import { createPrometheusHandler, type PrometheusHandlerOptions } from "@likego/prometheus"

const registry: Registry = new Registry()
const options: PrometheusHandlerOptions = { path: "/internal/metrics" }
const handler: Handler = createPrometheusHandler(registry, options)
void handler
`
  })

  registry.register({
    package: "@likego/otel",
    exports: ["."],
    runtimeModule: alignedOtelRuntimeModule(),
    typeConsumer: `
import type { Broker } from "@likego/broker"
import type { Client } from "@likego/client"
import type { Server } from "@likego/core"
import type { Middleware } from "@likego/server"
import type { MeterProvider } from "@opentelemetry/sdk-metrics"
import type { TracerProvider } from "@opentelemetry/sdk-trace"
import {
  defaultOtelShutdownTimeoutMs,
  newOtelServer,
  otelShutdownTimeout,
  traceBroker,
  traceClient,
  traceUnaryMiddleware,
  traceWebHandler,
  type OtelAlreadyStartedError,
  type OtelProviders,
  type OtelServer,
  type OtelShutdownTimeoutError,
} from "@likego/otel"

declare const tracerProvider: TracerProvider
declare const meterProvider: MeterProvider
const providers: OtelProviders = { tracerProvider, meterProvider }
const subject: OtelServer = newOtelServer(providers, otelShutdownTimeout(25_000))
const server: Server = subject
declare const client: Client
declare const broker: Broker<void, void, void, unknown>
const tracer = tracerProvider.getTracer("published")
const tracedClient: Client = traceClient(client, tracer)
const tracedBroker: Broker<void, void, void, unknown> = traceBroker(broker, tracer)
const unaryTrace: Middleware = traceUnaryMiddleware(tracer)
const webTrace: (request: Request) => Response | Promise<Response> = traceWebHandler(
  (_request) => new Response(),
  tracer
)
declare const already: OtelAlreadyStartedError
declare const timeout: OtelShutdownTimeoutError
void meterProvider.getMeter("published")
void [
  defaultOtelShutdownTimeoutMs,
  server,
  already,
  timeout,
  tracedClient,
  tracedBroker,
  unaryTrace,
  webTrace
]
`
  })

  registry.register({
    package: "@likego/elysia",
    exports: ["."],
    runtimeModule: frameworkRuntimeModule({
      packageName: "@likego/elysia",
      factory: "newElysiaHandler",
      nativePackage: "elysia",
      nativeType: "Elysia",
      invalidApplicationMessage: "app must be an Elysia application",
      route:
        'const app = new Elysia().get("/users/:id", ({ params }) => ({ framework: "elysia", id: params.id }))',
      requestURL: "https://localhost/users/42",
      expectedFramework: "elysia"
    }),
    typeConsumer: `
import type { Handler } from "@likego/web"
import { newElysiaHandler, type ElysiaApplication } from "@likego/elysia"

const app: ElysiaApplication = { fetch: (_request: Request) => new Response() }
const handler: Handler = newElysiaHandler(app)
void handler
`
  })
  registry.register({
    package: "@likego/h3",
    exports: ["."],
    runtimeModule: transpile(`
import { newH3Handler } from "@likego/h3"
import { createApp, createRouter, defineEventHandler, getRouterParam } from "h3"

function requireValue(value, message) {
  if (!value) throw new Error(message)
}

export async function run() {
  for (const invalid of [null, 1, {}, { handler: 1 }]) {
    let rejected = false
    try { newH3Handler(invalid) } catch (error) {
      rejected = error instanceof TypeError && error.message === "app must be an H3 application"
    }
    requireValue(rejected, "invalid native application was accepted")
  }

  const streamApp = createApp().use(
    defineEventHandler(() => new Response("published", { status: 201 }))
  )
  const streamResponse = await newH3Handler(streamApp)(
    new Request("https://service.test/stream")
  )
  requireValue(streamResponse.status === 201, "native response status changed")
  requireValue(await streamResponse.text() === "published", "native response body changed")

  const router = createRouter().get(
    "/users/:id",
    defineEventHandler((event) => ({ framework: "h3", id: getRouterParam(event, "id") }))
  )
  const app = createApp().use(router.handler)
  const routedResponse = await newH3Handler(app)(
    new Request("https://service.test/users/42")
  )
  requireValue(routedResponse instanceof Response, "native route did not return a Response")
  const payload = await routedResponse.json()
  requireValue(payload.framework === "h3" && payload.id === "42", "native route payload drifted")
}
`),
    typeConsumer: `
import type { Handler } from "@likego/web"
import { newH3Handler, type H3Application } from "@likego/h3"
import { createApp } from "h3"

const app: H3Application = createApp()
const handler: Handler = newH3Handler(app)
void handler
`
  })
  registry.register({
    package: "@likego/hono",
    exports: ["."],
    runtimeModule: frameworkRuntimeModule({
      packageName: "@likego/hono",
      factory: "newHonoHandler",
      nativePackage: "hono",
      nativeType: "Hono",
      invalidApplicationMessage: "app must be a Hono application",
      route:
        'const app = new Hono().get("/users/:id", (context) => context.json({ framework: "hono", id: context.req.param("id") }))',
      requestURL: "https://service.test/users/42",
      expectedFramework: "hono"
    }),
    typeConsumer: frameworkTypeConsumer("@likego/hono", "newHonoHandler", "hono", "Hono")
  })
  const mdnsPortableRuntime = mdnsPortableRuntimeModule()
  registry.register({
    package: "@likego/registry-mdns",
    exports: [".", "./node"],
    runtimeModule: mdnsPortableRuntime,
    typeConsumer: identityTypeConsumer("@likego/registry-mdns", [".", "./node"]),
    runtimeModules: {
      ".": mdnsPortableRuntime,
      "./node": mdnsNodeRuntimeModule()
    },
    typeConsumers: {
      ".": mdnsRootTypeConsumer(),
      "./node": mdnsNodeTypeConsumer()
    }
  })
  const transportRootRuntime = transportRootRuntimeModule()
  const transportRootTypes = transportRootTypeConsumer()
  const transportHeadersTypes = transportHeadersTypeConsumer()
  const transportJSONRuntime = transportJSONRuntimeModule()
  const transportJSONTypes = transportJSONTypeConsumer()
  registry.register({
    package: "@likego/transport",
    exports: [".", "./headers", "./json", "./provider"],
    runtimeModule: transportRootRuntime,
    typeConsumer: identityTypeConsumer("@likego/transport", [
      ".",
      "./headers",
      "./json",
      "./provider"
    ]),
    runtimeModules: {
      ".": transportRootRuntime,
      "./headers": transportHeadersRuntimeModule(),
      "./json": transportJSONRuntime,
      "./provider": transportRootRuntime
    },
    typeConsumers: {
      ".": transportRootTypes,
      "./headers": transportHeadersTypes,
      "./json": transportJSONTypes,
      "./provider": transportRootTypes
    }
  })
  registry.register({
    package: "@likego/transport-memory",
    exports: ["."],
    runtimeModule: transportMemoryRuntimeModule(),
    typeConsumer: transportMemoryTypeConsumer()
  })
  registry.register({
    package: "@likego/transport-http",
    exports: [".", "./node"],
    runtimeModule: alignedTransportHTTPRuntimeModule(),
    typeConsumer: identityTypeConsumer("@likego/transport-http", [".", "./node"]),
    runtimeModules: {
      ".": alignedTransportHTTPRuntimeModule(),
      "./node": alignedTransportHTTPNodeRuntimeModule()
    },
    typeConsumers: {
      ".": transportHTTPRootTypeConsumer(),
      "./node": transportHTTPNodeTypeConsumer()
    }
  })
}
