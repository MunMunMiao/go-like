import { decodeBytes, encodeBytes } from "../src/codec"
import type { EtcdFetch } from "../src/index"

interface Entry {
  readonly key: string
  readonly value: string
  readonly lease: string
  readonly createRevision: bigint
  readonly modRevision: bigint
}

interface WatchState {
  readonly key: string
  readonly rangeEnd: string
  readonly startRevision: bigint
  readonly request: Request
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
}

interface Mutation {
  readonly type: "PUT" | "DELETE"
  readonly entry: Entry
}

/** Simulates only the etcd v3 JSON-gateway facts used by provider tests. */
export interface FakeEtcd {
  readonly fetch: EtcdFetch
  readonly requests: readonly Request[]
  /** Causes the next applied transaction response to be lost. */
  loseNextTxnResponse(): void
  /** Makes one future keepalive return an availability status. */
  failKeepAlive(call: number, status: number): void
  /** Makes the next exact gateway path return one status before mutation. */
  failNext(path: string, status: number): void
  /** Makes one exact future call number for a gateway path fail before mutation. */
  failPathCall(path: string, call: number, status: number): void
  /** Expires every lease and removes all attached keys. */
  expireLeases(): void
  /** Makes the next revisioned watch start report compaction. */
  compactNextWatch(): void
  /** Closes every current watch stream as an availability interruption. */
  closeWatches(): void
  /** Commits one raw lease-backed key for corruption tests. */
  putRaw(key: string, value: string): void
  /** Returns exact managed keys in byte order. */
  keys(): readonly string[]
  /** Returns one exact stored record or null. */
  entry(key: string): Readonly<Entry> | null
}

/** Reads one own JSON carrier property. */
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one fake gateway request value to an object. */
function object(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  return value
}

/** Parses one fake gateway decimal int64 field. */
function integer(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) {
    throw new Error(`fake etcd ${name} is invalid`)
  }
  return BigInt(value)
}

/** Parses one request JSON object. */
async function requestBody(request: Request): Promise<object> {
  return object(await request.json(), "fake etcd request body is invalid")
}

