import { background, withTimeout } from "@likego/context"
import type { ServiceInstance, Watcher } from "@likego/registry"
import { createServer } from "node:net"

import { managedByLabel, managedByValue } from "../../src/codec"
import { newKubernetesRegistry, type KubernetesFetch } from "../../src/index"

const Image =
  "rancher/k3s:v1.36.2-k3s1@sha256:6a47cea22c4b834d4ba72c89d291696b79ebe406251f90b446e4dff03513dd87"
const Namespace = "likego-registry-test"
const ServiceAccount = "likego-registry"
const Role = "likego-registry"
const OwnerPod = "likego-registry-owner"
const Verbs = ["get", "list", "watch", "create", "update", "delete"] as const
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`
const VolumeTargets = ["/var/lib/cni", "/var/lib/kubelet", "/var/lib/rancher/k3s", "/var/log"]

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

/** Creates one real-backend ServiceInstance revision. */
function fixture(revision: "initial" | "updated"): ServiceInstance {
  return {
    id: "orders-1",
    name: "docker-orders-订单",
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://10.42.0.10:8080/" : "http://10.42.0.10:8081/"]
  }
}

/** Fails the real integration gate unless one condition is true. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs one command and captures its terminal result. */
async function command(argv: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(Array.from(argv), { stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  return Object.freeze({
    code: await child.exited,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  })
}

/** Runs one Docker command to completion. */
async function docker(...args: readonly string[]): Promise<string> {
  const result = await command(["docker", ...args])
  if (result.code !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr}`)
  }
  return result.stdout
}

/** Runs kubectl inside the real K3s container. */
function kubectl(container: string, ...args: readonly string[]): Promise<string> {
  return docker("exec", container, "kubectl", ...args)
}

/** Reserves and releases one currently unused loopback TCP port. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("free port unavailable")
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

/** Waits until one real asynchronous condition converges. */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

/** Reads one JSON response as an object. */
async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("real Kubernetes response is not an object")
  }
  return value as Record<string, unknown>
}

/** Creates a real TLS-accepting Fetch borrowed by the provider. */
function realFetch(recorded: RecordedRequest[]): KubernetesFetch {
  return async function borrowed(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    recorded.push(
      Object.freeze({
        method: request.method,
        url: request.url,
        body: await request.clone().text()
      })
    )
    return fetch(request, { tls: { rejectUnauthorized: false } })
  }
}

/** Calls the real namespaced API with the ServiceAccount bearer token. */
function api(
  address: string,
  token: string,
  path: string,
  method = "GET",
  body: object | null = null
): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  })
  if (body !== null) headers.set("Content-Type", "application/json")
  return fetch(new URL(path, address), {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
    redirect: "error",
    tls: { rejectUnauthorized: false }
  })
}

/** Returns the sole namespaced EndpointSlice collection path. */
function collection(): string {
  return `/apis/discovery.k8s.io/v1/namespaces/${Namespace}/endpointslices`
}

/** Lists real LikeGo-managed EndpointSlices. */
async function managedSlices(address: string, token: string): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({
    labelSelector: `${managedByLabel}=${managedByValue}`
  })
  const response = await api(address, token, `${collection()}?${query}`)
  ensure(response.status === 200, `managed EndpointSlice list returned HTTP ${response.status}`)
  const payload = await json(response)
  const items = payload.items
  ensure(Array.isArray(items), "managed EndpointSlice list omitted items")
  return items as Record<string, unknown>[]
}

/** Creates one foreign EndpointSlice that the provider must leave untouched. */
async function createForeign(address: string, token: string): Promise<Record<string, unknown>> {
  const response = await api(address, token, collection(), "POST", {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: {
      name: "foreign-slice",
      namespace: Namespace,
      labels: { "kubernetes.io/service-name": "foreign" }
    },
    addressType: "IPv4",
    endpoints: [{ addresses: ["10.42.0.99"] }],
    ports: [{ name: "http", protocol: "TCP", port: 8080 }]
  })
  ensure(response.status === 201, `foreign EndpointSlice create returned HTTP ${response.status}`)
  return await json(response)
}

/** Reads one exact real EndpointSlice. */
async function exactSlice(
  address: string,
  token: string,
  name: string
): Promise<Record<string, unknown>> {
  const response = await api(address, token, `${collection()}/${encodeURIComponent(name)}`)
  ensure(response.status === 200, `exact EndpointSlice get returned HTTP ${response.status}`)
  return await json(response)
}

/** Reads one object's metadata name. */
function objectName(value: Record<string, unknown>): string {
  const metadata = value.metadata
  ensure(
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata),
    "EndpointSlice metadata is invalid"
  )
  const name = (metadata as Record<string, unknown>).name
  ensure(typeof name === "string" && name.length !== 0, "EndpointSlice name is invalid")
  return name
}

