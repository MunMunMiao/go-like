import type { Context } from "@go-like/context"
import { newVaultStore } from "@go-like/store-vault"

export interface PlatformRuntimeState {
  publish(ctx: Context): Promise<void>
  remove(ctx: Context): Promise<void>
}

const encoder = new TextEncoder()

/** Creates one real Vault KV v2-backed deployment record with fresh readback. */
export function newPlatformRuntimeState(
  address: string,
  token: string,
  instanceId: string
): PlatformRuntimeState {
  const store = newVaultStore({
    fetch(request) {
      return fetch(request)
    },
    address,
    mount: "secret",
    root: "go-like/examples/enterprise-platform/runtime",
    token
  })
  const key = `instances/${instanceId}`
  const value = encoder.encode(JSON.stringify({ instanceId, status: "running" }))
  return Object.freeze({
    async publish(ctx: Context): Promise<void> {
      const written = await store.write(ctx, {
        key,
        value,
        metadata: Object.freeze({ service: "enterprise-platform-runtime" })
      })
      const fresh = await store.read(ctx, key)
      if (
        fresh === null ||
        fresh.revision !== written.revision ||
        fresh.metadata.service !== "enterprise-platform-runtime"
      ) {
        throw new Error("Vault runtime-state readback failed")
      }
    },
    async remove(ctx: Context): Promise<void> {
      await store.delete(ctx, key)
      if ((await store.read(ctx, key)) !== null) {
        throw new Error("Vault runtime-state cleanup failed")
      }
    }
  })
}
