import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"

import type {
  DeliverNotification,
  DeliverNotificationCommand,
  NotificationChannel
} from "./service"

/** Decodes one untrusted notification delivery request. */
function notificationFrom(value: unknown): DeliverNotificationCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid notification request")
  }
  const messageId = Reflect.get(value, "messageId")
  const channel = Reflect.get(value, "channel")
  const destination = Reflect.get(value, "destination")
  const body = Reflect.get(value, "body")
  if (
    typeof messageId !== "string" ||
    (channel !== "email" && channel !== "sms") ||
    typeof destination !== "string" ||
    typeof body !== "string"
  ) {
    throw new TypeError("invalid notification request")
  }
  const selectedChannel: NotificationChannel = channel
  return Object.freeze({
    messageId,
    channel: selectedChannel,
    destination,
    body
  })
}

/** Creates the standard Fetch endpoint for notification delivery. */
export function newNotificationHandler(deliver: DeliverNotification): Handler {
  return contextHandler(async function notificationHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/v1/notifications/deliver"
    ) {
      return Response.json({ code: "not_found" }, { status: 404 })
    }
    try {
      return Response.json(await deliver(ctx, notificationFrom(await request.json())), {
        status: 202
      })
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return Response.json({ code: "invalid_notification" }, { status: 400 })
      }
      const message = error instanceof Error ? error.message : "notification delivery failed"
      const status = message.includes("already used") ? 409 : 503
      return Response.json({ code: "notification_delivery_rejected", message }, { status })
    }
  })
}
