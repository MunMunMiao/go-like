import { access, readFile, writeFile } from "node:fs/promises"

import { background, withTimeout } from "@likego/context"
import { type ServiceInstance, type Watcher } from "@likego/registry"
import { snapshotServiceInstance } from "@likego/registry/provider"
import {
  domain,
  families,
  newMDNSRegistry,
  queryTimeout,
  ttl,
  watchBufferSize,
  type MDNSFamily,
  type MDNSHost,
  type MDNSNetworkInterface,
  type MDNSRegistry
} from "@likego/registry-mdns"
import { newNodeMDNSHost } from "@likego/registry-mdns/node"

export const primaryName = "likego-mdns-primary"
export const secondaryName = "likego-mdns-catalog"
export const isolatedName = "likego-mdns-isolated"
export const lateName = "likego-mdns-late"

/** Fails one real E2E invariant. */
export function verify(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Waits for one real elapsed interval. */
export function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, milliseconds)
  })
}

/** Reads and validates the selected address family. */
export function selectedFamily(): MDNSFamily {
  const value = process.env.LIKEGO_FAMILY
  if (value !== "ipv4" && value !== "ipv6") throw new Error("LIKEGO_FAMILY must be ipv4 or ipv6")
  return value
}

/** Returns the shared artifact directory mounted by the Docker harness. */
export function artifactDirectory(): string {
  const value = process.env.LIKEGO_ARTIFACTS
  if (value === undefined || value.length === 0) throw new Error("LIKEGO_ARTIFACTS is required")
  return value
}

/** Returns one artifact path. */
export function artifact(name: string): string {
  return `${artifactDirectory()}/${name}`
}

/** Reports whether one synchronization artifact currently exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Waits for one cross-container synchronization artifact. */
export async function waitForArtifact(name: string, timeoutMs = 20_000): Promise<void> {
  const path = artifact(name)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await exists(path)) return
    await delay(25)
  }
  throw new Error(`timed out waiting for ${name}`)
}

/** Writes one durable cross-container text artifact. */
export function writeArtifact(name: string, value = "ready\n"): Promise<void> {
  return writeFile(artifact(name), value)
}

/** Reads one cross-container text artifact. */
export async function readArtifact(name: string): Promise<string> {
  return (await readFile(artifact(name), "utf8")).trim()
}

/** Creates one runtime registry for the selected family and optional domain. */
export function registry(
  host: MDNSHost,
  family: MDNSFamily,
  isolated = false,
  watcherQueueSize = 128,
  ttlMs = 120_000
): MDNSRegistry {
  return isolated
    ? newMDNSRegistry(
        host,
        families(family),
        domain("isolated.likego"),
        queryTimeout(300),
        watchBufferSize(watcherQueueSize),
        ttl(ttlMs)
      )
    : newMDNSRegistry(
        host,
        families(family),
        queryTimeout(300),
        watchBufferSize(watcherQueueSize),
        ttl(ttlMs)
      )
}

/** Creates the production Node host used by every container role. */
export function nodeHost(): MDNSHost {
  return newNodeMDNSHost()
}

/** Selects one actual non-internal interface for the requested family. */
export async function selectedInterface(
  host: MDNSHost,
  family: MDNSFamily
): Promise<MDNSNetworkInterface> {
  const interfaces = await host.networkInterfaces(background())
  const selected = interfaces.find(function matching(value): boolean {
    return value.family === family && !value.internal
  })
  if (selected === undefined) throw new Error(`no non-internal ${family} interface exists`)
  return selected
}

/** Formats one selected interface address as an absolute ServiceInstance endpoint. */
export function serviceAddress(networkInterface: MDNSNetworkInterface, port: number): string {
  return networkInterface.family === "ipv4"
    ? `http://${networkInterface.address}:${port}/`
    : `http://[${networkInterface.address}]:${port}/`
}

/** Creates one complete primary instance used by wire and discovery assertions. */
export function primaryService(endpoint: string, revision: string): ServiceInstance {
  return snapshotServiceInstance({
    id: "primary-node",
    name: primaryName,
    version: "v1",
    metadata: { environment: "docker", owner: "likego", revision, zone: "docker" },
    endpoints: [endpoint]
  })
}

/** Creates one additional catalog instance. */
export function secondaryService(endpoint: string): ServiceInstance {
  return snapshotServiceInstance({
    id: "catalog-node",
    name: secondaryName,
    version: "v2",
    metadata: { environment: "docker", role: "catalog", zone: "docker" },
    endpoints: [endpoint]
  })
}

/** Creates one domain-isolated instance that must remain invisible. */
export function isolatedService(endpoint: string): ServiceInstance {
  return snapshotServiceInstance({
    id: "isolated-node",
    name: isolatedName,
    version: "v1",
    metadata: { isolated: "true" },
    endpoints: [endpoint]
  })
}

/** Creates one late packet source used after observer shutdown. */
export function lateService(endpoint: string): ServiceInstance {
  return snapshotServiceInstance({
    id: "late-node",
    name: lateName,
    version: "v1",
    metadata: { phase: "after-observer-stop" },
    endpoints: [endpoint]
  })
}

/** Waits for one complete replacement snapshot with a strict caller-only timeout. */
export async function nextSnapshot(
  watcher: Watcher,
  timeoutMs = 15_000
): Promise<readonly ServiceInstance[]> {
  const [ctx, cancel] = withTimeout(background(), timeoutMs)
  try {
    return await watcher.next(ctx)
  } finally {
    cancel()
  }
}

/** Returns one structural protocol code without exposing payloads. */
export function errorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  const code = Reflect.get(value, "code")
  return typeof code === "string" ? code : null
}
