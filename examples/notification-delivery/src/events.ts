import { newBrokerServer } from "@likego/broker"
import { newMemoryBroker } from "@likego/broker-memory"
import type { Context } from "@likego/context"
import type { Server } from "@likego/core"
import { eventBroker, type Codec } from "@likego/event"
import type { Store } from "@likego/store"
import { newMemoryStore } from "@likego/store-memory"

import type { DeliveryReceipt } from "./service"

export const notificationAcceptedTopic = "notification.accepted.v1"

export interface NotificationEvents {
  readonly server: Server
  publish(ctx: Context, receipt: DeliveryReceipt): Promise<void>
  receipt(ctx: Context, messageId: string): Promise<DeliveryReceipt | null>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Validates one internally decoded accepted-notification event. */
function receiptFrom(value: unknown): DeliveryReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid notification event")
  }
  const messageId = Reflect.get(value, "messageId")
  const channel = Reflect.get(value, "channel")
  const providerReference = Reflect.get(value, "providerReference")
  const status = Reflect.get(value, "status")
  if (
    typeof messageId !== "string" ||
    (channel !== "email" && channel !== "sms") ||
    typeof providerReference !== "string" ||
    status !== "accepted"
  ) {
    throw new TypeError("invalid notification event")
  }
  return Object.freeze({ messageId, channel, providerReference, status })
}

const receiptCodec: Codec<DeliveryReceipt> = Object.freeze({
  mediaType: "application/json",
  encode(receipt: DeliveryReceipt): Uint8Array {
    return encoder.encode(JSON.stringify(receipt))
  },
  decode(bytes: Uint8Array): DeliveryReceipt {
    return receiptFrom(JSON.parse(decoder.decode(bytes)))
  }
})

/** Stores one accepted receipt as the queryable process-local event projection. */
async function projectReceipt(ctx: Context, store: Store, receipt: DeliveryReceipt): Promise<void> {
  await store.write(ctx, {
    key: `notifications/${receipt.messageId}`,
    value: receiptCodec.encode(receipt),
    metadata: Object.freeze({ channel: receipt.channel })
  })
}

/** Composes typed events, a process-local Broker and a process-local Store projection. */
export function newNotificationEvents(): NotificationEvents {
  const broker = eventBroker(newMemoryBroker(), receiptCodec)
  const store = newMemoryStore()
  const subscription = newBrokerServer(
    broker,
    notificationAcceptedTopic,
    async (ctx, event): Promise<void> => {
      await projectReceipt(ctx, store, event.decode())
    }
  )
  return Object.freeze({
    server: subscription,
    async publish(ctx: Context, receipt: DeliveryReceipt): Promise<void> {
      await broker.publish(ctx, notificationAcceptedTopic, receipt)
    },
    async receipt(ctx: Context, messageId: string): Promise<DeliveryReceipt | null> {
      const record = await store.read(ctx, `notifications/${messageId}`)
      return record === null ? null : receiptCodec.decode(record.value)
    }
  })
}
