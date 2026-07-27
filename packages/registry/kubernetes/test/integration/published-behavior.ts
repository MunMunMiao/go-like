import { background, withTimeout } from "@likego/context"
import type { ServiceInstance, Watcher } from "@likego/registry"
import { newKubernetesRegistry, type KubernetesFetch } from "@likego/registry-kubernetes"

interface WatchState {
  readonly revision: number
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly signal: AbortSignal
  readonly aborted: () => void
  closed: boolean
}

/** Fails one portable published behavior assertion. */
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

/** Reads one own JSON property. */
function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrows one JSON carrier to an object. */
function object(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message)
  return value
}

/** Clones one JSON-compatible carrier. */
function clone(value: object): object {
  return object(JSON.parse(JSON.stringify(value)), "published Kubernetes clone failed")
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
  return response({ apiVersion: "v1", kind: "Status", status: "Failure", code }, code)
}

/** Captures one Request JSON body. */
async function body(request: Request): Promise<object> {
  return object(await request.json(), "published Kubernetes request body is invalid")
}

/** Creates a portable EndpointSlice API subset for published runtime verification. */
function publishedApi(namespace: string): KubernetesFetch {
  const values = new Map<string, object>()
  const watchers = new Set<WatchState>()
  const encoder = new TextEncoder()
  let revision = 1

  /** Reads one object's metadata. */
  function metadata(value: object): object {
    return object(property(value, "metadata"), "published Kubernetes metadata is invalid")
  }

  /** Reads one object's required metadata string. */
  function metadataString(value: object, key: string): string {
    const result = property(metadata(value), key)
    if (typeof result !== "string" || result.length === 0) {
      throw new Error(`published Kubernetes metadata ${key} is invalid`)
    }
    return result
  }

  /** Assigns server-owned namespace and resourceVersion. */
  function commit(value: object): object {
    revision += 1
    const result = clone(value)
    const meta = metadata(result)
    Reflect.set(meta, "namespace", namespace)
    Reflect.set(meta, "resourceVersion", String(revision))
    return result
  }

  /** Closes one resident fake watch. */
  function closeWatch(watch: WatchState): void {
    if (watch.closed) return
    watch.closed = true
    watchers.delete(watch)
    watch.signal.removeEventListener("abort", watch.aborted)
    try {
      watch.controller.close()
    } catch {
      // The public provider may already have canceled the reader.
    }
  }

  /** Publishes one exact watch event. */
  function notify(type: "ADDED" | "MODIFIED" | "DELETED", value: object): void {
    const frame = encoder.encode(`${JSON.stringify({ type, object: value })}\n`)
    for (const watch of Array.from(watchers)) {
      if (!watch.closed && watch.revision < revision) watch.controller.enqueue(frame)
    }
  }

  /** Opens one standard streaming Response. */
  function watched(request: Request): Response {
    const cursor = Number(new URL(request.url).searchParams.get("resourceVersion") ?? "0")
    let state: WatchState
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        function aborted(): void {
          closeWatch(state)
        }
        state = {
          revision: cursor,
          controller,
          signal: request.signal,
          aborted,
          closed: false
        }
        watchers.add(state)
        request.signal.addEventListener("abort", aborted, { once: true })
        if (request.signal.aborted) aborted()
      },
      cancel(): void {
        closeWatch(state)
      }
    })
    return new Response(stream)
  }

  return async function fetchCapability(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const collection = `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices`
    if (!url.pathname.startsWith(collection)) return status(404)
    const suffix = url.pathname.slice(collection.length)
    if (request.method === "GET" && suffix === "" && url.searchParams.get("watch") === "true") {
      return watched(request)
    }
    if (request.method === "GET" && suffix === "") {
      return response({
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSliceList",
        metadata: { resourceVersion: String(revision) },
        items: Array.from(values.values()).map(clone)
      })
    }
    const name = suffix.startsWith("/") ? decodeURIComponent(suffix.slice(1)) : ""
    if (request.method === "GET") {
      const found = values.get(name)
      return found === undefined ? status(404) : response(clone(found))
    }
    if (request.method === "POST") {
      const submitted = await body(request)
      const objectName = metadataString(submitted, "name")
      if (values.has(objectName)) return status(409)
      const stored = commit(submitted)
      values.set(objectName, stored)
      notify("ADDED", stored)
      return response(clone(stored), 201)
    }
    if (request.method === "PUT") {
      const submitted = await body(request)
      const found = values.get(name)
      if (found === undefined) return status(404)
      if (
        metadataString(submitted, "resourceVersion") !== metadataString(found, "resourceVersion")
      ) {
        return status(409)
      }
      const stored = commit(submitted)
      values.set(name, stored)
      notify("MODIFIED", stored)
      return response(clone(stored))
    }
    if (request.method === "DELETE") {
      const found = values.get(name)
      if (found === undefined) return status(404)
      const options = await body(request)
      const preconditions = object(
        property(options, "preconditions"),
        "published Kubernetes delete preconditions are invalid"
      )
      if (property(preconditions, "resourceVersion") !== metadataString(found, "resourceVersion")) {
        return status(409)
      }
      revision += 1
      values.delete(name)
      const deleted = clone(found)
      Reflect.set(metadata(deleted), "resourceVersion", String(revision))
      notify("DELETED", deleted)
      return response({ apiVersion: "v1", kind: "Status", status: "Success", code: 200 })
    }
    return status(405)
  }
}

