import { expect, test } from "bun:test"

import { normalizeHTTPDialTarget, normalizeHTTPListenAddress } from "../src/address"

test("normalizes absolute HTTP URLs without losing path or query", () => {
  expect(normalizeHTTPDialTarget("https://example.test:8443/a/b?x=1", false)).toEqual({
    href: "https://example.test:8443/a/b?x=1",
    origin: "https://example.test:8443"
  })
})

test("normalizes authority targets with secure-driven scheme", () => {
  expect(normalizeHTTPDialTarget("example.test:8080", false)).toEqual({
    href: "http://example.test:8080/",
    origin: "http://example.test:8080"
  })
  expect(normalizeHTTPDialTarget("[::1]:8443", true)).toEqual({
    href: "https://[::1]:8443/",
    origin: "https://[::1]:8443"
  })
})

test("rejects unsafe dial targets before any network operation", () => {
  const invalid = [
    "",
    "http://[",
    "ftp://example.test:21",
    "http://user:secret@example.test",
    "http://example.test/#fragment",
    "example.test:80/path",
    "example.test:80?x=1",
    "example.test:80#x"
  ]
  for (const value of invalid) {
    expect(() => normalizeHTTPDialTarget(value, false)).toThrow()
  }
  expect(() => normalizeHTTPDialTarget("http://example.test", true)).toThrow()
})

test("listen addresses remain host-port authorities", () => {
  expect(normalizeHTTPListenAddress("127.0.0.1:0")).toBe("127.0.0.1:0")
  expect(normalizeHTTPListenAddress("[::1]:0")).toBe("[::1]:0")
  for (const value of ["", "http://127.0.0.1:0", "localhost", "localhost:1/x", "localhost:1?x=1"]) {
    expect(() => normalizeHTTPListenAddress(value)).toThrow()
  }
})
