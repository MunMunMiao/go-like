import { background, withCancelCause } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { expect, test } from "bun:test"

import {
  newConsulRegistry as createConsulRegistry,
  type ConsulFetch,
  type ConsulRegistryOptions
} from "../src/index"
import { captureOptions, operationOptions } from "../src/options"
import { newRegistrationManager } from "../src/registration"
import { eventually, fakeAgent } from "./helpers"

/** Creates one deterministic public ServiceInstance revision. */
function instance(revision: string, id = "orders-1"): ServiceInstance {
  return {
    id,
    name: "orders",
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "updated" ? "http://127.0.0.1:8081/" : "http://127.0.0.1:8080/"]
  }
}

/** Creates one short-TTL provider for registration owner tests. */
function newConsulRegistry(options: ConsulRegistryOptions) {
  return createConsulRegistry({ ...options, ttlMs: 2_000 })
}

/** Captures long-lived registration options without starting test-time heartbeats. */
function registrationOptions(fetch: ConsulFetch) {
  const provider = captureOptions({
    fetch,
    address: "https://consul.example",
    ttlMs: 86_400_000
  })
  return operationOptions(provider, provider.common)
}

test("register returns void, updates one deterministic record, and deregister removes it", async () => {
  const agent = fakeAgent()
  const registry = newConsulRegistry({ fetch: agent.fetch, address: "https://consul.example" })
  expect(await registry.register(background(), instance("initial"))).toBeUndefined()
  const firstId = agent.remoteIds()[0]
  if (firstId === undefined) throw new Error("fake Agent omitted the registered remote ID")
  expect(firstId).toMatch(/^li-[a-z2-7]{52}$/)
  expect(await registry.getService(background(), "orders")).toEqual([instance("initial")])

  expect(await registry.register(background(), instance("updated"))).toBeUndefined()
  expect(agent.remoteIds()).toEqual([firstId])
  expect(await registry.getService(background(), "orders")).toEqual([instance("updated")])

  expect(await registry.deregister(background(), instance("updated"))).toBeUndefined()
  expect(agent.remoteIds()).toEqual([])
})

test("lost registration response is resolved by exact managed readback", async () => {
  const agent = fakeAgent()
  agent.loseNextRegisterResponse()
  const registry = newConsulRegistry({ fetch: agent.fetch, address: "https://consul.example" })
  await registry.register(background(), instance("initial"))
  expect(await registry.getService(background(), "orders")).toEqual([instance("initial")])
  await registry.deregister(background(), instance("initial"))
})

test("private TTL heartbeat recreates a record forgotten by the Consul Agent", async () => {
  const agent = fakeAgent()
  const registry = newConsulRegistry({
    fetch: agent.fetch,
    address: "https://consul.example",
    retryInitialMs: 5,
    retryMaximumMs: 20
  })
  await registry.register(background(), instance("initial"))
  const remoteId = agent.remoteIds()[0]
  agent.clearRecords()
  await eventually(() => agent.remoteIds()[0] === remoteId, 1_500)
  expect(await registry.getService(background(), "orders")).toEqual([instance("initial")])
  await registry.deregister(background(), instance("initial"))
})

test("failed admission rolls back its deterministic remote record", async () => {
  const agent = fakeAgent()
  const fetch: ConsulFetch = async function deniedHeartbeat(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname.startsWith("/v1/agent/check/pass/")) {
      return new Response(null, { status: 403 })
    }
    return agent.fetch(request)
  }
  const registry = newConsulRegistry({ fetch, address: "https://consul.example" })
  await expect(registry.register(background(), instance("initial"))).rejects.toMatchObject({
    code: "LIKEGO_CONSUL_HTTP",
    status: 403
  })
  expect(agent.remoteIds()).toEqual([])
})

test("caller cancellation preserves its exact cause and leaves no registration", async () => {
  const agent = fakeAgent()
  let signalStarted: () => void = () => {}
  const started = new Promise<void>(
    /** Captures the exact point at which the mutation is waiting. */
    function capture(resolve): void {
      signalStarted = resolve
    }
  )
  const fetch: ConsulFetch = async function heldRegistration(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname === "/v1/agent/service/register") {
      signalStarted()
      return new Promise<Response>(
        /** Waits until the provider-owned Request observes caller cancellation. */
        function wait(_resolve, reject): void {
          request.signal.addEventListener(
            "abort",
            /** Rejects with the exact linked AbortSignal reason. */
            function aborted(): void {
              reject(request.signal.reason)
            },
            { once: true }
          )
        }
      )
    }
    return agent.fetch(request)
  }
  const registry = newConsulRegistry({ fetch, address: "https://consul.example" })
  const [ctx, cancel] = withCancelCause(background())
  const failure = new Error("caller canceled registration")
  const operation = registry.register(ctx, instance("initial"))
  await started
  cancel(failure)
  await expect(operation).rejects.toBe(failure)
  expect(agent.remoteIds()).toEqual([])
})

