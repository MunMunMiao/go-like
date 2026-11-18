import { background } from "@go-like/core/context"
import { info, type LogHandler } from "@go-like/core/log"
import { name, newApp, server, telemetry } from "@go-like/core"
import { newTelemetry } from "@go-like/core/telemetry"
import { isStructError } from "@go-like/core/struct"
import { describe, expect, test } from "bun:test"

import { newNotificationEvents, notificationReceiptCodec } from "../src/events"
import { newNotificationHandler } from "../src/http"
import { newMemoryNotificationProvider } from "../src/provider"
import { newDeliverNotification, validateNotification } from "../src/service"

describe("notification delivery", () => {
  test("round-trips the JSON receipt and rejects a bad payload", () => {
    const receipt = Object.freeze({
      messageId: "wire-1",
      channel: "sms" as const,
      providerReference: "provider-wire-1",
      status: "accepted" as const
    })
    const bytes = notificationReceiptCodec.encode(receipt)
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(receipt)
    expect(notificationReceiptCodec.decode(bytes)).toEqual(receipt)
    expect(notificationReceiptCodec.mediaType).toBe("application/json")
    let rejected: unknown
    try {
      notificationReceiptCodec.decode(
        new TextEncoder().encode(
          '{"messageId":"wire-1","channel":"push","providerReference":"provider-wire-1","status":"accepted"}'
        )
      )
    } catch (error) {
      rejected = error
    }
    expect(isStructError(rejected)).toBe(true)
  })

  test("the App installs telemetry and shuts it down", async () => {
    const events: string[] = []
    const handler: LogHandler = {
      enabled: () => true,
      handle(_ctx, record) {
        events.push(record.message)
      },
      lifecycle: {
        async start() {
          events.push("telemetry.start")
        },
        async stop() {
          events.push("telemetry.stop")
        }
      }
    }
    const app = newApp(
      name("notification-delivery"),
      telemetry(newTelemetry({ logHandlers: [handler] })),
      server({
        async start(ctx) {
          info(ctx, "handler-installed")
        },
        async stop() {}
      })
    )
    const running = app.run()
    void running.catch(() => {})
    const deadline = Date.now() + 1_000
    while (!events.includes("handler-installed")) {
      if (Date.now() > deadline) throw new Error(`telemetry was not installed: ${events.join(",")}`)
      await Bun.sleep(5)
    }
    expect(events.indexOf("handler-installed")).toBeGreaterThan(events.indexOf("telemetry.start"))
    await app.stop()
    await running
    expect(events.indexOf("telemetry.stop")).toBeGreaterThan(events.indexOf("handler-installed"))
  })

  test("publishes a typed accepted event into the memory Store projection", async () => {
    const events = newNotificationEvents()
    const running = events.server.start(background())
    void running.catch(() => {})
    await Bun.sleep(0)
    const receipt = Object.freeze({
      messageId: "event-1",
      channel: "email" as const,
      providerReference: "provider-event-1",
      status: "accepted" as const
    })
    try {
      await events.publish(background(), receipt)
      expect(await events.receipt(background(), receipt.messageId)).toEqual(receipt)
    } finally {
      await events.server.stop(background())
      await running
    }
  })

  test("retries transient provider failures within the fixed bound", async () => {
    const provider = newMemoryNotificationProvider([
      { messageId: "message-retry", failuresBeforeSuccess: 2 }
    ])
    const deliver = newDeliverNotification(provider)
    await expect(
      deliver(background(), {
        messageId: "message-retry",
        channel: "email",
        destination: "ops@example.test",
        body: "alarm"
      })
    ).resolves.toMatchObject({ status: "accepted" })
    expect(provider.attemptCount(background(), "message-retry")).toBe(3)
  })

  test("returns one receipt for exact replay and rejects changed content", async () => {
    const provider = newMemoryNotificationProvider()
    const deliver = newDeliverNotification(provider)
    const command = Object.freeze({
      messageId: "message-stable",
      channel: "sms",
      destination: "+8613800138000",
      body: "ready"
    })
    const first = await deliver(background(), command)
    expect(await deliver(background(), command)).toEqual(first)
    expect(provider.attemptCount(background(), "message-stable")).toBe(1)
    await expect(
      deliver(background(), {
        messageId: "message-stable",
        channel: "sms",
        destination: "+8613800138000",
        body: "changed"
      })
    ).rejects.toThrow("messageId already used by different notification")
  })

  test("opens the circuit after two bounded terminal deliveries", async () => {
    const provider = newMemoryNotificationProvider([
      { messageId: "message-fail-a", failuresBeforeSuccess: 10 },
      { messageId: "message-fail-b", failuresBeforeSuccess: 10 }
    ])
    const deliver = newDeliverNotification(provider)
    await expect(
      deliver(background(), {
        messageId: "message-fail-a",
        channel: "email",
        destination: "a@example.test",
        body: "a"
      })
    ).rejects.toThrow("transient provider failure")
    await expect(
      deliver(background(), {
        messageId: "message-fail-b",
        channel: "email",
        destination: "b@example.test",
        body: "b"
      })
    ).rejects.toThrow("transient provider failure")
    await expect(
      deliver(background(), {
        messageId: "message-blocked",
        channel: "email",
        destination: "c@example.test",
        body: "c"
      })
    ).rejects.toThrow("circuit breaker is open")
    expect(provider.attemptCount(background(), "message-fail-a")).toBe(3)
    expect(provider.attemptCount(background(), "message-fail-b")).toBe(3)
    expect(provider.attemptCount(background(), "message-blocked")).toBe(0)
  })

  test("rejects an invalid destination before provider access", async () => {
    expect(() =>
      newMemoryNotificationProvider([{ messageId: "invalid-plan", failuresBeforeSuccess: -1 }])
    ).toThrow("failuresBeforeSuccess must be a non-negative safe integer")
    const provider = newMemoryNotificationProvider()
    const deliver = newDeliverNotification(provider)
    await expect(
      deliver(background(), {
        messageId: "message-invalid",
        channel: "email",
        destination: "not-an-email",
        body: "alert"
      })
    ).rejects.toThrow("invalid notification destination")
    expect(provider.attemptCount(background(), "message-invalid")).toBe(0)
  })

  test("serves accepted delivery through a standard Fetch handler", async () => {
    const handler = newNotificationHandler(newDeliverNotification(newMemoryNotificationProvider()))
    const response = await handler(
      new Request("https://example.test/v1/notifications/deliver", {
        method: "POST",
        body: JSON.stringify({
          messageId: "message-http",
          channel: "email",
          destination: "ops@example.test",
          body: "incident opened"
        })
      })
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      messageId: "message-http",
      status: "accepted"
    })
  })

  test("covers event projection misses, decoder rejection and channel validation", async () => {
    const events = newNotificationEvents()
    expect(await events.receipt(background(), "missing")).toBeNull()
    const running = events.server.start(background())
    void running.catch(() => {})
    await Bun.sleep(0)
    try {
      await expect(
        events.publish(background(), {
          messageId: "event-invalid",
          channel: "email",
          providerReference: "provider-event-invalid",
          status: "accepted"
        })
      ).resolves.toBeUndefined()
      expect(await events.receipt(background(), "event-invalid")).toMatchObject({
        messageId: "event-invalid"
      })
    } finally {
      await events.server.stop(background())
      await running
    }

    const nullEvents = newNotificationEvents()
    const nullRunning = nullEvents.server.start(background())
    void nullRunning.catch(() => {})
    await Bun.sleep(0)
    await expect(nullEvents.publish(background(), null as never)).rejects.toThrow(TypeError)
    await nullEvents.server.stop(background())
    await nullRunning

    const brokenEvents = newNotificationEvents()
    const brokenRunning = brokenEvents.server.start(background())
    void brokenRunning.catch(() => {})
    await Bun.sleep(0)
    const published = await brokenEvents
      .publish(background(), { messageId: "bad", channel: "push" } as never)
      .then(
        () => null,
        (error: unknown) => error
      )
    expect(
      isStructError(published) || (published instanceof Error && isStructError(published.cause))
    ).toBe(true)
    const stopped = await brokenRunning.then(
      () => null,
      (error: unknown) => error
    )
    expect(
      isStructError(stopped) || (stopped instanceof Error && isStructError(stopped.cause))
    ).toBe(true)
    await brokenEvents.server.stop(background()).catch(() => {})

    expect(() =>
      validateNotification({
        messageId: "bad id",
        channel: "email",
        destination: "ops@example.test",
        body: "alert"
      })
    ).toThrow("invalid messageId")
    expect(() =>
      validateNotification({
        messageId: "message-channel",
        channel: "email",
        destination: "ops@example.test",
        body: ""
      })
    ).toThrow("body must contain")
    expect(() =>
      validateNotification({
        messageId: "message-sms",
        channel: "sms",
        destination: "+8613800138000",
        body: "alert"
      })
    ).not.toThrow()
    expect(() =>
      validateNotification({
        messageId: "message-sms-bad",
        channel: "sms",
        destination: "123",
        body: "alert"
      })
    ).toThrow("invalid notification destination")
  })

  test("maps notification HTTP request and delivery failures", async () => {
    const handler = newNotificationHandler(newDeliverNotification(newMemoryNotificationProvider()))
    const notFound = await handler(new Request("https://example.test/other"))
    expect(notFound.status).toBe(404)
    const invalid = await handler(
      new Request("https://example.test/v1/notifications/deliver", {
        method: "POST",
        body: JSON.stringify({ messageId: "bad" })
      })
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: "invalid_notification" })
    const invalidArray = await handler(
      new Request("https://example.test/v1/notifications/deliver", {
        method: "POST",
        body: JSON.stringify([])
      })
    )
    expect(invalidArray.status).toBe(400)
    expect(await invalidArray.json()).toMatchObject({ code: "invalid_notification" })
    expect(() =>
      validateNotification({
        messageId: "message-unsupported",
        channel: "push",
        destination: "ops@example.test",
        body: "alert"
      } as never)
    ).toThrow("unsupported notification channel")

    const rejectingProvider = Object.freeze({
      send: async () => {
        throw new Error("provider unavailable")
      },
      attemptCount: () => 0
    })
    const rejected = await newNotificationHandler(newDeliverNotification(rejectingProvider))(
      new Request("https://example.test/v1/notifications/deliver", {
        method: "POST",
        body: JSON.stringify({
          messageId: "message-provider",
          channel: "email",
          destination: "ops@example.test",
          body: "alert"
        })
      })
    )
    expect(rejected.status).toBe(503)
    expect(await rejected.json()).toMatchObject({
      code: "notification_delivery_rejected",
      message: "provider unavailable"
    })
  })
})
