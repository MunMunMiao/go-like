import { background } from "@go-like/context"

import type { OrderServiceClient } from "./.artifacts/gen/order/v1/order_like.js"

declare const client: OrderServiceClient

// @ts-expect-error proto string fields reject number inputs
void client.getOrder(background(), { id: 123 })