test("deregister remains idempotent when no private registration exists", async () => {
  const agent = fakeAgent()
  const registry = newConsulRegistry({ fetch: agent.fetch, address: "https://consul.example" })
  await expect(registry.deregister(background(), instance("initial"))).resolves.toBeUndefined()
  await expect(registry.deregister(background(), instance("initial"))).resolves.toBeUndefined()
  expect(agent.remoteIds()).toEqual([])
})

test("ambiguous heartbeat and deregistration responses resolve by exact Agent readback", async () => {
  const agent = fakeAgent()
  let loseHeartbeat = true
  let loseDeregister = true
  const fetch: ConsulFetch = async function lossyMutations(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    if (path.startsWith("/v1/agent/check/pass/") && loseHeartbeat) {
      loseHeartbeat = false
      await agent.fetch(request)
      throw new Error("injected lost heartbeat response")
    }
    if (path.startsWith("/v1/agent/service/deregister/") && loseDeregister) {
      loseDeregister = false
      await agent.fetch(request)
      throw new Error("injected lost deregistration response")
    }
    return agent.fetch(request)
  }
  const registry = newConsulRegistry({ fetch, address: "https://consul.example" })

  await registry.register(background(), instance("initial"))
  expect(await registry.getService(background(), "orders")).toEqual([instance("initial")])
  await registry.deregister(background(), instance("initial"))
  expect(agent.remoteIds()).toEqual([])
})

test("ambiguous heartbeat fails closed when Agent check readback is corrupt", async () => {
  const agent = fakeAgent()
  let loseHeartbeat = true
  const fetch: ConsulFetch = async function corruptCheckReadback(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    if (path.startsWith("/v1/agent/check/pass/") && loseHeartbeat) {
      loseHeartbeat = false
      await agent.fetch(request)
      throw new Error("injected lost heartbeat response")
    }
    if (path === "/v1/agent/checks") return new Response("{")
    return agent.fetch(request)
  }
  const registry = newConsulRegistry({ fetch, address: "https://consul.example" })

  await expect(registry.register(background(), instance("initial"))).rejects.toMatchObject({
    code: "LIKEGO_CONSUL_TRANSPORT"
  })
  expect(agent.remoteIds()).toEqual([])
})

test("failed same-backend replacement restores the prior managed record", async () => {
  const agent = fakeAgent()
  agent.failHeartbeat(2, 403)
  const registry = newConsulRegistry({ fetch: agent.fetch, address: "https://consul.example" })
  await registry.register(background(), instance("initial"))

  await expect(registry.register(background(), instance("updated"))).rejects.toMatchObject({
    code: "LIKEGO_CONSUL_HTTP",
    status: 403
  })
  expect(await registry.getService(background(), "orders")).toEqual([instance("initial")])
  await registry.deregister(background(), instance("initial"))
})

test("replacement reports both admission and restoration failures in order", async () => {
  const agent = fakeAgent()
  let heartbeatCalls = 0
  const fetch: ConsulFetch = async function failingReplacement(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname.startsWith("/v1/agent/check/pass/")) {
      heartbeatCalls += 1
      if (heartbeatCalls >= 2) return new Response(null, { status: 403 })
    }
    return agent.fetch(request)
  }
  const registry = newConsulRegistry({ fetch, address: "https://consul.example" })
  await registry.register(background(), instance("initial"))

  const failure: unknown = await registry.register(background(), instance("updated")).catch(
    /** Captures the ordered public rollback failure. */
    function capture(value: unknown): unknown {
      return value
    }
  )
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toHaveLength(2)
  await registry.deregister(background(), instance("initial"))
})