/** Waits for one replacement snapshot under a real deadline. */
async function next(watcher: Watcher): Promise<readonly ServiceInstance[]> {
  const timed = withTimeout(background(), 5_000)
  try {
    return await watcher.next(timed[0])
  } finally {
    timed[1]()
  }
}

/** Proves the real API returns a Status 410 frame for one stale cursor. */
async function proveReal410(address: string, token: string): Promise<void> {
  const response = await api(
    address,
    token,
    `${collection()}?watch=true&resourceVersion=1&timeoutSeconds=1`
  )
  ensure(response.status === 200, `real stale watch returned HTTP ${response.status}`)
  const text = await response.text()
  ensure(text.includes('"type":"ERROR"'), "real stale watch omitted ERROR frame")
  ensure(text.includes('"code":410'), "real stale watch omitted Status 410")
}

/** Runs real K3s behavior and always removes every Docker-owned resource. */
async function main(): Promise<void> {
  const container = `likego-k3s-${crypto.randomUUID()}`
  const port = await freePort()
  const address = `https://127.0.0.1:${port}`
  const volumes = VolumeTargets.map((_target, index) => `${container}-volume-${index}`)
  let namespaceCreated = false
  let scenarioComplete = false
  try {
    for (const volume of volumes) {
      await docker("volume", "create", "--label", DockerOwnerLabel, volume)
    }
    await docker(
      "run",
      "-d",
      "--privileged",
      "--name",
      container,
      "--label",
      DockerOwnerLabel,
      "--volume",
      `${volumes[0]}:${VolumeTargets[0]}`,
      "--volume",
      `${volumes[1]}:${VolumeTargets[1]}`,
      "--volume",
      `${volumes[2]}:${VolumeTargets[2]}`,
      "--volume",
      `${volumes[3]}:${VolumeTargets[3]}`,
      "-p",
      `127.0.0.1:${port}:6443`,
      Image,
      "server",
      "--disable=traefik",
      "--disable=servicelb",
      "--disable=metrics-server",
      "--write-kubeconfig-mode=644",
      "--tls-san=127.0.0.1"
    )
    await eventually(
      async () => {
        const ready = await command([
          "docker",
          "exec",
          container,
          "kubectl",
          "get",
          "--raw=/readyz"
        ])
        return ready.code === 0 && ready.stdout === "ok"
      },
      30_000,
      "real K3s API did not become ready"
    )
    await kubectl(container, "create", "namespace", Namespace)
    namespaceCreated = true
    await kubectl(container, "-n", Namespace, "create", "serviceaccount", ServiceAccount)
    await kubectl(
      container,
      "-n",
      Namespace,
      "run",
      OwnerPod,
      "--image=registry.k8s.io/pause:3.10.2@sha256:f548e0e8e3dc1896ca956272154dde3314e8cc4fde0a57577ee9fa1c63f5baf4",
      "--restart=Never",
      `--overrides={"spec":{"serviceAccountName":"${ServiceAccount}"}}`
    )
    const ownerUid = await kubectl(
      container,
      "-n",
      Namespace,
      "get",
      "pod",
      OwnerPod,
      "-o",
      "jsonpath={.metadata.uid}"
    )
    ensure(ownerUid.length !== 0, "real owner Pod omitted its UID")
    await kubectl(
      container,
      "-n",
      Namespace,
      "create",
      "role",
      Role,
      "--resource=endpointslices.discovery.k8s.io",
      `--verb=${Verbs.join(",")}`
    )
    await kubectl(
      container,
      "-n",
      Namespace,
      "create",
      "rolebinding",
      Role,
      `--role=${Role}`,
      `--serviceaccount=${Namespace}:${ServiceAccount}`
    )
    const token = await kubectl(container, "-n", Namespace, "create", "token", ServiceAccount)
    ensure(token.length > 100, "real ServiceAccount token is unexpectedly short")

    const foreignBefore = await createForeign(address, token)
    const requests: RecordedRequest[] = []
    const registry = newKubernetesRegistry({
      fetch: realFetch(requests),
      address,
      namespace: Namespace,
      owner: { name: OwnerPod, uid: ownerUid },
      token,
      retryInitialMs: 20,
      retryMaximumMs: 100,
      watchTimeoutSeconds: 5
    })
    const watcher = await registry.watch(background(), fixture("initial").name)
    const initial = fixture("initial")
    await registry.register(background(), initial)
    ensure(JSON.stringify(await next(watcher)) === JSON.stringify([initial]), "watch missed create")
    ensure(
      JSON.stringify(await registry.getService(background(), initial.name)) ===
        JSON.stringify([initial]),
      "real getService did not round-trip the instance"
    )
    const firstSlices = await managedSlices(address, token)
    ensure(firstSlices.length === 1, "real registration did not create one EndpointSlice")
    const stale = firstSlices[0]
    ensure(stale !== undefined, "real registration omitted its EndpointSlice")
    const staleMetadata = stale.metadata as Record<string, unknown>
    ensure(
      JSON.stringify(staleMetadata.ownerReferences) ===
        JSON.stringify([
          {
            apiVersion: "v1",
            kind: "Pod",
            name: OwnerPod,
            uid: ownerUid
          }
        ]),
      "real registration omitted its exact Pod ownerReference"
    )

    const updated = fixture("updated")
    await registry.register(background(), updated)
    ensure(JSON.stringify(await next(watcher)) === JSON.stringify([updated]), "watch missed update")
    const staleResponse = await api(
      address,
      token,
      `${collection()}/${encodeURIComponent(objectName(stale))}`,
      "PUT",
      stale
    )
    ensure(staleResponse.status === 409, `stale CAS returned HTTP ${staleResponse.status}`)
    await staleResponse.body?.cancel()

    await registry.deregister(background(), initial)
    ensure((await managedSlices(address, token)).length === 1, "stale deregister deleted update")
    await registry.deregister(background(), updated)
    ensure((await next(watcher)).length === 0, "watch missed deregistration")
    await watcher.stop(background())
    ensure((await managedSlices(address, token)).length === 0, "managed cleanup is not empty")

    await proveReal410(address, token)
    let watchAdmissions = 0
    let staleInjected = false
    const staleFetch: KubernetesFetch = async function injectStale(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.searchParams.get("watch") === "true") {
        watchAdmissions += 1
        if (!staleInjected) {
          staleInjected = true
          url.searchParams.set("resourceVersion", "1")
          return fetch(new Request(url, request), { tls: { rejectUnauthorized: false } })
        }
      }
      return fetch(request, { tls: { rejectUnauthorized: false } })
    }
    const staleRegistry = newKubernetesRegistry({
      fetch: staleFetch,
      address,
      namespace: Namespace,
      owner: { name: OwnerPod, uid: ownerUid },
      token,
      retryInitialMs: 20,
      retryMaximumMs: 100,
      watchTimeoutSeconds: 5
    })
    const recovered = await staleRegistry.watch(background(), initial.name)
    await eventually(
      () => staleInjected && watchAdmissions >= 2,
      5_000,
      "provider did not relist and rewatch after real Status 410"
    )
    await staleRegistry.register(background(), initial)
    ensure(
      JSON.stringify(await next(recovered)) === JSON.stringify([initial]),
      "410 recovery failed"
    )
    await staleRegistry.deregister(background(), initial)
    ensure((await next(recovered)).length === 0, "410 watcher missed cleanup")
    await recovered.stop(background())

    await registry.register(background(), initial)
    ensure((await managedSlices(address, token)).length === 1, "GC fixture registration is missing")
    await kubectl(container, "-n", Namespace, "delete", "pod", OwnerPod, "--wait=true")
    await eventually(
      async () => (await managedSlices(address, token)).length === 0,
      20_000,
      "Kubernetes garbage collection left the Pod-owned EndpointSlice behind"
    )

    const foreignAfter = await exactSlice(address, token, "foreign-slice")
    ensure(
      JSON.stringify(foreignAfter) === JSON.stringify(foreignBefore),
      "provider mutated a foreign EndpointSlice"
    )
    ensure(
      requests.every((request) => new URL(request.url).pathname.startsWith(collection())),
      "provider left the namespaced EndpointSlice API"
    )
    ensure(
      requests
        .filter((request) => request.method === "PUT")
        .every((request) => request.body.includes('"resourceVersion":"')),
      "provider update omitted resourceVersion CAS"
    )
    ensure(
      requests
        .filter((request) => request.method === "DELETE")
        .every((request) => request.body.includes('"preconditions":{"resourceVersion":"')),
      "provider delete omitted resourceVersion precondition"
    )
    scenarioComplete = true
    await kubectl(container, "delete", "namespace", Namespace, "--wait=true")
    namespaceCreated = false
  } finally {
    if (namespaceCreated) {
      await command([
        "docker",
        "exec",
        container,
        "kubectl",
        "delete",
        "namespace",
        Namespace,
        "--ignore-not-found=true",
        "--wait=false"
      ])
    }
    await command(["docker", "rm", "-fv", container])
    for (const volume of volumes) await command(["docker", "volume", "rm", volume])
    const remnant = await command(["docker", "ps", "-a", "--filter", `name=^/${container}$`, "-q"])
    ensure(remnant.stdout === "", "real K3s container cleanup left a remnant")
    for (const volume of volumes) {
      const inspection = await command(["docker", "volume", "inspect", volume])
      ensure(inspection.code !== 0, `real K3s cleanup left volume ${volume}`)
    }
  }
  ensure(scenarioComplete, "real K3s scenario did not complete")
}

await main()
