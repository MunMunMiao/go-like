/** Identifies one DNS question or resource-record kind supported by LikeGo mDNS. */
export type DNSRecordType = "A" | "AAAA" | "PTR" | "SRV" | "TXT"

/** Describes one DNS question. */
export interface DNSQuestion {
  readonly name: string
  readonly type: DNSRecordType | "ANY"
}

/** Describes one DNS SRV payload. */
export interface DNSSRVData {
  readonly priority: number
  readonly weight: number
  readonly port: number
  readonly target: string
}

/** Describes one supported DNS resource record. */
export interface DNSRecord {
  readonly name: string
  readonly type: DNSRecordType
  readonly ttl: number
  readonly flush: boolean
  readonly data: string | DNSSRVData | readonly Uint8Array[]
}

/** Describes one complete supported DNS message. */
export interface DNSPacket {
  readonly id: number
  readonly response: boolean
  readonly questions: readonly DNSQuestion[]
  readonly answers: readonly DNSRecord[]
  readonly authorities: readonly DNSRecord[]
  readonly additionals: readonly DNSRecord[]
}

interface Cursor {
  offset: number
}

const typeCodes: Readonly<Record<DNSRecordType, number>> = Object.freeze({
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33
})

/** Reports whether an unknown record payload is structural SRV data. */
function isSRVData(value: unknown): value is DNSSRVData {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "priority" in value &&
    "weight" in value &&
    "port" in value &&
    "target" in value &&
    typeof value.priority === "number" &&
    typeof value.weight === "number" &&
    typeof value.port === "number" &&
    typeof value.target === "string"
  )
}

/** Validates one DNS packet-size ceiling used by public codec boundaries. */
function packetLimit(value: number): number {
  if (!Number.isInteger(value) || value < 512 || value > 1_200) {
    throw new RangeError("DNS maximumBytes must be an integer from 512 through 1200")
  }
  return value
}

/** Appends one unsigned 16-bit integer in network byte order. */
function writeU16(output: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("DNS uint16 value is out of range")
  }
  output.push((value >>> 8) & 255, value & 255)
}

/** Appends one RFC 2181 TTL in network byte order. */
function writeU32(output: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError("DNS TTL value is out of range")
  }
  output.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
}

/** Reads one byte or rejects a truncated packet. */
function readByte(data: Uint8Array, cursor: Cursor): number {
  const value = data[cursor.offset]
  if (value === undefined) throw new TypeError("DNS packet is truncated")
  cursor.offset += 1
  return value
}

/** Reads one unsigned 16-bit integer in network byte order. */
function readU16(data: Uint8Array, cursor: Cursor): number {
  return (readByte(data, cursor) << 8) | readByte(data, cursor)
}

/** Reads one unsigned 32-bit integer in network byte order. */
function readU32(data: Uint8Array, cursor: Cursor): number {
  return (
    readByte(data, cursor) * 16_777_216 +
    (readByte(data, cursor) << 16) +
    (readByte(data, cursor) << 8) +
    readByte(data, cursor)
  )
}

/** Resolves one supported record type code, or null for an extensible unknown RR. */
function recordType(code: number): DNSRecordType | null {
  if (code === 1) return "A"
  if (code === 12) return "PTR"
  if (code === 16) return "TXT"
  if (code === 28) return "AAAA"
  if (code === 33) return "SRV"
  return null
}

/** Encodes one normalized DNS name without pointer compression. */
function encodeName(output: number[], value: string): void {
  if (typeof value !== "string") throw new TypeError("DNS name must be a string")
  const labels = value.endsWith(".") ? value.slice(0, -1).split(".") : value.split(".")
  const normalized = validateDNSName(labels)
  const normalizedLabels = normalized.slice(0, -1).split(".")
  const encoder = new TextEncoder()
  for (const label of normalizedLabels) {
    const bytes = encoder.encode(label)
    output.push(bytes.byteLength)
    for (const byte of bytes) output.push(byte)
  }
  output.push(0)
}

