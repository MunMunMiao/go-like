import type { Message } from "./types"

interface MessageCandidate {
  readonly header?: unknown
  readonly body?: unknown
}

/** Narrows an unknown Message boundary to an inspectable non-array object. */
function isMessageCandidate(value: unknown): value is MessageCandidate {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Copies and freezes a string-only header record without retaining its prototype. */
function snapshotHeader(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("message header must be a string record")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("message header must be a plain string record")
  }
  const entries: readonly [string, unknown][] = Object.entries(value)
  const copied: [string, string][] = []
  for (const entry of entries) {
    if (typeof entry[1] !== "string") {
      throw new TypeError("message header values must be strings")
    }
    copied.push([entry[0], entry[1]])
  }
  return Object.freeze(Object.fromEntries(copied))
}

/** Copies one Message at an implementation boundary and never exposes its retained body bytes. */
export function snapshotMessage(message: Message): Message {
  const candidate: unknown = message
  if (!isMessageCandidate(candidate)) throw new TypeError("message must be an object")
  const header = snapshotHeader(candidate.header)
  if (!(candidate.body instanceof Uint8Array)) {
    throw new TypeError("message body must be a Uint8Array")
  }
  const body = new Uint8Array(candidate.body)
  const snapshot: Message = {
    header,
    /** Returns a detached body for every read. */
    get body(): Uint8Array {
      return new Uint8Array(body)
    }
  }
  return Object.freeze(snapshot)
}