test("private heartbeat reports retryable and terminal failures without borrowing logger control", async () => {
  const retryAgent = fakeAgent()
  const terminalAgent = fakeAgent()
  let retryHeartbeats = 0
  let terminalHeartbeats = 0
  const retryFetch: ConsulFetch = async function failedRetryReadback(input, init) {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    if (path.startsWith("/v1/agent/check/pass/")) {
      retryHeartbeats += 1
      if (retryHeartbeats === 2) return new Response(null, { status: 503 })
    }
    if (path === "/v1/agent/checks" && retryHeartbeats === 2) {
      return new Response(null, { status: 503 })
    }
    return retryAgent.fetch(request)
  }
  const terminalFetch: ConsulFetch = async function terminalHeartbeat(input, init) {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname.startsWith("/v1/agent/check/pass/")) {
      terminalHeartbeats += 1
      if (terminalHeartbeats === 2) return new Response(null, { status: 403 })
    }
    return terminalAgent.fetch(request)
  }
  const levels: string[] = []
  const retryNotifications: Error[] = []
  const terminalNotifications: { readonly error: Error; readonly service: ServiceInstance }[] = []
  const retrying = newConsulRegistry({
    fetch: retryFetch,
    address: "https://consul.example",
    retryInitialMs: 5,
    retryMaximumMs: 10,
    logger: {
      log(level): void {
        levels.push(level)
      }
    },
    onRegistrationError(error): void {
      retryNotifications.push(error)
    }
  })
  const terminal = newConsulRegistry({
    fetch: terminalFetch,
    address: "https://consul.example",
    logger: {
      log(level): void {
        levels.push(level)
        throw new Error("borrowed logger failed")
      }
    },
    onRegistrationError(error, service): Promise<void> {
      terminalNotifications.push({ error, service })
      return Promise.reject(new Error("borrowed terminal observer failed"))
    }
  })
  await Promise.all([
    retrying.register(background(), instance("initial")),
    terminal.register(background(), instance("initial"))
  ])

  await eventually(
    () => levels.includes("warn") && levels.includes("error") && terminalNotifications.length === 1,
    2_500
  )
  expect(retryNotifications).toEqual([])
  expect(terminalNotifications[0]?.error).toMatchObject({
    code: "LIKEGO_CONSUL_HTTP",
    status: 403
  })
  expect(terminalNotifications[0]?.service).toEqual(instance("initial"))
  expect(Object.isFrozen(terminalNotifications[0]?.service)).toBe(true)
  await Promise.all([
    retrying.deregister(background(), instance("initial")),
    terminal.deregister(background(), instance("initial"))
  ])
})

test("a late retryable heartbeat from a retired generation cannot notify its replacement", async () => {
  const agent = fakeAgent()
  const oldHeartbeatStarted = Promise.withResolvers<void>()
  const continueOldHeartbeat = Promise.withResolvers<void>()
  const notifications: ServiceInstance[] = []
  let heartbeatCalls = 0
  let rejectOldReadback = false
  let rejectReplacementHeartbeat = false
  const registry = newConsulRegistry({
    fetch: async function generationFetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const path = new URL(request.url).pathname
      if (path.startsWith("/v1/agent/check/pass/")) {
        heartbeatCalls += 1
        if (heartbeatCalls === 2) {
          oldHeartbeatStarted.resolve()
          await continueOldHeartbeat.promise
          rejectOldReadback = true
          return new Response(null, { status: 503 })
        }
        if (rejectReplacementHeartbeat) return new Response(null, { status: 403 })
      }
      if (path === "/v1/agent/checks" && rejectOldReadback) {
        rejectOldReadback = false
        return new Response(null, { status: 503 })
      }
      return agent.fetch(request)
    },
    address: "https://consul.example",
    retryInitialMs: 2,
    retryMaximumMs: 4,
    onRegistrationError(_error, service): void {
      notifications.push(service)
    }
  })
  await registry.register(background(), instance("initial"))
  await oldHeartbeatStarted.promise

  const replacement = registry.register(background(), instance("updated"))
  expect(notifications).toEqual([])
  continueOldHeartbeat.resolve()
  await replacement
  rejectReplacementHeartbeat = true

  await eventually(() => notifications.length === 1, 2_500)
  expect(notifications).toEqual([instance("updated")])
  await registry.deregister(background(), instance("updated"))
})

