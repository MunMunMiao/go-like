import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { connect, type ClientHttp2Session } from "node:http2"

import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import {
  secure,
  tlsConfig,
  type Message,
  type TLSConfig,
  type TLSEncodedBytes
} from "@go-like/transport"

import { allowHTTP1, clientAuth, newNodeHTTPTransport } from "../src/node"
import type { HTTPListener } from "../src/types"

const ca = readFileSync(new URL("fixtures/tls/ca.pem", import.meta.url))
const serverCertificate = readFileSync(new URL("fixtures/tls/server.pem", import.meta.url))
const serverKey = readFileSync(new URL("fixtures/tls/server-key.pem", import.meta.url))
const clientKey = readFileSync(new URL("fixtures/tls/client-key.pem", import.meta.url))

const PeerIdentityHeader = "Go-Like-Peer-Identity"
const DestPeerIdentity = "spiffe://ms020/machine/alpha"

/** Self-signed SPIFFE leaf for the existing fixtures/tls/client-key.pem. */
const spiffeClientCertificate = Buffer.from(`-----BEGIN CERTIFICATE-----
MIIDRjCCAi6gAwIBAgIUJhjMtSvQmnVxyNREKWViQO93YMMwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTbXMwMjAtbWFjaGluZS1hbHBoYTAeFw0yNjA4MjExMDQz
MDRaFw0zNjA4MTgxMDQzMDRaMB4xHDAaBgNVBAMME21zMDIwLW1hY2hpbmUtYWxw
aGEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC1NEd8AVXCIaUbdfpp
R8ERN3Cjs3aq8fNJD/crOALvi/YqzBBQ/rv4yaY+hqKBs9n8k1FWgalGGY9Dp6Nn
mL2UkqQ8Q7yFPGG7HYT8uSCAdBMMCaciIh9g8u0aV71qy6qt2G22csQNoOkpEsfG
rVi7Urv2igByNhmOqv+OIkVFBn488JPc+5Pa2Z4UJQP5tlui3c/N+3eDNOtxsoeC
p8hEy4x6yuYPwyhFGr2iv3n6ajHkx88e3pDYDx+ez9IRCrYb7rEbe6l8XPQEkEJc
ax1hlbk28gdz+tFzxaNYJHRmkjYK98gD0hkGxiZ96pa+mzYGkNMTEq4bZVivT6bD
kT3NAgMBAAGjfDB6MB0GA1UdDgQWBBRgVL9MDyuHC07TyYuHEh3jDhMxrjAfBgNV
HSMEGDAWgBRgVL9MDyuHC07TyYuHEh3jDhMxrjAPBgNVHRMBAf8EBTADAQH/MCcG
A1UdEQQgMB6GHHNwaWZmZTovL21zMDIwL21hY2hpbmUvYWxwaGEwDQYJKoZIhvcN
AQELBQADggEBABnOjO6oV2E6muKj+Epb3/B7x45FcsKEX+7jztMIN30S6+eBVkdg
bclhpbC0Nh1HoTSVbGyh8Aloq3y7hQQD5WyE2bkhgjrFybSh34IpzdF2X3YfN9D2
PioTST9o4Q+QQzzxZ2SUU4EIWkEVNA9WnM8r0TlcBDbcKA3IKEXwQhpJoSoCKJOg
DYf1yGtgrCFr4YzCfncam0QsObdxQYlc9dNP043ykPj7OGdVD9si0H46AqrE2t3N
F7NvwlZ0HEHhrmGOe+1ZHsEs6UEnVb/D9iZ6WBKkf8izzcHgJjBhGyrnDrvngQT/
scmwJB7hPN4SY8GgGtyiYX9kkBPFEw25N3Y=
-----END CERTIFICATE-----
`)

interface HTTP2Reply {
  readonly status: number
  readonly body: string
}

/** Creates one detached PEM transport value. */
function pem(bytes: Uint8Array): TLSEncodedBytes {
  return Object.freeze({ encoding: "pem", bytes: new Uint8Array(bytes) })
}

/** Concatenates PEM documents for a Node CA bundle. */
function pemBundle(...certs: Uint8Array[]): Uint8Array {
  const newline = new Uint8Array([0x0a])
  const chunks: Uint8Array[] = []
  for (const cert of certs) {
    chunks.push(cert)
    if (cert.byteLength === 0 || cert[cert.byteLength - 1] !== 0x0a) chunks.push(newline)
  }
  const length = chunks.reduce(function total(sum, chunk): number {
    return sum + chunk.byteLength
  }, 0)
  const bundle = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bundle.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bundle
}

