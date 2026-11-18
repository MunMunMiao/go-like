const alphabet = "abcdefghijklmnopqrstuvwxyz234567"

/** SHA-256 of `bytes`, encoded as lowercase unpadded RFC 4648 base32 (52 characters). */
export async function sha256Base32(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("sha256Base32 requires a Uint8Array")
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy))
  let buffer = 0
  let bits = 0
  let encoded = ""
  for (const byte of digest) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += alphabet[(buffer >>> bits) & 31]
    }
  }
  if (bits > 0) encoded += alphabet[(buffer << (5 - bits)) & 31]
  return encoded
}
