import type { Context } from "@likego/context"
import { newCircuitBreaker, retry } from "@likego/resilience"
import type { NotificationProvider } from "./provider"

const publicId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const emailDestination = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const smsDestination = /^\+[1-9]\d{7,14}$/

export type NotificationChannel = "email" | "sms"

export interface DeliverNotificationCommand {
  readonly messageId: string
  readonly channel: NotificationChannel
  readonly destination: string
  readonly body: string
}

export interface DeliveryReceipt {
  readonly messageId: string
  readonly channel: NotificationChannel
  readonly providerReference: string
  readonly status: "accepted"
}

/** Validates one notification before any provider or resilience operation. */
export function validateNotification(command: DeliverNotificationCommand): void {
  if (!publicId.test(command.messageId)) throw new TypeError("invalid messageId")
  if (command.channel !== "email" && command.channel !== "sms") {
    throw new TypeError("unsupported notification channel")
  }
  const validDestination =
    command.channel === "email"
      ? emailDestination.test(command.destination)
      : smsDestination.test(command.destination)
  if (!validDestination) throw new TypeError("invalid notification destination")
  if (command.body.length < 1 || command.body.length > 1_000) {
    throw new RangeError("body must contain between 1 and 1000 characters")
  }
}

export type DeliverNotification = (
  ctx: Context,
  command: DeliverNotificationCommand
) => Promise<DeliveryReceipt>

/** Identifies the only provider failure that is safe and useful to retry. */
function isTransientProviderFailure(failure: unknown): boolean {
  return failure instanceof Error && failure.message === "transient provider failure"
}

/** Creates bounded, idempotent notification delivery with a consecutive-failure breaker. */
export function newDeliverNotification(provider: NotificationProvider): DeliverNotification {
  const breaker = newCircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 60_000
  })
  return async function deliverNotification(
    ctx: Context,
    command: DeliverNotificationCommand
  ): Promise<DeliveryReceipt> {
    validateNotification(command)
    return breaker.execute(ctx, async (breakerCtx) => {
      return retry(breakerCtx, async (attemptCtx) => provider.send(attemptCtx, command), {
        authorization: "idempotent",
        maxAttempts: 3,
        shouldRetry: (_retryCtx, failure) => isTransientProviderFailure(failure)
      })
    })
  }
}
