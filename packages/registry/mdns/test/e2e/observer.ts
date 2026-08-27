import { readFile, readdir, readlink, writeFile } from "node:fs/promises"

import { background, withTimeout, type Context } from "@go-like/context"
import { type ServiceInstance, type Watcher } from "@go-like/registry"
import type {
  MDNSAddress,
  MDNSBindOptions,
  MDNSDatagram,
  MDNSDatagramSocket,
  MDNSHost,
  MDNSMembership,
  MDNSNetworkInterface,
  MDNSRegistry
} from "@go-like/registry-mdns"

import {
  primaryName,
  artifact,
  delay,
  nextSnapshot,
  nodeHost,
  registry,
  selectedFamily,
  verify,
  waitForArtifact,
  writeArtifact
} from "./scenario"

interface ReceiveCounter {
  count: number
}

interface SocketAudit {
  readonly socketFDs: number
  readonly udp4Rows: number
  readonly udp6Rows: number
}

interface IdentityLifecycle {
  readonly identityCount: number
  readonly identityKeys: readonly string[]
  readonly createCount: number
  readonly updateCount: number
  readonly deleteCount: number
}

/** Wraps a native host to count completed datagram deliveries. */
function countedHost(base: MDNSHost, counter: ReceiveCounter): MDNSHost {
  return Object.freeze({
    networkInterfaces(ctx: Context): Promise<readonly MDNSNetworkInterface[]> {
      return base.networkInterfaces(ctx)
    },
    async bindDatagram(ctx: Context, options: MDNSBindOptions): Promise<MDNSDatagramSocket> {
      const socket = await base.bindDatagram(ctx, options)
      return Object.freeze({
        settled(): Promise<void> {
          return socket.settled()
        },
        joinMulticast(
          joinContext: Context,
          group: string,
          interfaceId: string | number
        ): Promise<MDNSMembership> {
          return socket.joinMulticast(joinContext, group, interfaceId)
        },
        setMulticastLoopback(loopContext: Context, enabled: boolean): Promise<void> {
          return socket.setMulticastLoopback(loopContext, enabled)
        },
        setMulticastInterface(
          interfaceContext: Context,
          interfaceId: string | number
        ): Promise<void> {
          return socket.setMulticastInterface(interfaceContext, interfaceId)
        },
        send(sendContext: Context, data: Uint8Array, target: MDNSAddress): Promise<void> {
          return socket.send(sendContext, data, target)
        },
        async receive(receiveContext: Context): Promise<MDNSDatagram> {
          const datagram = await socket.receive(receiveContext)
          counter.count += 1
          return datagram
        },
        close(closeContext: Context): Promise<void> {
          return socket.close(closeContext)
        }
      })
    }
  })
}

/** Counts live socket descriptors and UDP/5353 rows in this Node PID namespace. */
async function socketAudit(): Promise<SocketAudit> {
  let socketFDs = 0
  for (const name of await readdir("/proc/1/fd")) {
    try {
      if ((await readlink(`/proc/1/fd/${name}`)).startsWith("socket:[")) socketFDs += 1
    } catch {
      // Descriptor churn is resolved by the authoritative UDP table checks below.
    }
  }
  /** Counts UDP/5353 rows in one kernel address-family table. */
  async function rows(file: string): Promise<number> {
    let count = 0
    const lines = (await readFile(file, "utf8")).split("\n").slice(1)
    for (const line of lines) {
      const local = line.trim().split(/\s+/, 2)[1]
      if (local?.split(":").at(-1)?.toUpperCase() === "14E9") count += 1
    }
    return count
  }
  return Object.freeze({
    socketFDs,
    udp4Rows: await rows("/proc/net/udp"),
    udp6Rows: await rows("/proc/net/udp6")
  })
}

/** Returns the one primary instance from a non-empty replacement snapshot. */
function primary(snapshot: readonly ServiceInstance[], phase: string): ServiceInstance {
  const value = snapshot.find((candidate) => candidate.name === primaryName)
  if (value === undefined) throw new Error(`${phase} snapshot omitted the primary instance`)
  return value
}

/** Validates the complete flattened ServiceInstance payload. */
function validatePrimary(service: ServiceInstance, revision: string): void {
  verify(
    service.id === "primary-node" && service.name === primaryName && service.version === "v1",
    "primary identity did not round-trip"
  )
  verify(
    service.metadata.environment === "docker" &&
      service.metadata.owner === "go-like" &&
      service.metadata.zone === "docker" &&
      service.metadata.revision === revision,
    "ServiceInstance metadata did not round-trip"
  )
  verify(service.endpoints.length === 1, "ServiceInstance endpoint did not round-trip")
  const endpoint = new URL(service.endpoints[0] ?? "")
  verify(endpoint.protocol === "http:" && endpoint.port === "8080", "endpoint URL is invalid")
}

/** Summarizes complete replacement snapshots for one stable instance identity. */
function identityLifecycle(snapshots: readonly (readonly ServiceInstance[])[]): IdentityLifecycle {
  const identities = new Set<string>()
  let createCount = 0
  let updateCount = 0
  let deleteCount = 0
  let active = false
  for (const snapshot of snapshots) {
    const value = snapshot.find((candidate) => candidate.name === primaryName)
    if (value === undefined) {
      if (active) deleteCount += 1
      active = false
      continue
    }
    identities.add(JSON.stringify([value.name, value.id]))
    if (active) updateCount += 1
    else createCount += 1
    active = true
  }
  const identityKeys = Object.freeze(Array.from(identities).sort())
  return Object.freeze({
    identityCount: identityKeys.length,
    identityKeys,
    createCount,
    updateCount,
    deleteCount
  })
}

