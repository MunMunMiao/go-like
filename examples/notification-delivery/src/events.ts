import { eventBroker, newBrokerServer } from "@go-like/core/broker"
import { newMemoryBroker } from "@go-like/core/broker/memory"
import type { Context } from "@go-like/core/context"
import type { Server } from "@go-like/core/lifecycle"
import type { Store } from "@go-like/core/store"
import { newMemoryStore } from "@go-like/core/store/memory"
import { jsonCodec, struct } from "@go-like/core/struct"

import type { DeliveryReceipt } from "./service"

export const notificationAcceptedTopic = "notification.accepted.v1"

export interface NotificationEvents {
  readonly server: Server
  publish(ctx: Context, receipt: DeliveryReceipt): Promise<void>
  receipt(ctx: Context, messageId: string): Promise<DeliveryReceipt | null>
}

/** JSON wire codec for one accepted delivery receipt. */
export const notificationReceiptCodec = jsonCodec(
  struct.object({
    messageId: struct.string(),
    channel: struct.enum(["email", "sms"]),
    providerReference: struct.string(),
    status: struct.literal("accepted")
  })
)

/** Stores one accepted receipt as the queryable process-local event projection. */
async function projectReceipt(ctx: Context, store: Store, receipt: DeliveryReceipt): Promise<void> {
  await store.write(ctx, {
    key: `notifications/${receipt.messageId}`,
    value: notificationReceiptCodec.encode(receipt),
    metadata: Object.freeze({ channel: receipt.channel })
  })
}

/** Composes typed events, a process-local Broker and a process-local Store projection. */
export function newNotificationEvents(): NotificationEvents {
  const broker = eventBroker(newMemoryBroker(), notificationReceiptCodec)
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
      return record === null ? null : notificationReceiptCodec.decode(record.value)
    }
  })
}
