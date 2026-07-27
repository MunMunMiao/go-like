import { background, withTimeout } from "@likego/context"
import { createServer } from "node:net"

import {
  kubernetesSource,
  type KubernetesConfigHttpError,
  type KubernetesFetch
} from "../../src/index"

const Image =
  "rancher/k3s:v1.36.2-k3s1@sha256:6a47cea22c4b834d4ba72c89d291696b79ebe406251f90b446e4dff03513dd87"
const Namespace = "likego-config-test"
const ServiceAccount = "likego-config"
const DeniedServiceAccount = "likego-config-denied"
const Role = "likego-config"
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
  if (result.code !== 0) throw new Error(`docker ${args[0] ?? "command"} failed: ${result.stderr}`)
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

/** Creates a real TLS-accepting Fetch borrowed by the provider. */
function realFetch(): KubernetesFetch {
  return function borrowed(request): Promise<Response> {
    return fetch(request, { tls: { rejectUnauthorized: false } })
  }
}

/** Calls the real namespaced API with one ServiceAccount token. */
function api(address: string, token: string, path: string): Promise<Response> {
  return fetch(new URL(path, address), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    tls: { rejectUnauthorized: false }
  })
}

/** Waits for one source watcher mutation under a real deadline. */
async function next(
  watcher: Awaited<ReturnType<NonNullable<ReturnType<typeof kubernetesSource>["watch"]>>>
): Promise<void> {
  const timed = withTimeout(background(), 5_000)
  try {
    await watcher.next(timed[0])
  } finally {
    timed[1]()
  }
}

/** Proves the real API emits Status 410 for the stale resourceVersion used by recovery. */
async function proveReal410(address: string, token: string): Promise<void> {
  const query = new URLSearchParams({
    fieldSelector: "metadata.name=orders-config",
    resourceVersion: "1",
    timeoutSeconds: "1",
    watch: "true"
  })
  const response = await api(address, token, `/api/v1/namespaces/${Namespace}/configmaps?${query}`)
  ensure(response.status === 200, `real stale watch returned HTTP ${response.status}`)
  const text = await response.text()
  ensure(text.includes('"type":"ERROR"'), "real stale watch omitted ERROR frame")
  ensure(text.includes('"code":410'), "real stale watch omitted Status 410")
}

/** Creates one source against the real namespaced Kubernetes API. */
function source(
  fetchCapability: KubernetesFetch,
  address: string,
  token: string,
  kind: "ConfigMap" | "Secret",
  name: string
) {
  return kubernetesSource({
    fetch: fetchCapability,
    address,
    namespace: Namespace,
    kind,
    name,
    key: "config.json",
    token,
    retryInitialMs: 20,
    retryMaximumMs: 100,
    watchTimeoutSeconds: 5
  })
}

