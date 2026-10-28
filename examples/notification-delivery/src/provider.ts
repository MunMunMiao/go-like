import type { Context } from "@go-like/context"

import type { DeliverNotificationCommand, DeliveryReceipt } from "./service"

export interface ProviderFailurePlan {
  readonly messageId: string
  readonly failuresBeforeSuccess: number
}

export interface NotificationProvider {
  send(ctx: Context, command: DeliverNotificationCommand): Promise<DeliveryReceipt>
  attemptCount(ctx: Context, messageId: string): number
}

interface DeliveredNotification {
  readonly command: DeliverNotificationCommand
  readonly receipt: DeliveryReceipt
}

/** Compares all identity-bearing notification fields for an idempotent replay. */
function sameNotification(
  left: DeliverNotificationCommand,
  right: DeliverNotificationCommand
): boolean {
  return (
    left.messageId === right.messageId &&
    left.channel === right.channel &&
    left.destination === right.destination &&
    left.body === right.body
  )
}

/** Creates an idempotent in-memory provider with deterministic transient failures. */
export function newMemoryNotificationProvider(
  plans: readonly ProviderFailurePlan[] = Object.freeze([])
): NotificationProvider {
  const remainingFailures = new Map<string, number>()
  const attempts = new Map<string, number>()
  const delivered = new Map<string, DeliveredNotification>()
  for (const plan of plans) {
    if (!Number.isSafeInteger(plan.failuresBeforeSuccess) || plan.failuresBeforeSuccess < 0) {
      throw new RangeError("failuresBeforeSuccess must be a non-negative safe integer")
    }
    remainingFailures.set(plan.messageId, plan.failuresBeforeSuccess)
  }

  return Object.freeze({
    async send(ctx: Context, command: DeliverNotificationCommand): Promise<DeliveryReceipt> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const current = delivered.get(command.messageId)
      if (current !== undefined) {
        if (!sameNotification(current.command, command)) {
          throw new Error("messageId already used by different notification")
        }
        return current.receipt
      }
      attempts.set(command.messageId, (attempts.get(command.messageId) ?? 0) + 1)
      const remaining = remainingFailures.get(command.messageId) ?? 0
      if (remaining > 0) {
        remainingFailures.set(command.messageId, remaining - 1)
        throw new Error("transient provider failure")
      }
      const stableCommand: DeliverNotificationCommand = Object.freeze({
        messageId: command.messageId,
        channel: command.channel,
        destination: command.destination,
        body: command.body
      })
      const receipt: DeliveryReceipt = Object.freeze({
        messageId: command.messageId,
        channel: command.channel,
        providerReference: `provider-${command.messageId}`,
        status: "accepted"
      })
      delivered.set(command.messageId, Object.freeze({ command: stableCommand, receipt }))
      return receipt
    },
    attemptCount(ctx: Context, messageId: string): number {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return attempts.get(messageId) ?? 0
    }
  })
}
