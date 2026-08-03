import { background } from "@likego/context"
import { describe, expect, test } from "bun:test"

import { newNotificationEvents } from "../src/events"
import { newNotificationHandler } from "../src/http"
import { newMemoryNotificationProvider } from "../src/provider"
import { newDeliverNotification } from "../src/service"

describe("notification delivery", () => {
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
})