/** Decodes one possibly pointer-compressed DNS name with loop protection. */
function decodeName(data: Uint8Array, cursor: Cursor): string {
  const labels: string[] = []
  const visited = new Set<number>()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let offset = cursor.offset
  let jumped = false
  let iterations = 0
  while (true) {
    if (iterations > 128) throw new TypeError("DNS name pointer depth is invalid")
    iterations += 1
    const length = data[offset]
    if (length === undefined) throw new TypeError("DNS name is truncated")
    if ((length & 0xc0) === 0xc0) {
      const next = data[offset + 1]
      if (next === undefined) throw new TypeError("DNS name pointer is truncated")
      const pointer = ((length & 0x3f) << 8) | next
      if (pointer >= data.byteLength || visited.has(pointer))
        throw new TypeError("DNS name pointer is invalid")
      visited.add(pointer)
      if (!jumped) cursor.offset = offset + 2
      jumped = true
      offset = pointer
      continue
    }
    if ((length & 0xc0) !== 0) throw new TypeError("DNS label length is invalid")
    offset += 1
    if (length === 0) {
      if (!jumped) cursor.offset = offset
      break
    }
    if (length > 63 || offset + length > data.byteLength)
      throw new TypeError("DNS label is invalid")
    const label = decoder.decode(data.slice(offset, offset + length))
    labels.push(label)
    offset += length
  }
  return labels.length === 0 ? "." : validateDNSName(labels)
}

/** Parses one IPv4 literal into four network-order octets. */
function encodeIPv4(value: string): Uint8Array {
  if (typeof value !== "string") throw new TypeError("DNS A data must be a string")
  const parts = value.split(".")
  if (parts.length !== 4) throw new TypeError("DNS A data must be an IPv4 literal")
  const bytes = new Uint8Array(4)
  for (const [index, part] of parts.entries()) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      throw new TypeError("DNS A data must be an IPv4 literal")
    }
    const number = Number(part)
    if (number > 255) throw new TypeError("DNS A data must be an IPv4 literal")
    bytes[index] = number
  }
  return bytes
}

/** Expands one IPv6 literal into eight 16-bit words. */
function ipv6Words(value: string): readonly number[] {
  if (typeof value !== "string" || value.length === 0 || value.includes("%")) {
    throw new TypeError("DNS AAAA data must be an IPv6 literal")
  }
  let normalized = value.toLowerCase()
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1)
  let ipv4: readonly number[] = Object.freeze([])
  const lastColon = normalized.lastIndexOf(":")
  const tail = normalized.slice(lastColon + 1)
  if (tail.includes(".")) {
    const bytes = encodeIPv4(tail)
    const embedded: number[] = []
    for (let index = 0; index < bytes.byteLength; index += 2) {
      let word = 0
      for (const byte of bytes.slice(index, index + 2)) word = (word << 8) | byte
      embedded.push(word)
    }
    ipv4 = Object.freeze(embedded)
    normalized = `${normalized.slice(0, lastColon)}:ipv4:tail`
  }
  const halves = normalized.split("::")
  if (halves.length > 2) throw new TypeError("DNS AAAA data must be an IPv6 literal")
  /** Converts one explicit IPv6 half to numeric words. */
  function half(valuePart: string): number[] {
    if (valuePart.length === 0) return []
    const words: number[] = []
    for (const part of valuePart.split(":")) {
      if (part === "ipv4") {
        for (const word of ipv4) words.push(word)
      } else if (part === "tail") continue
      else {
        if (!/^[0-9a-f]{1,4}$/.test(part))
          throw new TypeError("DNS AAAA data must be an IPv6 literal")
        words.push(Number.parseInt(part, 16))
      }
    }
    return words
  }
  const left = half(halves.slice(0, 1).join(""))
  const right = half(halves.slice(1, 2).join(""))
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new TypeError("DNS AAAA data must be an IPv6 literal")
  }
  const words: number[] = []
  for (const word of left) words.push(word)
  for (let index = 0; index < missing; index += 1) words.push(0)
  for (const word of right) words.push(word)
  if (words.length !== 8) throw new TypeError("DNS AAAA data must be an IPv6 literal")
  return Object.freeze(words)
}

/** Encodes one IPv6 literal into sixteen network-order octets. */
function encodeIPv6(value: string): Uint8Array {
  const words = ipv6Words(value)
  const bytes = new Uint8Array(16)
  let index = 0
  for (const word of words) {
    bytes[index * 2] = word >>> 8
    bytes[index * 2 + 1] = word & 255
    index += 1
  }
  return bytes
}

/** Formats sixteen network-order octets as one canonical compressed IPv6 literal. */
function decodeIPv6(data: Uint8Array): string {
  if (data.byteLength !== 16) throw new TypeError("DNS AAAA rdata length is invalid")
  const words: number[] = []
  for (let index = 0; index < 16; index += 2) {
    let word = 0
    for (const byte of data.slice(index, index + 2)) word = (word << 8) | byte
    words.push(word)
  }
  let bestStart = -1
  let bestLength = 0
  for (let start = 0; start < words.length;) {
    if (words[start] !== 0) {
      start += 1
      continue
    }
    let end = start
    while (end < words.length && words[end] === 0) end += 1
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start
      bestLength = end - start
    }
    start = end
  }
  const parts: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    if (index === bestStart) {
      parts.push("")
      index += bestLength - 1
      if (index === words.length - 1) parts.push("")
    } else {
      for (const word of words.slice(index, index + 1)) parts.push(word.toString(16))
    }
  }
  const joined = parts.join(":")
  return joined.startsWith(":") ? `:${joined}` : joined
}

