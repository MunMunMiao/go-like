import type { ConsulFetch } from "../src/index"

interface AgentRecord {
  readonly carrier: Record<string, unknown>
  status: "critical" | "passing"
}

interface BlockingQuery {
  readonly name: string
  readonly request: Request
  readonly resolve: (response: Response) => void
  readonly reject: (error: unknown) => void
  readonly aborted: () => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Simulates only the documented Consul HTTP facts used by deterministic state-machine tests. */
export interface FakeAgent {
  readonly fetch: ConsulFetch
  readonly requests: readonly Request[]
  readonly mutations: readonly string[]
  /** Causes the next applied registration response to be lost. */
  loseNextRegisterResponse(): void
  /** Causes the selected future heartbeat call to fail before mutation. */
  failHeartbeat(call: number, status: number): void
  /** Returns the exact remote IDs currently stored by the Agent. */
  remoteIds(): readonly string[]
  /** Returns one detached Agent service carrier. */
  service(remoteId: string): Readonly<Record<string, unknown>> | null
  /** Simulates an Agent restart that forgets every ephemeral service/check. */
  clearRecords(): void
}

/** Creates a deterministic in-memory Agent with real Request/Response and blocking-query behavior. */
export function fakeAgent(): FakeAgent {
  const records = new Map<string, AgentRecord>()
  const requests: Request[] = []
  const mutations: string[] = []
  const blocking = new Set<BlockingQuery>()
  let index = 1
  let loseRegister = false
  let heartbeatCalls = 0
  let failHeartbeatCall = -1
  let failHeartbeatStatus = 500

  /** Returns one JSON response with the current Consul index. */
  function json(value: unknown, status = 200): Response {
    return Response.json(value, { status, headers: { "X-Consul-Index": String(index) } })
  }

  /** Builds one passing health response for a service name. */
  function health(name: string): Response {
    const entries: unknown[] = []
    for (const record of records.values()) {
      if (record.status !== "passing" || record.carrier.Service !== name) continue
      entries.push({ Node: {}, Service: structuredClone(record.carrier), Checks: [] })
    }
    return json(entries)
  }

  /** Resolves every blocking query after a logical index change. */
  function changed(): void {
    index += 1
    for (const waiter of Array.from(blocking)) {
      blocking.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.request.signal.removeEventListener("abort", waiter.aborted)
      waiter.resolve(health(waiter.name))
    }
  }

  /** Converts an Agent registration request body into a health Service carrier. */
  function carrier(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("fake Agent registration body is invalid")
    }
    const body = value as Record<string, unknown>
    return {
      ID: body.ID,
      Service: body.Name,
      Address: body.Address,
      Port: body.Port,
      Tags: structuredClone(body.Tags),
      Meta: structuredClone(body.Meta)
    }
  }

  const agent: FakeAgent = {
    requests,
    mutations,
    async fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request.clone())
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/v1/agent/service/register") {
        const body: unknown = await request.json()
        const service = carrier(body)
        const remoteId = service.ID
        if (typeof remoteId !== "string") return new Response(null, { status: 400 })
        const check =
          typeof body === "object" && body !== null && !Array.isArray(body)
            ? (body as Record<string, unknown>).Check
            : null
        const status =
          typeof check === "object" &&
          check !== null &&
          !Array.isArray(check) &&
          (check as Record<string, unknown>).Status === "passing"
            ? "passing"
            : "critical"
        records.set(remoteId, { carrier: service, status })
        mutations.push(`register:${remoteId}`)
        changed()
        if (loseRegister) {
          loseRegister = false
          throw new Error("injected lost register response")
        }
        return new Response(null)
      }
      if (path.startsWith("/v1/agent/check/pass/")) {
        heartbeatCalls += 1
        if (heartbeatCalls === failHeartbeatCall)
          return new Response(null, { status: failHeartbeatStatus })
        const checkId = decodeURIComponent(path.slice("/v1/agent/check/pass/".length))
        const remoteId = checkId.startsWith("service:") ? checkId.slice("service:".length) : ""
        const found = records.get(remoteId)
        if (found === undefined) return new Response(null, { status: 404 })
        found.status = "passing"
        mutations.push(`pass:${remoteId}`)
        changed()
        return new Response(null)
      }
      if (path.startsWith("/v1/agent/service/deregister/")) {
        const remoteId = decodeURIComponent(path.slice("/v1/agent/service/deregister/".length))
        records.delete(remoteId)
        mutations.push(`deregister:${remoteId}`)
        changed()
        return new Response(null)
      }
      if (path.startsWith("/v1/agent/service/")) {
        const remoteId = decodeURIComponent(path.slice("/v1/agent/service/".length))
        const found = records.get(remoteId)
        return found === undefined ? new Response(null, { status: 404 }) : json(found.carrier)
      }
      if (path === "/v1/agent/checks") {
        const checks: Record<string, unknown> = {}
        for (const [remoteId, record] of records) {
          checks[`service:${remoteId}`] = { Status: record.status }
        }
        return json(checks)
      }
      if (path.startsWith("/v1/health/service/")) {
        const name = decodeURIComponent(path.slice("/v1/health/service/".length))
        const requested = url.searchParams.get("index")
        if (requested !== null && BigInt(requested) === BigInt(index)) {
          return new Promise<Response>(function wait(resolve, reject): void {
            let waiter: BlockingQuery
            /** Removes and rejects only this blocking query. */
            function aborted(): void {
              blocking.delete(waiter)
              clearTimeout(waiter.timer)
              reject(request.signal.reason)
            }
            const waitText = url.searchParams.get("wait") ?? "1000ms"
            const waitMs = Number(waitText.replace(/ms$/, ""))
            const timer = setTimeout(
              function elapsed(): void {
                blocking.delete(waiter)
                request.signal.removeEventListener("abort", aborted)
                resolve(health(name))
              },
              Number.isFinite(waitMs) ? waitMs : 1_000
            )
            waiter = { name, request, resolve, reject, aborted, timer }
            blocking.add(waiter)
            request.signal.addEventListener("abort", aborted, { once: true })
          })
        }
        return health(name)
      }
      return new Response(null, { status: 404 })
    },
    loseNextRegisterResponse(): void {
      loseRegister = true
    },
    failHeartbeat(call: number, status: number): void {
      failHeartbeatCall = call
      failHeartbeatStatus = status
    },
    remoteIds(): readonly string[] {
      return Object.freeze(Array.from(records.keys()).sort())
    },
    service(remoteId: string): Readonly<Record<string, unknown>> | null {
      const found = records.get(remoteId)
      return found === undefined ? null : Object.freeze(structuredClone(found.carrier))
    },
    clearRecords(): void {
      records.clear()
      changed()
    }
  }
  return Object.freeze(agent)
}

/** Waits until one eventually consistent test predicate becomes true. */
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