/** Runs real K3s load/watch/RBAC behavior and removes every Docker-owned resource. */
async function main(): Promise<void> {
  const container = `likego-config-k3s-${crypto.randomUUID()}`
  const port = await freePort()
  const address = `https://127.0.0.1:${port}`
  const volumes = VolumeTargets.map((_target, index) => `${container}-volume-${index}`)
  let namespaceCreated = false
  let scenarioComplete = false
  let imageId = ""
  let serverVersion = ""
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
    imageId = await docker("inspect", "--format", "{{.Image}}", container)
    const versionValue: unknown = JSON.parse(await kubectl(container, "version", "--output=json"))
    ensure(
      typeof versionValue === "object" && versionValue !== null && "serverVersion" in versionValue,
      "real K3s version response omitted serverVersion"
    )
    const server = versionValue.serverVersion
    ensure(
      typeof server === "object" && server !== null && "gitVersion" in server,
      "real K3s version response omitted gitVersion"
    )
    serverVersion = String(server.gitVersion)
    ensure(serverVersion === "v1.36.2+k3s1", `real K3s server version drifted to ${serverVersion}`)

    await kubectl(container, "create", "namespace", Namespace)
    namespaceCreated = true
    await kubectl(container, "-n", Namespace, "create", "serviceaccount", ServiceAccount)
    await kubectl(container, "-n", Namespace, "create", "serviceaccount", DeniedServiceAccount)
    await kubectl(
      container,
      "-n",
      Namespace,
      "create",
      "role",
      Role,
      "--resource=configmaps,secrets",
      "--verb=get,list,watch"
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
    const deniedToken = await kubectl(
      container,
      "-n",
      Namespace,
      "create",
      "token",
      DeniedServiceAccount
    )
    ensure(token.length > 100 && deniedToken.length > 100, "real ServiceAccount token is invalid")

    await kubectl(
      container,
      "-n",
      Namespace,
      "create",
      "configmap",
      "orders-config",
      '--from-literal=config.json={"revision":"initial"}'
    )
    await kubectl(
      container,
      "-n",
      Namespace,
      "create",
      "secret",
      "generic",
      "orders-secret",
      '--from-literal=config.json={"private":true}'
    )

    const configMap = source(realFetch(), address, token, "ConfigMap", "orders-config")
    const initial = await configMap.load(background())
    ensure(initial.value.revision === "initial", "real ConfigMap initial load failed")
    const configMapWatcher = await configMap.watch?.(background(), initial.revision)
    ensure(configMapWatcher !== undefined, "real ConfigMap watcher is absent")

    const updated = next(configMapWatcher)
    await kubectl(
      container,
      "-n",
      Namespace,
      "patch",
      "configmap",
      "orders-config",
      "--type=merge",
      '-p={"data":{"config.json":"{\\"revision\\":\\"updated\\"}"}}'
    )
    await updated
    ensure(
      (await configMap.load(background())).value.revision === "updated",
      "real ConfigMap update reload failed"
    )

    const deleted = next(configMapWatcher)
    await kubectl(container, "-n", Namespace, "delete", "configmap", "orders-config")
    await deleted
    const missing = await configMap.load(background()).catch((error: unknown) => error)
    ensure(
      typeof missing === "object" &&
        missing !== null &&
        "status" in missing &&
        missing.status === 404,
      "real ConfigMap deletion did not produce HTTP 404"
    )

    const recreated = next(configMapWatcher)
    await kubectl(
      container,
      "-n",
      Namespace,
      "create",
      "configmap",
      "orders-config",
      '--from-literal=config.json={"revision":"recreated"}'
    )
    await recreated
    ensure(
      (await configMap.load(background())).value.revision === "recreated",
      "real ConfigMap recreation reload failed"
    )
    await configMapWatcher.stop(background())

    const secret = source(realFetch(), address, token, "Secret", "orders-secret")
    const secretInitial = await secret.load(background())
    ensure(secretInitial.value.private === true, "real Secret load failed")
    const secretWatcher = await secret.watch?.(background(), secretInitial.revision)
    ensure(secretWatcher !== undefined, "real Secret watcher is absent")
    const secretUpdated = next(secretWatcher)
    await kubectl(
      container,
      "-n",
      Namespace,
      "patch",
      "secret",
      "orders-secret",
      "--type=merge",
      `-p={"data":{"config.json":"${btoa('{"private":"updated"}')}"}}`
    )
    await secretUpdated
    ensure(
      (await secret.load(background())).value.private === "updated",
      "real Secret update reload failed"
    )
    await secretWatcher.stop(background())

    const forbidden = source(realFetch(), address, deniedToken, "Secret", "orders-secret")
    const denied = await forbidden.load(background()).catch((error: unknown) => error)
    ensure(
      typeof denied === "object" &&
        denied !== null &&
        "code" in denied &&
        denied.code === "LIKEGO_KUBERNETES_CONFIG_HTTP" &&
        "status" in denied &&
        denied.status === 403,
      "real RBAC denial was not a secret-safe HTTP 403"
    )
    ensure(
      !String(denied).includes(deniedToken) && !String(denied).includes("updated"),
      "real RBAC error leaked credentials or Secret content"
    )

    await proveReal410(address, token)
    let staleInjected = false
    let watchAdmissions = 0
    const staleFetch: KubernetesFetch = function injectStale(request): Promise<Response> {
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
    const recoveredSource = source(staleFetch, address, token, "ConfigMap", "orders-config")
    const recoveryInitial = await recoveredSource.load(background())
    const recoveredWatcher = await recoveredSource.watch?.(background(), recoveryInitial.revision)
    ensure(recoveredWatcher !== undefined, "real recovery watcher is absent")
    await next(recoveredWatcher)
    const recoveryChanged = next(recoveredWatcher)
    await kubectl(
      container,
      "-n",
      Namespace,
      "patch",
      "configmap",
      "orders-config",
      "--type=merge",
      '-p={"data":{"config.json":"{\\"revision\\":\\"after-410\\"}"}}'
    )
    await recoveryChanged
    ensure(staleInjected && watchAdmissions >= 2, "real Status 410 did not relist and rewatch")
    ensure(
      (await recoveredSource.load(background())).value.revision === "after-410",
      "real Status 410 recovery missed the next update"
    )
    await recoveredWatcher.stop(background())

    scenarioComplete = true
    await kubectl(container, "delete", "namespace", Namespace, "--wait=true")
    namespaceCreated = false
    const namespaceReadback = await command([
      "docker",
      "exec",
      container,
      "kubectl",
      "get",
      "namespace",
      Namespace
    ])
    ensure(
      namespaceReadback.code !== 0,
      "real namespace cleanup readback still found the namespace"
    )
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
  console.log(
    `LIKEGO_CONFIG_KUBERNETES_DOCKER=${JSON.stringify({
      valid: true,
      image: Image,
      imageId,
      serverVersion,
      api: "v1 ConfigMap and Secret",
      contract: "single-resource single-key ConfigSource",
      scenarios: [
        "configmap-load-watch-update-delete-recreate",
        "secret-load-watch-update",
        "resourceversion-bookmark-410-relist",
        "rbac-forbidden-secret-safe"
      ],
      cleanup: {
        namespaces: 0,
        containerRemoved: true,
        volumesRemoved: volumes.length
      },
      rbac: ["get", "list", "watch"],
      status: "passed"
    })}`
  )
}

await main()
