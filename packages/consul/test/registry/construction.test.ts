import { expect, test } from "bun:test"

import { newConsulRegistry } from "../../src/registry/index"
import { newConsulClient, type ConsulClientOptions } from "../../src/index"
type ConsulFetch = ConsulClientOptions["fetch"]

const accepted: ConsulFetch = async function acceptedFetch(): Promise<Response> {
  return new Response(null)
}

test("constructor captures and validates common Registry options", () => {
  const registry = newConsulRegistry(
    newConsulClient({
      fetch: accepted,
      address: "https://consul.example/"
    }),
    {
      timeoutMs: 25
    }
  )
  expect(Object.keys(registry).sort()).toEqual(["deregister", "getService", "register", "watch"])
})

test("constructor validates every provider option and never reflects credentials", () => {
  const secret = "never-reflect-this"
  const invalid: readonly (() => unknown)[] = [
    () => newConsulRegistry(null as never),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: null as never,
          address: "https://consul.example"
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: 1 as never
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: `not a url ${secret}`
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "ftp://consul.example"
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: `https://user:${secret}@consul.example`
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example/v1"
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example?"
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example#"
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example",
          token: ""
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example",
          token: "bad\r\ntoken"
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example",
          datacenter: ""
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example",
          namespace: ""
        })
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          waitMs: 0
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          waitMs: 600_001
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          minimumQueryIntervalMs: 0
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          retryInitialMs: 0
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          retryInitialMs: 10,
          retryMaximumMs: 9
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          deregisterCriticalServiceAfterMs: 59_999
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          deregisterCriticalServiceAfterMs: 86_400_001
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          watchBufferSize: 0
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          watchBufferSize: 4_097
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          ttlMs: 1_999
        }
      ),
    () =>
      newConsulRegistry(
        newConsulClient({
          fetch: accepted,
          address: "https://consul.example"
        }),
        {
          ttlMs: 86_400_001
        }
      )
  ]
  for (const construct of invalid) {
    expect(construct).toThrow()
    try {
      construct()
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  }
})

test("constructor snapshots getters once and does not close borrowed Fetch", () => {
  let reads = 0
  let closeCalls = 0
  const fetchCapability: ConsulFetch & { close(): void } = Object.assign(accepted, {
    close(): void {
      closeCalls += 1
    }
  })
  const options = Object.defineProperty(
    {
      fetch: fetchCapability,
      address: "https://consul.example"
    },
    "token",
    {
      enumerable: true,
      get(): string {
        reads += 1
        return reads === 1 ? "safe-token" : "bad\r\ntoken"
      }
    }
  )
  newConsulClient(options)
  expect(reads).toBe(1)
  expect(closeCalls).toBe(0)
})
