import { resolve } from "node:path"

import { newDockerOwner, runCommand, verifyDockerOwnerCleanup } from "../e2e/suites"

const TotalTimeoutMs = 20 * 60_000
const CleanupReserveMs = 60_000
const ChildTimeoutMs = TotalTimeoutMs - CleanupReserveMs
const PreparedCommand = ["bun", "run", "test:providers:docker:prepared"] as const
const RequiredEvidenceTokens = [
  '"package": "@likego/broker-rabbitmq"',
  "LIKEGO_CACHE_REDIS_E2E_RESULT=",
  "LIKEGO_REGISTRY_CONSUL_E2E_RESULT=",
  "LIKEGO_ETCD_DOCKER_V2=",
  "LIKEGO_KUBERNETES_DOCKER_V2=",
  "LIKEGO_REGISTRY_MDNS_E2E_RESULT=",
  "LIKEGO_ZOOKEEPER_DOCKER_EVIDENCE_V2=",
  "LIKEGO_CONFIG_KUBERNETES_DOCKER=",
  "LIKEGO_CONFIG_VAULT_E2E_RESULT=",
  "LIKEGO_STORE_VAULT_E2E_RESULT="
] as const

/** Runs the fixed provider Docker lane under one invocation-unique cleanup owner. */
async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..")
  const owner = newDockerOwner("provider-docker-gate")
  const deadline = performance.now() + TotalTimeoutMs
  const childTimeoutMs = Math.min(
    ChildTimeoutMs,
    Math.floor(deadline - performance.now()) - CleanupReserveMs
  )
  const controller = new AbortController()
  const cancelFor = (signal: "SIGINT" | "SIGTERM"): void => {
    controller.abort(new Error(`provider Docker gate received ${signal}`))
  }
  const cancelForInterrupt = (): void => cancelFor("SIGINT")
  const cancelForTermination = (): void => cancelFor("SIGTERM")
  process.on("SIGINT", cancelForInterrupt)
  process.on("SIGTERM", cancelForTermination)
  let primary: { readonly reason: unknown } | null = null
  let cleanup: { readonly reason: unknown } | null = null
  try {
    try {
      const result = await runCommand(root, {
        cwd: ".",
        command: PreparedCommand,
        timeoutMs: childTimeoutMs,
        environment: { LIKEGO_E2E_OWNER: owner },
        signal: controller.signal
      })
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      if (result.timedOut) throw new Error(`provider Docker gate exceeded ${childTimeoutMs}ms`)
      if (result.exitCode !== 0) {
        throw new Error(`provider Docker gate exited ${result.exitCode}`)
      }
      for (const token of RequiredEvidenceTokens) {
        if (!result.stdout.includes(token)) {
          throw new Error(`provider Docker gate missing evidence ${token}`)
        }
      }
    } catch (reason) {
      primary = Object.freeze({ reason })
    }
    try {
      await verifyDockerOwnerCleanup(root, owner, deadline)
    } catch (reason) {
      cleanup = Object.freeze({ reason })
    }
  } finally {
    process.off("SIGINT", cancelForInterrupt)
    process.off("SIGTERM", cancelForTermination)
  }
  if (primary === null && controller.signal.aborted) {
    primary = Object.freeze({ reason: controller.signal.reason })
  }
  if (primary !== null && cleanup !== null) {
    throw new AggregateError(
      [primary.reason, cleanup.reason],
      "provider Docker gate failed and leaked resources"
    )
  }
  if (primary !== null) throw primary.reason
  if (cleanup !== null) throw cleanup.reason
}

await main()