/** Waits for one watcher snapshot under a portable deadline. */
async function nextSnapshot(watcher: Watcher): Promise<readonly ServiceInstance[]> {
  const timed = withTimeout(background(), 3_000)
  try {
    return await watcher.next(timed[0])
  } finally {
    timed[1]()
  }
}

/** Verifies the installed package through public imports only. */
export async function runKubernetesPublishedBehavior(): Promise<void> {
  const namespace = "likego-published"
  const registry = newKubernetesRegistry({
    fetch: publishedApi(namespace),
    address: "https://kubernetes.example",
    namespace,
    owner: { name: "published-pod", uid: "published-pod-uid" },
    retryInitialMs: 1,
    retryMaximumMs: 4,
    watchTimeoutSeconds: 5
  })
  const initial: ServiceInstance = {
    id: "orders-1",
    name: "orders",
    version: "v1",
    metadata: { revision: "initial" },
    endpoints: ["https://orders.example/"]
  }
  const updated: ServiceInstance = {
    id: initial.id,
    name: initial.name,
    version: initial.version,
    metadata: { revision: "updated" },
    endpoints: ["https://orders.example/v2"]
  }
  const watcher = await registry.watch(background(), initial.name)
  requireValue(
    (await registry.register(background(), initial)) === undefined,
    "register returned data"
  )
  requireValue(
    JSON.stringify(await nextSnapshot(watcher)) === JSON.stringify([initial]),
    "watch omitted initial registration"
  )
  await registry.register(background(), updated)
  requireValue(
    JSON.stringify(await nextSnapshot(watcher)) === JSON.stringify([updated]),
    "watch omitted replacement"
  )
  requireValue(
    JSON.stringify(await registry.getService(background(), initial.name)) ===
      JSON.stringify([updated]),
    "getService omitted replacement"
  )
  await registry.deregister(background(), updated)
  requireValue((await nextSnapshot(watcher)).length === 0, "watch omitted deregistration")
  await watcher.stop(background())
  requireValue(!("capabilities" in registry), "legacy capabilities method remained public")

  console.log(
    `LIKEGO_REGISTRY_KUBERNETES_PUBLISHED_RUNTIME=${JSON.stringify({
      valid: true,
      contract: "ServiceInstance register/deregister replacement watcher",
      status: "passed"
    })}`
  )
}

await runKubernetesPublishedBehavior()