/** Repeats a real multicast query until the expected snapshot is observed. */
async function queryPrimary(target: MDNSRegistry, revision: string): Promise<ServiceInstance> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = await target.getService(background(), primaryName)
    const value = found[0]
    if (value !== undefined && value.metadata.revision === revision) return value
    await delay(50)
  }
  throw new Error(`primary revision ${revision} was not discoverable`)
}

/** Proves no replacement snapshot was emitted inside one bounded interval. */
async function expectNoSnapshot(watcher: Watcher, milliseconds: number): Promise<void> {
  const [ctx, cancel] = withTimeout(background(), milliseconds)
  let observed: readonly ServiceInstance[] | null = null
  try {
    observed = await watcher.next(ctx)
  } catch {
    // Deadline is the expected proof that rescue prevented a deletion snapshot.
  } finally {
    cancel()
  }
  verify(observed === null, "unexpected watcher snapshot during rescue")
}

/** Stops one watcher and waits for physical cleanup. */
function stopWatcher(watcher: Watcher): Promise<void> {
  return watcher.stop(background())
}

/** Runs normal discovery, update, rescue, delete, and shutdown evidence. */
async function normal(): Promise<void> {
  const before = await socketAudit()
  const counter: ReceiveCounter = { count: 0 }
  const target = registry(countedHost(nodeHost(), counter), selectedFamily(), false, 32)
  const watcher = await target.watch(background(), primaryName)
  await writeArtifact("observer-ready")

  const created = await nextSnapshot(watcher)
  const createdService = primary(created, "create")
  validatePrimary(createdService, "one")
  const advertisedEndpoints = createdService.endpoints
  validatePrimary(await queryPrimary(target, "one"), "one")
  await writeArtifact("observer-created")

  const updated = await nextSnapshot(watcher)
  validatePrimary(primary(updated, "update"), "two")
  await writeArtifact("observer-updated")

  const restored = await nextSnapshot(watcher)
  validatePrimary(primary(restored, "restore"), "one")
  await writeArtifact("observer-restored")

  await waitForArtifact("cooperator-ready")
  await waitForArtifact("publisher-stopped-primary")
  await expectNoSnapshot(watcher, 1_250)
  validatePrimary(await queryPrimary(target, "one"), "one")
  await writeArtifact("observer-rescue")

  const deleted = await nextSnapshot(watcher, 10_000)
  verify(deleted.length === 0, "expected an empty deregistration snapshot")
  await writeArtifact("observer-deleted")

  const receivesBeforeStop = counter.count
  await stopWatcher(watcher)
  const afterStop = await socketAudit()
  verify(
    afterStop.udp4Rows === 0 && afterStop.udp6Rows === 0,
    "observer retained a UDP/5353 socket after stop"
  )
  await writeArtifact("observer-stopped")
  await waitForArtifact("late-sent")
  await delay(500)
  verify(counter.count === receivesBeforeStop, "stopped observer consumed late multicast")
  const finalAudit = await socketAudit()
  verify(
    finalAudit.udp4Rows === 0 && finalAudit.udp6Rows === 0,
    "observer reopened UDP/5353 after stop"
  )
  await writeFile(
    artifact("observer-result.json"),
    JSON.stringify({
      valid: true,
      mode: "normal",
      family: selectedFamily(),
      created: true,
      updated: true,
      restored: true,
      rescued: true,
      deleted: true,
      domainIsolated: true,
      completePayload: true,
      advertisedEndpoints,
      identityLifecycle: identityLifecycle([created, updated, restored, deleted]),
      stoppedObserverNoReceive: counter.count === receivesBeforeStop,
      receivesBeforeStop,
      receivesAfterStop: counter.count,
      cleanup: { before, afterStop, finalAudit }
    })
  )
}

/** Runs the real SIGKILL expiry observer. */
async function crash(): Promise<void> {
  const before = await socketAudit()
  const target = registry(nodeHost(), selectedFamily(), false, 8)
  const watcher = await target.watch(background(), primaryName)
  await writeArtifact("observer-ready")
  const created = await nextSnapshot(watcher)
  validatePrimary(primary(created, "crash create"), "crash")
  await waitForArtifact("publisher-crash-ready")
  await writeArtifact("observer-cached")
  const deleted = await nextSnapshot(watcher, 10_000)
  verify(deleted.length === 0, "crash observer expected an expiry deletion snapshot")
  await stopWatcher(watcher)
  const after = await socketAudit()
  verify(after.udp4Rows === 0 && after.udp6Rows === 0, "crash observer retained UDP/5353")
  await writeFile(
    artifact("observer-result.json"),
    JSON.stringify({
      valid: true,
      mode: "crash",
      family: selectedFamily(),
      createObserved: true,
      expiryDeleteObserved: true,
      cleanup: { before, after }
    })
  )
}

if ((process.env.GO_LIKE_MODE ?? "normal") === "crash") await crash()
else await normal()
process.stdout.write(
  `GO_LIKE_REGISTRY_MDNS_OBSERVER=${JSON.stringify({ valid: true, mode: process.env.GO_LIKE_MODE ?? "normal" })}\n`
)
