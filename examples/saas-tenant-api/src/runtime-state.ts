import type { Context } from "@go-like/context"
import { newConsulStore } from "@go-like/store-consul"

export interface TenantRuntimeState {
  publish(ctx: Context): Promise<void>
  remove(ctx: Context): Promise<void>
}

const encoder = new TextEncoder()

/** Creates one real Consul Store-backed process-presence record with fresh readback. */
export function newTenantRuntimeState(address: string, instanceId: string): TenantRuntimeState {
  const store = newConsulStore({
    fetch(request) {
      return fetch(request)
    },
    address,
    root: "go-like/examples/saas-tenant-api/runtime"
  })
  const key = `instances/${instanceId}`
  const value = encoder.encode(JSON.stringify({ instanceId, status: "running" }))
  return Object.freeze({
    async publish(ctx: Context): Promise<void> {
      const written = await store.write(ctx, {
        key,
        value,
        metadata: Object.freeze({ service: "saas-tenant-api" })
      })
      const fresh = await store.read(ctx, key)
      if (
        fresh === null ||
        fresh.revision !== written.revision ||
        fresh.metadata.service !== "saas-tenant-api"
      ) {
        throw new Error("Consul runtime-state readback failed")
      }
    },
    async remove(ctx: Context): Promise<void> {
      await store.delete(ctx, key)
      if ((await store.read(ctx, key)) !== null) {
        throw new Error("Consul runtime-state cleanup failed")
      }
    }
  })
}