test("failed registrations release many distinct identity serializers", async () => {
  const started = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let calls = 0
  const fetch: ConsulFetch = async function rejectedRegistration(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname === "/v1/agent/service/register") {
      calls += 1
      if (calls === 1) {
        started.resolve()
        await proceed.promise
      }
      return new Response(null, { status: 403 })
    }
    return new Response(null, { status: 404 })
  }
  const registrations = newRegistrationManager()
  const options = registrationOptions(fetch)
  const first = registrations.register(background(), instance("failed-0", "orders-0"), options)

  await started.promise
  expect(registrations.identityCount()).toBe(1)
  proceed.resolve()
  await expect(first).rejects.toMatchObject({ code: "LIKEGO_CONSUL_HTTP", status: 403 })
  for (let index = 1; index < 32; index += 1) {
    await expect(
      registrations.register(background(), instance(`failed-${index}`, `orders-${index}`), options)
    ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_HTTP", status: 403 })
  }
  expect(registrations.identityCount()).toBe(0)
})

test("unknown deregistrations release many distinct identity serializers", async () => {
  const agent = fakeAgent()
  const started = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let held = true
  const fetch: ConsulFetch = async function heldDeregistration(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (held && new URL(request.url).pathname.startsWith("/v1/agent/service/deregister/")) {
      held = false
      started.resolve()
      await proceed.promise
    }
    return agent.fetch(request)
  }
  const registrations = newRegistrationManager()
  const options = registrationOptions(fetch)
  const first = registrations.deregister(background(), instance("unknown-0", "orders-0"), options)

  await started.promise
  expect(registrations.identityCount()).toBe(1)
  proceed.resolve()
  await first
  for (let index = 1; index < 32; index += 1) {
    await registrations.deregister(
      background(),
      instance(`unknown-${index}`, `orders-${index}`),
      options
    )
  }
  expect(registrations.identityCount()).toBe(0)
})

test("successful registration churn releases every identity serializer", async () => {
  const agent = fakeAgent()
  const registrations = newRegistrationManager()
  const options = registrationOptions(agent.fetch)

  for (let index = 0; index < 32; index += 1) {
    const value = instance(`churn-${index}`, `orders-${index}`)
    await registrations.register(background(), value, options)
    if (index === 0) expect(registrations.identityCount()).toBe(1)
    await registrations.deregister(background(), value, options)
  }
  expect(agent.remoteIds()).toEqual([])
  expect(registrations.identityCount()).toBe(0)
})

test("queued same-identity replacement preserves rollback, FIFO, and generation ownership", async () => {
  const agent = fakeAgent()
  const deregisterStarted = Promise.withResolvers<void>()
  const continueDeregister = Promise.withResolvers<void>()
  let holdDeregister = false
  const fetch: ConsulFetch = async function gatedDeregistration(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (
      holdDeregister &&
      new URL(request.url).pathname.startsWith("/v1/agent/service/deregister/")
    ) {
      holdDeregister = false
      deregisterStarted.resolve()
      await continueDeregister.promise
    }
    return agent.fetch(request)
  }
  const registrations = newRegistrationManager()
  const options = registrationOptions(fetch)
  agent.failHeartbeat(2, 403)
  await registrations.register(background(), instance("initial"), options)
  const remoteId = agent.remoteIds()[0]
  if (remoteId === undefined) throw new Error("fake Agent omitted the registered remote ID")
  expect(registrations.identityCount()).toBe(1)

  await expect(
    registrations.register(background(), instance("updated"), options)
  ).rejects.toMatchObject({ code: "LIKEGO_CONSUL_HTTP", status: 403 })
  expect(agent.service(remoteId)?.Port).toBe(8080)

  holdDeregister = true
  const deregistration = registrations.deregister(background(), instance("initial"), options)
  await deregisterStarted.promise
  const replacement = registrations.register(background(), instance("updated"), options)
  expect(agent.service(remoteId)?.Port).toBe(8080)
  expect(registrations.identityCount()).toBe(1)

  continueDeregister.resolve()
  await Promise.all([deregistration, replacement])
  expect(agent.service(remoteId)?.Port).toBe(8081)
  expect(registrations.identityCount()).toBe(1)
  expect(
    agent.mutations.map(function kind(mutation): string {
      return mutation.slice(0, mutation.indexOf(":"))
    })
  ).toEqual(["register", "pass", "register", "register", "pass", "deregister", "register", "pass"])

  await registrations.deregister(background(), instance("updated"), options)
  expect(registrations.identityCount()).toBe(0)
})
