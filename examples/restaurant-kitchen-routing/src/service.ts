import type { Context } from "@go-like/context"
import type { KitchenRoutingStore } from "./routing"

const publicId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export type KitchenStation = "fryer" | "grill" | "pastry"

export interface RouteKitchenTicketCommand {
  readonly ticketId: string
  readonly station: KitchenStation
  readonly itemCount: number
}

export interface KitchenAssignment {
  readonly ticketId: string
  readonly station: KitchenStation
  readonly kitchenEndpoint: string
}

/** Validates one kitchen routing command before infrastructure selection. */
export function validateKitchenTicket(command: RouteKitchenTicketCommand): void {
  if (!publicId.test(command.ticketId)) throw new TypeError("invalid ticketId")
  if (command.station !== "fryer" && command.station !== "grill" && command.station !== "pastry") {
    throw new TypeError("invalid kitchen station")
  }
  if (!Number.isSafeInteger(command.itemCount) || command.itemCount < 1 || command.itemCount > 50) {
    throw new RangeError("itemCount must be an integer between 1 and 50")
  }
}

export type RouteKitchenTicket = (
  ctx: Context,
  command: RouteKitchenTicketCommand
) => Promise<KitchenAssignment>

/** Creates the Context-first kitchen routing use case. */
export function newRouteKitchenTicket(store: KitchenRoutingStore): RouteKitchenTicket {
  return async function routeKitchenTicket(
    ctx: Context,
    command: RouteKitchenTicketCommand
  ): Promise<KitchenAssignment> {
    validateKitchenTicket(command)
    return store.route(ctx, command)
  }
}