/** Encodes one resource-record payload to wire bytes. */
function encodeRecordData(record: DNSRecord): Uint8Array {
  const output: number[] = []
  if (record.type === "A") {
    if (typeof record.data !== "string") throw new TypeError("DNS A data must be a string")
    return encodeIPv4(record.data)
  }
  if (record.type === "AAAA") {
    if (typeof record.data !== "string") throw new TypeError("DNS AAAA data must be a string")
    return encodeIPv6(record.data)
  }
  if (record.type === "PTR") {
    if (typeof record.data !== "string") throw new TypeError("DNS PTR data must be a name")
    encodeName(output, record.data)
    return new Uint8Array(output)
  }
  if (record.type === "SRV") {
    if (!isSRVData(record.data)) throw new TypeError("DNS SRV data must be an object")
    writeU16(output, record.data.priority)
    writeU16(output, record.data.weight)
    writeU16(output, record.data.port)
    encodeName(output, record.data.target)
    return new Uint8Array(output)
  }
  if (!Array.isArray(record.data)) throw new TypeError("DNS TXT data must be an array")
  for (const item of record.data) {
    if (!(item instanceof Uint8Array)) throw new TypeError("DNS TXT item must be Uint8Array")
    if (item.byteLength > 255) throw new RangeError("DNS TXT item exceeds 255 bytes")
    output.push(item.byteLength)
    for (const byte of item) output.push(byte)
  }
  return new Uint8Array(output)
}

/** Appends one supported resource record to an encoded message. */
function encodeRecord(output: number[], record: DNSRecord): void {
  encodeName(output, record.name)
  writeU16(output, typeCodes[record.type])
  writeU16(output, 1 | (record.flush ? 0x8000 : 0))
  writeU32(output, record.ttl)
  const rdata = encodeRecordData(record)
  writeU16(output, rdata.byteLength)
  for (const byte of rdata) output.push(byte)
}

/** Decodes one supported resource-record payload from its exact wire slice. */
function decodeRecordData(
  data: Uint8Array,
  type: DNSRecordType,
  start: number,
  length: number
): DNSRecord["data"] {
  const end = start + length
  if (end > data.byteLength) throw new TypeError("DNS rdata is truncated")
  if (type === "A") {
    if (length !== 4) throw new TypeError("DNS A rdata length is invalid")
    return Array.from(data.slice(start, end)).join(".")
  }
  if (type === "AAAA") return decodeIPv6(data.slice(start, end))
  const cursor: Cursor = { offset: start }
  if (type === "PTR") {
    const name = decodeName(data, cursor)
    if (cursor.offset !== end) throw new TypeError("DNS PTR rdata length is invalid")
    return name
  }
  if (type === "SRV") {
    if (length < 7) throw new TypeError("DNS SRV rdata is truncated")
    const priority = readU16(data, cursor)
    const weight = readU16(data, cursor)
    const port = readU16(data, cursor)
    const target = decodeName(data, cursor)
    if (cursor.offset !== end) throw new TypeError("DNS SRV rdata length is invalid")
    return Object.freeze({ priority, weight, port, target })
  }
  const items: Uint8Array[] = []
  while (cursor.offset < end) {
    const itemLength = readByte(data, cursor)
    if (cursor.offset + itemLength > end) throw new TypeError("DNS TXT item is truncated")
    items.push(data.slice(cursor.offset, cursor.offset + itemLength))
    cursor.offset += itemLength
  }
  return Object.freeze(items)
}

/** Decodes one supported resource record and skips extensible unknown RRs. */
function decodeRecord(data: Uint8Array, cursor: Cursor): DNSRecord | null {
  const name = decodeName(data, cursor)
  const type = recordType(readU16(data, cursor))
  const classValue = readU16(data, cursor)
  const ttlValue = readU32(data, cursor)
  const ttl = ttlValue >= 2_147_483_648 ? 0 : ttlValue
  const length = readU16(data, cursor)
  const start = cursor.offset
  if (start + length > data.byteLength) throw new TypeError("DNS rdata is truncated")
  if (type === null) {
    cursor.offset = start + length
    return null
  }
  if ((classValue & 0x7fff) !== 1) throw new TypeError("DNS record class is unsupported")
  const record = Object.freeze({
    name,
    type,
    ttl,
    flush: (classValue & 0x8000) !== 0,
    data: decodeRecordData(data, type, start, length)
  })
  cursor.offset = start + length
  return record
}

