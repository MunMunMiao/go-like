import type { Context } from "@likego/context"
import type { Handler } from "@likego/web"

import { newFulfillmentHandler } from "./http"
import { newFulfillmentWorker, type FulfillmentWorker } from "./worker"

export type FulfillmentStage =
  | "placed"
  | "inventoryReserved"
  | "paymentCaptured"
  | "shipped"
  | "canceled"

export type FulfillmentAction = "reserveInventory" | "capturePayment" | "ship" | "cancel"

export interface FulfillmentOrder {
  readonly orderId: string
  readonly stage: FulfillmentStage
}

export interface FulfillmentCommand {
  readonly eventId: string
  readonly orderId: string
  readonly action: FulfillmentAction
}

export interface FulfillmentRepository {
  apply(ctx: Context, command: FulfillmentCommand): FulfillmentOrder
  get(ctx: Context, orderId: string): FulfillmentOrder | null
}

export type ApplyFulfillmentEvent = (ctx: Context, command: FulfillmentCommand) => FulfillmentOrder

export interface MarketplaceFulfillmentService {
  readonly handler: Handler
  readonly worker: FulfillmentWorker
}

interface ProcessedEvent {
  readonly command: FulfillmentCommand
  readonly result: FulfillmentOrder
}

const transitions: Readonly<
  Record<FulfillmentStage, Partial<Record<FulfillmentAction, FulfillmentStage>>>
> = Object.freeze({
  placed: Object.freeze({ reserveInventory: "inventoryReserved", cancel: "canceled" }),
  inventoryReserved: Object.freeze({ capturePayment: "paymentCaptured", cancel: "canceled" }),
  paymentCaptured: Object.freeze({ ship: "shipped", cancel: "canceled" }),
  shipped: Object.freeze({}),
  canceled: Object.freeze({})
})

/** Applies one legal fulfillment transition without mutating the prior order snapshot. */
export function transitionOrder(
  order: FulfillmentOrder,
  action: FulfillmentAction
): FulfillmentOrder {
  const stage = transitions[order.stage][action]
  if (stage === undefined) throw new Error(`cannot ${action} from ${order.stage}`)
  return Object.freeze({ orderId: order.orderId, stage })
}

/** Validates stable command identities before an event reaches storage. */
export function validateFulfillmentCommand(command: FulfillmentCommand): void {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
  if (!identifier.test(command.eventId)) throw new TypeError("invalid eventId")
  if (!identifier.test(command.orderId)) throw new TypeError("invalid orderId")
}

/** Creates a deterministic event repository with idempotency and transition checks. */
export function newMemoryFulfillmentRepository(): FulfillmentRepository {
  const orders = new Map<string, FulfillmentOrder>()
  const events = new Map<string, ProcessedEvent>()

  return Object.freeze({
    apply(ctx: Context, command: FulfillmentCommand): FulfillmentOrder {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const processed = events.get(command.eventId)
      if (processed !== undefined) {
        if (
          processed.command.orderId !== command.orderId ||
          processed.command.action !== command.action
        ) {
          throw new Error("event identity conflict")
        }
        return processed.result
      }
      const initial: FulfillmentOrder = Object.freeze({
        orderId: command.orderId,
        stage: "placed"
      })
      const current = orders.get(command.orderId) ?? initial
      const result = transitionOrder(current, command.action)
      orders.set(command.orderId, result)
      events.set(command.eventId, Object.freeze({ command, result }))
      return result
    },
    get(ctx: Context, orderId: string): FulfillmentOrder | null {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return orders.get(orderId) ?? null
    }
  })
}

/** Creates the command handler for the order fulfillment state machine. */
export function newApplyFulfillmentEvent(repository: FulfillmentRepository): ApplyFulfillmentEvent {
  return function applyFulfillmentEvent(
    ctx: Context,
    command: FulfillmentCommand
  ): FulfillmentOrder {
    validateFulfillmentCommand(command)
    return repository.apply(ctx, command)
  }
}

/** Composes the fulfillment handler with its structural worker resource. */
export function newMarketplaceFulfillmentService(): MarketplaceFulfillmentService {
  const worker = newFulfillmentWorker(newMemoryFulfillmentRepository())
  return Object.freeze({
    handler: newFulfillmentHandler(newApplyFulfillmentEvent(worker)),
    worker
  })
}
