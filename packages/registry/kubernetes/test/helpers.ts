import type { KubernetesFetch } from "../src/index"

interface WatchState {
  readonly startRevision: number
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly signal: AbortSignal
  readonly aborted: () => void
  closed: boolean
}

interface WatchHistory {
  readonly revision: number
  readonly type: "ADDED" | "MODIFIED" | "DELETED"
  readonly value: object
}

/** Simulates the exact EndpointSlice HTTP surface used by deterministic unit tests. */
export interface FakeKubernetes {
  readonly fetch: KubernetesFetch
  readonly requests: readonly Request[]
  /** Makes the next matching HTTP method return one status without mutation. */
  failNext(method: string, status: number): void
  /** Makes the next watch admission return HTTP 410 Gone. */
  staleNextWatch(): void
  /** Sends one exact JSON frame to all active watches. */
  sendWatchFrame(value: object): void
  /** Sends exact raw bytes to all active watches. */
  sendWatchBytes(value: Uint8Array): void
  /** Closes every current watch stream at clean EOF. */
  closeWatches(): void
  /** Inserts or replaces one foreign EndpointSlice. */
  putForeign(name: string): void
  /** Replaces one exact stored object for fail-closed decode tests. */
  replace(name: string, value: object): void
  /** Returns one exact stored object snapshot. */
  object(name: string): object | null
  /** Returns all exact stored names in code-point order. */
  names(): readonly string[]
}

/** Reads one own JSON property. */
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one unknown JSON value to a non-array object. */
function object(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  return value
}

/** Clones one JSON-compatible carrier without retaining caller references. */
function clone(value: object): object {
  return object(JSON.parse(JSON.stringify(value)), "fake Kubernetes clone failed")
}

