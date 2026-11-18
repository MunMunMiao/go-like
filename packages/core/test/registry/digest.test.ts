import { expect, test } from "bun:test"

import { sha256Base32 } from "../../src/registry/digest"

test("encodes SHA-256 as lowercase unpadded base32", async () => {
  const encoded = await sha256Base32(new TextEncoder().encode("go-like"))
  expect(encoded).toMatch(/^[a-z2-7]{52}$/)
  expect(await sha256Base32(new Uint8Array())).toMatch(/^[a-z2-7]{52}$/)
  expect(() => sha256Base32("no" as never)).toThrow("sha256Base32 requires a Uint8Array")
})
