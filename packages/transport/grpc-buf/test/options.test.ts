import { expect, test } from "bun:test"

import {
  advertise,
  canonicalAddress,
  clientAuth,
  clientOptions,
  parseServerAddress,
  parseServerAdvertise,
  serverOptions,
  withEndpoint,
  withTLSConfig,
  type ClientOption,
  type ClientOptions,
  type ServerOption,
  type ServerOptions
} from "../src/options"

function badClientOption(property: keyof ClientOptions, value: unknown): ClientOption {
  return (options) => {
    const snapshot = { ...options }
    Reflect.set(snapshot, property, value)
    return snapshot
  }
}

function badServerOption(property: keyof ServerOptions, value: unknown): ServerOption {
  return (options) => {
    const snapshot = { ...options }
    Reflect.set(snapshot, property, value)
    return snapshot
  }
}

function captureFailure(operation: () => unknown): Error {
  try {
    operation()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected operation to fail")
}

test("client option boundaries reject malformed runtime values", () => {
  const cases: ReadonlyArray<readonly [() => unknown, string]> = [
    [() => canonicalAddress(null), "gRPC address must be a non-empty string"],
    [
      () =>
        Reflect.apply(withTLSConfig, undefined, [
          {
            serverName: null,
            caCertificate: {
              encoding: "pkcs12",
              bytes: new Uint8Array()
            },
            certificateChain: null,
            privateKey: null
          }
        ]),
      "TLS material encoding must be pem or der"
    ],
    [
      () =>
        Reflect.apply(withTLSConfig, undefined, [
          {
            serverName: null,
            caCertificate: {
              encoding: "pem",
              bytes: "not bytes"
            },
            certificateChain: null,
            privateKey: null
          }
        ]),
      "TLS material bytes must be a Uint8Array"
    ],
    [
      () =>
        Reflect.apply(withTLSConfig, undefined, [
          {
            serverName: 42,
            caCertificate: null,
            certificateChain: null,
            privateKey: null
          }
        ]),
      "TLS serverName must be a string or null"
    ],
    [() => withEndpoint("discovery:///"), "withEndpoint discovery target must be non-empty"]
  ]

  for (const [operation, message] of cases) expect(operation).toThrow(message)
})

test("client option reduction revalidates custom snapshots", () => {
  const cases: ReadonlyArray<readonly [ClientOption, string]> = [
    [badClientOption("service", ""), "Client service must be a non-empty string or null"],
    [badClientOption("discovery", {}), "Client discovery must implement Discovery"],
    [badClientOption("selector", {}), "Client selector must implement Selector"],
    [
      badClientOption("addresses", ["https://rpc.example.test/", "https://rpc.example.test/"]),
      "Client addresses must not contain duplicates"
    ]
  ]

  for (const [option, message] of cases) {
    expect(() => clientOptions([option])).toThrow(message)
  }
})

test("client options reject HTTP direct addresses with TLS", () => {
  const failure = captureFailure(() =>
    clientOptions([
      withEndpoint(["https://one.example.test", "http://two.example.test"]),
      withTLSConfig({
        serverName: null,
        caCertificate: null,
        certificateChain: null,
        privateKey: null
      })
    ])
  )

  expect(failure).toBeInstanceOf(TypeError)
  expect(failure.message).toBe("http gRPC addresses cannot use TLS configuration")
})

test("server address boundaries reject malformed runtime values", () => {
  const cases: ReadonlyArray<readonly [() => unknown, string]> = [
    [() => parseServerAddress(" localhost:1"), "gRPC server address must be a non-empty host:port"],
    [() => parseServerAddress("["), "gRPC server address must be a host:port"],
    [() => parseServerAddress("user@localhost:1"), "gRPC server address must be a host:port"],
    [() => parseServerAdvertise(" localhost"), "gRPC server advertise must be a non-empty value"],
    [
      () => parseServerAdvertise("ftp://rpc.example.test"),
      "gRPC server advertise endpoint must use http or https"
    ],
    [
      () => parseServerAdvertise("http://["),
      "gRPC server advertise endpoint must be an absolute root URL"
    ],
    [
      () => parseServerAdvertise("http://user@rpc.example.test"),
      "gRPC server advertise endpoint must be an absolute root URL"
    ],
    [
      () => parseServerAdvertise("["),
      "gRPC server advertise must be a host, host:port, or HTTP endpoint"
    ],
    [
      () => parseServerAdvertise("user@rpc.example.test:1"),
      "gRPC server advertise must be a host, host:port, or HTTP endpoint"
    ],
    [() => parseServerAdvertise("%2f"), "gRPC server advertise must contain a valid HTTP host"]
  ]

  for (const [operation, message] of cases) expect(operation).toThrow(message)
})

test("server option boundaries reject malformed client authentication", () => {
  expect(() => serverOptions([badServerOption("clientAuth", "optional")])).toThrow(
    "gRPC server clientAuth must be none or require"
  )
  expect(() => Reflect.apply(clientAuth, undefined, ["optional"])).toThrow(
    "clientAuth must be none or require"
  )
})

test("server advertise validates the canonical HTTP host and assigned port", () => {
  for (const host of ["0", "0x0", "0.0", "%30.0.0.0"]) {
    expect(() => serverOptions([advertise(host)])).toThrow("wildcard")
    expect(() => serverOptions([advertise(`${host}:9000`)])).toThrow("wildcard")
  }
  for (const endpoint of ["rpc.example.test:0", "http://rpc.example.test:0"]) {
    expect(() => serverOptions([advertise(endpoint)])).toThrow("port")
  }
  expect(parseServerAdvertise("EXAMPLE.test:80")).toEqual({
    absolute: null,
    host: "example.test",
    port: "80"
  })
  expect(parseServerAdvertise("[::1]:443")).toEqual({
    absolute: null,
    host: "[::1]",
    port: "443"
  })
})