/** Returns one JSON response. */
function response(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

/** Returns one Kubernetes Status response. */
function status(code: number): Response {
  return response(
    { apiVersion: "v1", kind: "Status", status: "Failure", reason: "Injected", code },
    code
  )
}

/** Captures one Request body as an object. */
async function body(request: Request): Promise<object> {
  return object(await request.json(), "fake Kubernetes request body is invalid")
}

/** Creates one deterministic in-memory EndpointSlice API. */
export function fakeKubernetes(namespace = "go-like-test"): FakeKubernetes {
  const objects = new Map<string, object>()
  const requests: Request[] = []
  const watchers = new Set<WatchState>()
  const history: WatchHistory[] = []
  const failures = new Map<string, number>()
  const encoder = new TextEncoder()
  let revision = 1
  let stale = false

  /** Reads one object's required metadata carrier. */
  function metadata(value: object): object {
    return object(property(value, "metadata"), "fake Kubernetes metadata is invalid")
  }

  /** Returns one object's exact name. */
  function name(value: object): string {
    const result = property(metadata(value), "name")
    if (typeof result !== "string" || result.length === 0) {
      throw new Error("fake Kubernetes object omitted name")
    }
    return result
  }

  /** Returns one object's exact resourceVersion. */
  function resourceVersion(value: object): string {
    const result = property(metadata(value), "resourceVersion")
    if (typeof result !== "string") {
      throw new Error("fake Kubernetes object omitted resourceVersion")
    }
    return result
  }

  /** Assigns namespace and a new server resourceVersion. */
  function committed(value: object): object {
    revision += 1
    const result = clone(value)
    const meta = metadata(result)
    Object.defineProperty(meta, "namespace", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: namespace
    })
    Object.defineProperty(meta, "resourceVersion", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: String(revision)
    })
    return result
  }

  /** Closes and removes one watch once. */
  function closeWatch(watch: WatchState): void {
    if (watch.closed) return
    watch.closed = true
    watchers.delete(watch)
    watch.signal.removeEventListener("abort", watch.aborted)
    try {
      watch.controller.close()
    } catch {
      // The consumer may already have canceled the stream.
    }
  }

  /** Publishes one mutation to every watch whose cursor precedes it. */
  function notify(type: WatchHistory["type"], value: object): void {
    history.push({ revision, type, value: clone(value) })
    for (const watch of Array.from(watchers)) {
      if (watch.closed || watch.startRevision >= revision) continue
      try {
        watch.controller.enqueue(encoder.encode(`${JSON.stringify({ type, object: value })}\n`))
      } catch {
        closeWatch(watch)
      }
    }
  }

  /** Serves one namespaced EndpointSlice watch response. */
  function watched(request: Request): Response {
    if (stale) {
      stale = false
      return status(410)
    }
    const url = new URL(request.url)
    const startRevision = Number(url.searchParams.get("resourceVersion") ?? "0")
    let state: WatchState
    const stream = new ReadableStream<Uint8Array>({
      /** Captures the consumer and links request abort. */
      start(controller): void {
        /** Closes this exact watch after request cancellation. */
        function aborted(): void {
          closeWatch(state)
        }
        state = {
          startRevision,
          controller,
          signal: request.signal,
          aborted,
          closed: false
        }
        watchers.add(state)
        request.signal.addEventListener("abort", aborted, { once: true })
        if (request.signal.aborted) aborted()
        for (const event of history) {
          if (event.revision > startRevision && !state.closed) {
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ type: event.type, object: event.value })}\n`)
            )
          }
        }
      },
      /** Removes this watch after reader cancellation. */
      cancel(): void {
        closeWatch(state)
      }
    })
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/json;stream=watch" }
    })
  }

  const api: FakeKubernetes = {
    requests,
    /** Handles only the namespaced discovery.k8s.io/v1 EndpointSlice surface. */
    async fetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      const injected = failures.get(request.method)
      if (injected !== undefined) {
        failures.delete(request.method)
        return status(injected)
      }
      const url = new URL(request.url)
      const collection = `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices`
      if (!url.pathname.startsWith(collection)) return status(404)
      const suffix = url.pathname.slice(collection.length)
      if (request.method === "GET" && suffix === "" && url.searchParams.get("watch") === "true") {
        return watched(request)
      }
      if (request.method === "GET" && suffix === "") {
        const items: object[] = []
        for (const value of objects.values()) {
          const labels = property(metadata(value), "labels")
          const managed =
            typeof labels === "object" &&
            labels !== null &&
            !Array.isArray(labels) &&
            property(labels, "endpointslice.kubernetes.io/managed-by") ===
              "registry-kubernetes.go-like.dev"
          if (managed) items.push(clone(value))
        }
        return response({
          apiVersion: "discovery.k8s.io/v1",
          kind: "EndpointSliceList",
          metadata: { resourceVersion: String(revision) },
          items
        })
      }
      const exactName = suffix.startsWith("/") ? decodeURIComponent(suffix.slice(1)) : ""
      if (request.method === "GET") {
        const found = objects.get(exactName)
        return found === undefined ? status(404) : response(clone(found))
      }
      if (request.method === "POST" && suffix === "") {
        const submitted = await body(request)
        const objectName = name(submitted)
        if (objects.has(objectName)) return status(409)
        const stored = committed(submitted)
        objects.set(objectName, stored)
        notify("ADDED", stored)
        return response(clone(stored), 201)
      }
      if (request.method === "PUT") {
        const submitted = await body(request)
        const found = objects.get(exactName)
        if (found === undefined) return status(404)
        if (resourceVersion(submitted) !== resourceVersion(found)) return status(409)
        const stored = committed(submitted)
        objects.set(exactName, stored)
        notify("MODIFIED", stored)
        return response(clone(stored))
      }
      if (request.method === "DELETE") {
        const found = objects.get(exactName)
        if (found === undefined) return status(404)
        const options = await body(request)
        const preconditions = object(
          property(options, "preconditions"),
          "fake Kubernetes delete preconditions are invalid"
        )
        if (property(preconditions, "resourceVersion") !== resourceVersion(found)) {
          return status(409)
        }
        revision += 1
        const deleted = clone(found)
        Object.defineProperty(metadata(deleted), "resourceVersion", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: String(revision)
        })
        objects.delete(exactName)
        notify("DELETED", deleted)
        return response({ apiVersion: "v1", kind: "Status", status: "Success", code: 200 })
      }
      return status(405)
    },
    failNext(method, statusCode): void {
      failures.set(method.toUpperCase(), statusCode)
    },
    staleNextWatch(): void {
      stale = true
    },
    sendWatchFrame(value): void {
      for (const watch of Array.from(watchers)) {
        if (!watch.closed) {
          watch.controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
        }
      }
    },
    sendWatchBytes(value): void {
      for (const watch of Array.from(watchers)) {
        if (!watch.closed) watch.controller.enqueue(value)
      }
    },
    closeWatches(): void {
      for (const watch of Array.from(watchers)) closeWatch(watch)
    },
    putForeign(name): void {
      revision += 1
      objects.set(name, {
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSlice",
        metadata: {
          name,
          namespace,
          resourceVersion: String(revision),
          labels: { "kubernetes.io/service-name": "foreign" }
        },
        addressType: "FQDN",
        endpoints: [{ addresses: ["foreign.invalid"] }],
        ports: [{ port: 1 }]
      })
    },
    replace(name, value): void {
      objects.set(name, clone(value))
    },
    object(name): object | null {
      const found = objects.get(name)
      return found === undefined ? null : clone(found)
    },
    names(): readonly string[] {
      return Object.freeze(Array.from(objects.keys()).sort())
    }
  }
  return api
}
