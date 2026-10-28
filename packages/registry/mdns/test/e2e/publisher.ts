import { background } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"

import {
  artifactDirectory,
  delay,
  errorCode,
  isolatedService,
  lateService,
  nodeHost,
  primaryService,
  readArtifact,
  registry,
  secondaryService,
  selectedFamily,
  selectedInterface,
  serviceAddress,
  verify,
  waitForArtifact,
  writeArtifact
} from "./scenario"

/** Runs one cooperating responder in an independent process sharing the publisher namespace. */
async function cooperate(service: ServiceInstance): Promise<void> {
  await waitForArtifact("cooperate-start")
  const provider = registry(nodeHost(), selectedFamily())
  await provider.register(background(), service)
  await writeArtifact("cooperator-ready")
  await waitForArtifact("cooperator-stop")
  await provider.deregister(background(), service)
  await writeArtifact("cooperator-stopped")
}

/** Runs a conflicting responder probe and records exact fail-closed evidence. */
async function collide(endpoint: string): Promise<void> {
  await waitForArtifact("collision-start")
  const candidate = primaryService(endpoint, "collision")
  const provider = registry(nodeHost(), selectedFamily())
  let valid = false
  let code: string | null = null
  try {
    await provider.register(background(), candidate)
    await provider.deregister(background(), candidate)
  } catch (error) {
    code = errorCode(error)
    valid = code === "GO_LIKE_REGISTRY_PROTOCOL"
  }
  await writeArtifact("collider-result.json", JSON.stringify({ valid, code }))
  verify(valid, `collision did not fail closed: ${String(code)}`)
}

/** Runs the normal publisher/update/restore/rescue lifecycle. */
async function normal(): Promise<void> {
  await waitForArtifact("observer-ready")
  const family = selectedFamily()
  const host = nodeHost()
  const networkInterface = await selectedInterface(host, family)
  const endpoint = serviceAddress(networkInterface, 8_080)
  await writeArtifact("publisher-address", endpoint)
  const primary = registry(host, family)
  const secondary = registry(nodeHost(), family)
  const isolated = registry(nodeHost(), family, true)
  const initial = primaryService(endpoint, "one")
  const updated = primaryService(endpoint, "two")
  const catalog = secondaryService(serviceAddress(networkInterface, 8_081))
  const hidden = isolatedService(serviceAddress(networkInterface, 8_082))

  await primary.register(background(), initial)
  await secondary.register(background(), catalog)
  await isolated.register(background(), hidden)
  await writeArtifact("publisher-announced")
  await waitForArtifact("observer-created")

  await primary.register(background(), updated)
  await writeArtifact("publisher-updated")
  await waitForArtifact("observer-updated")
  await primary.register(background(), initial)
  await writeArtifact("publisher-restored")
  await waitForArtifact("observer-restored")

  await writeArtifact("cooperate-start")
  await writeArtifact("collision-start")
  await waitForArtifact("cooperator-ready")
  await waitForArtifact("collider-result.json")
  const collision: unknown = JSON.parse(await readArtifact("collider-result.json"))
  verify(
    typeof collision === "object" && collision !== null && Reflect.get(collision, "valid") === true,
    "collision evidence is invalid"
  )

  await primary.deregister(background(), initial)
  await writeArtifact("publisher-stopped-primary")
  await waitForArtifact("observer-rescue")
  await writeArtifact("cooperator-stop")
  await waitForArtifact("cooperator-stopped")
  await waitForArtifact("observer-deleted")
  await secondary.deregister(background(), catalog)
  await isolated.deregister(background(), hidden)

  await waitForArtifact("observer-stopped")
  const lateProvider = registry(nodeHost(), family, false, 128, 2_000)
  const late = lateService(endpoint)
  await lateProvider.register(background(), late)
  await delay(350)
  await lateProvider.deregister(background(), late)
  await writeArtifact("late-sent")
  process.stdout.write(
    `GO_LIKE_REGISTRY_MDNS_PUBLISHER=${JSON.stringify({ valid: true, family, artifacts: artifactDirectory() })}\n`
  )
}

/** Registers with a two-second TTL and intentionally waits to be SIGKILLed. */
async function crash(): Promise<void> {
  await waitForArtifact("observer-ready")
  const family = selectedFamily()
  const host = nodeHost()
  const networkInterface = await selectedInterface(host, family)
  const endpoint = serviceAddress(networkInterface, 8_080)
  await writeArtifact("publisher-address", endpoint)
  await registry(host, family, false, 128, 2_000).register(
    background(),
    primaryService(endpoint, "crash")
  )
  await writeArtifact("publisher-crash-ready")
  process.stdout.write(
    `GO_LIKE_REGISTRY_MDNS_PUBLISHER=${JSON.stringify({ valid: true, family, phase: "awaiting-kill" })}\n`
  )
  await new Promise<void>(function forever(): void {})
}

const role = process.env.GO_LIKE_ROLE ?? "publisher"
if (role === "cooperator") {
  await waitForArtifact("publisher-address")
  await cooperate(primaryService(await readArtifact("publisher-address"), "one"))
} else if (role === "collider") {
  await waitForArtifact("publisher-address")
  await collide(await readArtifact("publisher-address"))
} else if ((process.env.GO_LIKE_MODE ?? "normal") === "crash") {
  await crash()
} else {
  await normal()
}