/** Validates and normalizes one fully-qualified DNS name. */
export function validateDNSName(labels: readonly string[]): string {
  if (!Array.isArray(labels) || labels.length === 0)
    throw new TypeError("DNS name labels must be non-empty")
  const normalized: string[] = []
  let wireBytes = 1
  const encoder = new TextEncoder()
  for (const labelValue of labels) {
    if (
      typeof labelValue !== "string" ||
      labelValue.length === 0 ||
      !/^[A-Za-z0-9_-]+$/.test(labelValue)
    ) {
      throw new TypeError(
        "DNS label must contain only ASCII letters, digits, hyphen, or underscore"
      )
    }
    const label = labelValue.toLowerCase()
    const bytes = encoder.encode(label)
    if (bytes.byteLength > 63) throw new RangeError("DNS label exceeds 63 bytes")
    wireBytes += bytes.byteLength + 1
    normalized.push(label)
  }
  if (wireBytes > 255) throw new RangeError("encoded DNS name exceeds 255 bytes")
  return `${normalized.join(".")}.`
}

/** Encodes one supported DNS message under an explicit packet ceiling. */
export function encodeDNSPacket(packet: DNSPacket, maximumBytes: number): Uint8Array {
  const maximum = packetLimit(maximumBytes)
  if (typeof packet !== "object" || packet === null)
    throw new TypeError("DNS packet must be an object")
  const output: number[] = []
  writeU16(output, packet.id)
  writeU16(output, packet.response ? 0x8400 : 0)
  writeU16(output, packet.questions.length)
  writeU16(output, packet.answers.length)
  writeU16(output, packet.authorities.length)
  writeU16(output, packet.additionals.length)
  for (const question of packet.questions) {
    encodeName(output, question.name)
    writeU16(output, question.type === "ANY" ? 255 : typeCodes[question.type])
    writeU16(output, 1)
  }
  for (const record of packet.answers) encodeRecord(output, record)
  for (const record of packet.authorities) encodeRecord(output, record)
  for (const record of packet.additionals) encodeRecord(output, record)
  if (output.length > maximum)
    throw new RangeError(`DNS packet exceeds configured ${maximum}-byte ceiling`)
  return new Uint8Array(output)
}

/** Decodes one supported DNS message under an explicit packet ceiling. */
export function decodeDNSPacket(data: Uint8Array, maximumBytes: number): DNSPacket {
  const maximum = packetLimit(maximumBytes)
  if (!(data instanceof Uint8Array)) throw new TypeError("DNS packet input must be Uint8Array")
  if (data.byteLength > maximum)
    throw new RangeError(`DNS packet exceeds configured ${maximum}-byte ceiling`)
  if (data.byteLength < 12) throw new TypeError("DNS packet header is truncated")
  const cursor: Cursor = { offset: 0 }
  const id = readU16(data, cursor)
  const flags = readU16(data, cursor)
  if ((flags & 0x7800) !== 0 || (flags & 0x000f) !== 0)
    throw new TypeError("DNS packet opcode or response code is unsupported")
  const questionCount = readU16(data, cursor)
  const answerCount = readU16(data, cursor)
  const authorityCount = readU16(data, cursor)
  const additionalCount = readU16(data, cursor)
  const questions: DNSQuestion[] = []
  for (let index = 0; index < questionCount; index += 1) {
    const name = decodeName(data, cursor)
    const typeCode = readU16(data, cursor)
    const type = typeCode === 255 ? "ANY" : recordType(typeCode)
    if (type === null) throw new TypeError(`DNS record type ${typeCode} is unsupported`)
    const classValue = readU16(data, cursor)
    if ((classValue & 0x7fff) !== 1) throw new TypeError("DNS question class is unsupported")
    questions.push(Object.freeze({ name, type }))
  }
  /** Reads an exact resource-record section. */
  function section(count: number): readonly DNSRecord[] {
    const records: DNSRecord[] = []
    for (let index = 0; index < count; index += 1) {
      const record = decodeRecord(data, cursor)
      if (record !== null) records.push(record)
    }
    return Object.freeze(records)
  }
  const answers = section(answerCount)
  const authorities = section(authorityCount)
  const additionals = section(additionalCount)
  if (cursor.offset !== data.byteLength) throw new TypeError("DNS packet has trailing bytes")
  return Object.freeze({
    id,
    response: (flags & 0x8000) !== 0,
    questions: Object.freeze(questions),
    answers,
    authorities,
    additionals
  })
}