/** Creates the server identity and mTLS trust used by the peer-identity test. */
function serverTLS(): TLSConfig {
  return Object.freeze({
    serverName: null,
    caCertificate: pem(pemBundle(ca, spiffeClientCertificate)),
    certificateChain: pem(serverCertificate),
    privateKey: pem(serverKey)
  })
}

/** Returns the port portion of one normalized host-port authority. */
function port(address: string): number {
  return Number(address.slice(address.lastIndexOf(":") + 1))
}

/** Reads one header name case-insensitively. */
function headerValue(header: Readonly<Record<string, string>>, name: string): string | undefined {
  const expected = name.toLowerCase()
  let found: string | undefined
  for (const key of Object.keys(header)) {
    if (key.toLowerCase() !== expected) continue
    if (found !== undefined) throw new Error(`duplicate ${name} header`)
    found = header[key]
  }
  return found
}

/** Returns the sole URI SAN from one PEM certificate. */
function uriSAN(value: Uint8Array): string {
  const altName = new X509Certificate(value).subjectAltName ?? ""
  const uris: string[] = []
  for (const part of altName.split(",")) {
    const item = part.trim()
    if (!item.toLowerCase().startsWith("uri:")) continue
    uris.push(item.slice(4))
  }
  if (uris.length !== 1) {
    throw new Error(`client certificate must contain exactly one URI SAN: ${altName}`)
  }
  const selected = uris[0]
  if (selected === undefined) throw new Error("URI SAN is missing")
  return selected
}

/** Opens a verified HTTP/2 session with the SPIFFE client certificate. */
function openHTTP2(address: string): ClientHttp2Session {
  return connect(`https://localhost:${port(address)}`, {
    ca,
    cert: spiffeClientCertificate,
    key: clientKey,
    servername: "localhost",
    rejectUnauthorized: true
  })
}

/** Executes one POST over a caller-owned HTTP/2 session. */
function requestHTTP2(
  session: ClientHttp2Session,
  path: string,
  body: string
): Promise<HTTP2Reply> {
  return new Promise<HTTP2Reply>(function exchange(resolve, reject): void {
    let status = 0
    const chunks: Buffer[] = []
    const request = session.request(
      Object.freeze({
        ":method": "POST",
        ":path": path,
        "content-type": "application/json"
      })
    )
    request.once("response", function headers(value): void {
      const received = value[":status"]
      status = typeof received === "number" ? received : Number(received)
    })
    request.once("error", reject)
    request.on("data", function received(chunk: Buffer): void {
      chunks.push(chunk)
    })
    request.once("end", function ended(): void {
      resolve(
        Object.freeze({
          status,
          body: Buffer.concat(chunks).toString()
        })
      )
    })
    request.end(body)
  })
}

test("clientAuth require exposes the verified URI SAN as Go-Like-Peer-Identity", async () => {
  expect(uriSAN(spiffeClientCertificate)).toBe(DestPeerIdentity)

  const transport = newNodeHTTPTransport(clientAuth("require"), allowHTTP1(false))
  transport.init(secure(true), tlsConfig(serverTLS()))
  const listener = (await transport.listen(background(), "127.0.0.1:0")) as HTTPListener
  const dispatched: Message[] = []
  const serving = listener.accept(background(), async function inspect(ctx, socket): Promise<void> {
    const request = await socket.recv(ctx)
    dispatched.push(request)
    await socket.send(ctx, {
      header: Object.freeze({ "Content-Type": "application/json" }),
      body: new TextEncoder().encode(
        JSON.stringify(
          Object.freeze({
            peerIdentity: headerValue(request.header, PeerIdentityHeader) ?? ""
          })
        )
      )
    })
  })
  let session: ClientHttp2Session | null = null
  try {
    await listener.accepted()
    session = openHTTP2(listener.addr())
    const reply = await requestHTTP2(
      session,
      "/v1/machine-commands",
      JSON.stringify(Object.freeze({ command: "reboot" }))
    )
    const request = dispatched[0]
    if (request === undefined) throw new Error("listener did not dispatch the mTLS request")
    expect(headerValue(request.header, PeerIdentityHeader)).toBe(DestPeerIdentity)
    expect(JSON.parse(reply.body)).toEqual(Object.freeze({ peerIdentity: DestPeerIdentity }))
  } finally {
    if (session !== null && !session.destroyed) session.destroy()
    await listener.close(background())
    await serving
  }
})