/** Creates one deterministic in-memory etcd v3 JSON gateway. */
export function fakeEtcd(): FakeEtcd {
  const entries = new Map<string, Entry>()
  const leases = new Map<string, Set<string>>()
  const watches = new Set<WatchState>()
  const requests: Request[] = []
  const encoder = new TextEncoder()
  let revision = 1n
  let nextLease = 100n
  let loseTxn = false
  let keepAliveCalls = 0
  const failedKeepAliveCalls = new Map<number, number>()
  const failedPaths = new Map<string, number[]>()
  const pathCalls = new Map<string, number>()
  const failedPathCalls = new Map<string, Map<number, number>>()
  let compactWatch = false

  /** Returns one standard etcd response header. */
  function header(): object {
    return { cluster_id: "1", member_id: "1", revision: String(revision), raft_term: "1" }
  }

  /** Encodes one stored KV in gateway JSON shape. */
  function carrier(entry: Entry): object {
    return {
      key: encodeBytes(entry.key),
      create_revision: String(entry.createRevision),
      mod_revision: String(entry.modRevision),
      version: "1",
      value: encodeBytes(entry.value),
      lease: entry.lease
    }
  }

  /** Writes one newline-delimited watch frame when the consumer remains open. */
  function frame(watch: WatchState, result: object): void {
    if (!watch.closed) watch.controller.enqueue(encoder.encode(`${JSON.stringify({ result })}\n`))
  }

  /** Publishes one committed mutation to matching watches. */
  function notify(mutation: Mutation): void {
    for (const watch of watches) {
      if (
        mutation.entry.modRevision < watch.startRevision ||
        mutation.entry.key < watch.key ||
        mutation.entry.key >= watch.rangeEnd
      ) {
        continue
      }
      frame(watch, {
        header: header(),
        events: [{ type: mutation.type, kv: carrier(mutation.entry) }]
      })
    }
  }

  /** Commits one exact put at the current transaction revision. */
  function put(key: string, value: string, lease: string): Mutation {
    const prior = entries.get(key)
    const entry: Entry = {
      key,
      value,
      lease,
      createRevision: prior?.createRevision ?? revision,
      modRevision: revision
    }
    entries.set(key, entry)
    if (prior !== undefined) leases.get(prior.lease)?.delete(key)
    let keys = leases.get(lease)
    if (keys === undefined) {
      keys = new Set<string>()
      leases.set(lease, keys)
    }
    keys.add(key)
    return { type: "PUT", entry }
  }

  /** Commits one exact delete at the current transaction revision. */
  function remove(key: string): Mutation | null {
    const prior = entries.get(key)
    if (prior === undefined) return null
    entries.delete(key)
    leases.get(prior.lease)?.delete(key)
    const deleted: Entry = {
      key: prior.key,
      value: prior.value,
      lease: prior.lease,
      createRevision: prior.createRevision,
      modRevision: revision
    }
    return { type: "DELETE", entry: deleted }
  }

  /** Selects exact or ranged records in byte-key order. */
  function selected(key: string, rangeEnd: string | null): readonly Entry[] {
    const result: Entry[] = []
    for (const entry of entries.values()) {
      if (rangeEnd === null ? entry.key === key : entry.key >= key && entry.key < rangeEnd) {
        result.push(entry)
      }
    }
    result.sort((left, right) => Number(left.key > right.key) - Number(left.key < right.key))
    return result
  }

  /** Returns one gateway range response. */
  function ranged(request: object): object {
    const keyValue = property(request, "key")
    const rangeValue = property(request, "range_end")
    if (typeof keyValue !== "string") throw new Error("fake etcd range key is invalid")
    const key = decodeBytes(keyValue)
    const rangeEnd = typeof rangeValue === "string" ? decodeBytes(rangeValue) : null
    const found = selected(key, rangeEnd)
    return {
      header: header(),
      kvs: found.map(carrier),
      count: String(found.length)
    }
  }

  /** Evaluates one etcd transaction compare. */
  function compared(value: unknown): boolean {
    const compare = object(value, "fake etcd compare is invalid")
    const encodedKey = property(compare, "key")
    if (typeof encodedKey !== "string") throw new Error("fake etcd compare key is invalid")
    const key = decodeBytes(encodedKey)
    const entry = entries.get(key)
    const target = property(compare, "target")
    if (target === "CREATE") {
      return String(entry?.createRevision ?? 0n) === property(compare, "create_revision")
    }
    if (target === "VALUE") {
      const valueText = property(compare, "value")
      return typeof valueText === "string" && entry?.value === decodeBytes(valueText)
    }
    throw new Error("fake etcd compare target is unsupported")
  }

  /** Executes one transaction operation at the selected revision. */
  function transactionOperation(value: unknown, mutations: Mutation[]): object {
    const operation = object(value, "fake etcd transaction operation is invalid")
    const putValue = property(operation, "request_put")
    if (putValue !== undefined) {
      const request = object(putValue, "fake etcd put request is invalid")
      const key = property(request, "key")
      const encodedValue = property(request, "value")
      const lease = property(request, "lease")
      if (
        typeof key !== "string" ||
        typeof encodedValue !== "string" ||
        typeof lease !== "string"
      ) {
        throw new Error("fake etcd put fields are invalid")
      }
      mutations.push(put(decodeBytes(key), decodeBytes(encodedValue), lease))
      return { response_put: { header: header() } }
    }
    const deleteValue = property(operation, "request_delete_range")
    if (deleteValue !== undefined) {
      const request = object(deleteValue, "fake etcd delete request is invalid")
      const key = property(request, "key")
      if (typeof key !== "string") throw new Error("fake etcd delete key is invalid")
      const mutation = remove(decodeBytes(key))
      if (mutation !== null) mutations.push(mutation)
      return { response_delete_range: { header: header(), deleted: mutation === null ? "0" : "1" } }
    }
    const rangeValue = property(operation, "request_range")
    if (rangeValue !== undefined) {
      return { response_range: ranged(object(rangeValue, "fake etcd txn range is invalid")) }
    }
    throw new Error("fake etcd transaction operation is unsupported")
  }

  /** Executes one complete atomic transaction. */
  function transaction(request: object): object {
    const rawCompare = property(request, "compare")
    const rawSuccess = property(request, "success")
    const rawFailure = property(request, "failure")
    if (!Array.isArray(rawCompare) || !Array.isArray(rawSuccess) || !Array.isArray(rawFailure)) {
      throw new Error("fake etcd transaction arrays are invalid")
    }
    const succeeded = rawCompare.every(compared)
    const operations = succeeded ? rawSuccess : rawFailure
    const writes =
      succeeded &&
      operations.some(function writes(value): boolean {
        const operation = object(value, "fake etcd transaction operation is invalid")
        return (
          property(operation, "request_put") !== undefined ||
          property(operation, "request_delete_range") !== undefined
        )
      })
    if (writes) revision += 1n
    const mutations: Mutation[] = []
    const responses = operations.map(function execute(value): object {
      return transactionOperation(value, mutations)
    })
    for (const mutation of mutations) notify(mutation)
    return { header: header(), succeeded, responses }
  }

  /** Removes every key attached to one lease in one revision. */
  function revoke(id: string): void {
    const keys = leases.get(id)
    leases.delete(id)
    if (keys === undefined || keys.size === 0) return
    revision += 1n
    const mutations: Mutation[] = []
    for (const key of keys) {
      const mutation = remove(key)
      if (mutation !== null) mutations.push(mutation)
    }
    for (const mutation of mutations) notify(mutation)
  }

  /** Closes one exact watch and releases its abort listener. */
  function closeWatch(watch: WatchState): void {
    if (watch.closed) return
    watch.closed = true
    watches.delete(watch)
    try {
      watch.controller.close()
    } catch {
      // The consumer may already have canceled this exact stream.
    }
  }

  const backend: FakeEtcd = {
    requests,
    async fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request.clone())
      const path = new URL(request.url).pathname
      const pathCall = (pathCalls.get(path) ?? 0) + 1
      pathCalls.set(path, pathCall)
      const scheduledStatus = failedPathCalls.get(path)?.get(pathCall)
      if (scheduledStatus !== undefined) return new Response(null, { status: scheduledStatus })
      const failures = failedPaths.get(path)
      const failedStatus = failures?.shift()
      if (failedStatus !== undefined) return new Response(null, { status: failedStatus })
      if (path === "/v3/lease/grant") {
        const body = await requestBody(request)
        const ttl = integer(property(body, "TTL"), "grant TTL")
        const id = String(nextLease++)
        leases.set(id, new Set<string>())
        return Response.json({ header: header(), ID: id, TTL: String(ttl) })
      }
      if (path === "/v3/lease/keepalive") {
        keepAliveCalls += 1
        const failed = failedKeepAliveCalls.get(keepAliveCalls)
        if (failed !== undefined) return new Response(null, { status: failed })
        const body = await requestBody(request)
        const id = property(body, "ID")
        if (typeof id !== "string") return new Response(null, { status: 400 })
        if (!leases.has(id)) return Response.json({ result: { header: header(), ID: id } })
        return Response.json({ result: { header: header(), ID: id, TTL: "5" } })
      }
      if (path === "/v3/lease/revoke") {
        const body = await requestBody(request)
        const id = property(body, "ID")
        if (typeof id !== "string") return new Response(null, { status: 400 })
        revoke(id)
        return Response.json({ header: header() })
      }
      if (path === "/v3/kv/range") {
        return Response.json(ranged(await requestBody(request)))
      }
      if (path === "/v3/kv/txn") {
        const response = transaction(await requestBody(request))
        if (loseTxn) {
          loseTxn = false
          throw new Error("injected lost txn response")
        }
        return Response.json(response)
      }
      if (path === "/v3/watch") {
        const body = await requestBody(request)
        const create = object(property(body, "create_request"), "fake etcd watch create is invalid")
        const keyValue = property(create, "key")
        const rangeValue = property(create, "range_end")
        const startValue = property(create, "start_revision")
        if (typeof keyValue !== "string" || typeof rangeValue !== "string") {
          return new Response(null, { status: 400 })
        }
        const key = decodeBytes(keyValue)
        const rangeEnd = decodeBytes(rangeValue)
        const startRevision = startValue === undefined ? 0n : integer(startValue, "watch revision")
        let watch: WatchState
        const bodyStream = new ReadableStream<Uint8Array>({
          /** Attaches one watch before publishing its creation frame. */
          start(controller): void {
            watch = { key, rangeEnd, startRevision, request, controller, closed: false }
            watches.add(watch)
            if (compactWatch && startRevision > 0n) {
              compactWatch = false
              frame(watch, {
                header: header(),
                canceled: true,
                compact_revision: String(revision)
              })
              return
            }
            frame(watch, { header: header(), created: true })
          },
          /** Releases one canceled body reader. */
          cancel(): void {
            closeWatch(watch)
          }
        })
        /** Closes this exact request after owner abort. */
        function aborted(): void {
          closeWatch(watch)
        }
        request.signal.addEventListener("abort", aborted, { once: true })
        if (request.signal.aborted) aborted()
        return new Response(bodyStream, { headers: { "Content-Type": "application/json" } })
      }
      return new Response(null, { status: 404 })
    },
    loseNextTxnResponse(): void {
      loseTxn = true
    },
    failKeepAlive(call: number, status: number): void {
      failedKeepAliveCalls.set(call, status)
    },
    failNext(path: string, status: number): void {
      let failures = failedPaths.get(path)
      if (failures === undefined) {
        failures = []
        failedPaths.set(path, failures)
      }
      failures.push(status)
    },
    failPathCall(path: string, call: number, status: number): void {
      let failures = failedPathCalls.get(path)
      if (failures === undefined) {
        failures = new Map<number, number>()
        failedPathCalls.set(path, failures)
      }
      failures.set(call, status)
    },
    expireLeases(): void {
      for (const id of Array.from(leases.keys())) revoke(id)
    },
    compactNextWatch(): void {
      compactWatch = true
      for (const watch of Array.from(watches)) closeWatch(watch)
    },
    closeWatches(): void {
      for (const watch of Array.from(watches)) closeWatch(watch)
    },
    putRaw(key: string, value: string): void {
      const id = String(nextLease++)
      leases.set(id, new Set<string>())
      revision += 1n
      notify(put(key, value, id))
    },
    keys(): readonly string[] {
      return Object.freeze(Array.from(entries.keys()).sort())
    },
    entry(key: string): Readonly<Entry> | null {
      const found = entries.get(key)
      return found === undefined ? null : Object.freeze(found)
    }
  }
  return Object.freeze(backend)
}

/** Waits until one eventually consistent predicate becomes true. */
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("condition did not converge")
}
