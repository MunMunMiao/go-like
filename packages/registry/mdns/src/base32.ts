const alphabet = "abcdefghijklmnopqrstuvwxyz234567"

/** Encodes bytes as RFC 4648 lowercase Base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let output = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += alphabet.charAt((buffer >>> bits) & 31)
    }
  }
  output += alphabet.charAt((buffer << ((5 - bits) % 5)) & 31)
  return output.slice(0, Math.ceil((bytes.byteLength * 8) / 5))
}
