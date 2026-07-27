import { newClient, withAddress, withTransport } from "@likego/client"
import type { Context } from "@likego/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@likego/server"
import type { Message } from "@likego/transport"
import { newMemoryTransport } from "@likego/transport-memory"

import type {
  ProvisionedService,
  ProvisionServiceCommand,
  ProvisionTelecomService,
  TelecomPlan
} from "./service"

const serviceAddress = "memory://telecom-service-provisioning"
const serviceName = "telecom-provisioning"
const endpointName = "Provisioning.Activate"
const mediaType = "application/json"

export interface TelecomProvisioningClient {
  provision(ctx: Context, command: ProvisionServiceCommand): Promise<ProvisionedService>
}

export interface TelecomProvisioningMicroservice {
  readonly server: Server
  readonly client: TelecomProvisioningClient
}

/** Decodes one internal command message and validates its carrier shape. */
function decodeCommand(bytes: Uint8Array): ProvisionServiceCommand {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid provisioning command")
  }
  const orderId = Reflect.get(value, "orderId")
  const subscriberId = Reflect.get(value, "subscriberId")
  const simId = Reflect.get(value, "simId")
  const plan = Reflect.get(value, "plan")
  if (
    typeof orderId !== "string" ||
    typeof subscriberId !== "string" ||
    typeof simId !== "string" ||
    (plan !== "mobile-basic" && plan !== "mobile-premium")
  ) {
    throw new TypeError("invalid provisioning command")
  }
  const selectedPlan: TelecomPlan = plan
  return Object.freeze({ orderId, subscriberId, simId, plan: selectedPlan })
}

/** Encodes one internal JSON message. */
function encodeMessage(value: object): Message {
  return Object.freeze({
    header: Object.freeze({ "Content-Type": mediaType }),
    body: new TextEncoder().encode(JSON.stringify(value))
  })
}

/** Decodes the trusted service response while still enforcing its runtime shape. */
function decodeService(bytes: Uint8Array): ProvisionedService {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const command = decodeCommand(bytes)
  if (value === null || typeof value !== "object") throw new TypeError("invalid service response")
  const monthlyFeeMinor = Reflect.get(value, "monthlyFeeMinor")
  const status = Reflect.get(value, "status")
  if (
    typeof monthlyFeeMinor !== "number" ||
    !Number.isSafeInteger(monthlyFeeMinor) ||
    status !== "active"
  ) {
    throw new TypeError("invalid service response")
  }
  return Object.freeze({
    orderId: command.orderId,
    subscriberId: command.subscriberId,
    simId: command.simId,
    plan: command.plan,
    monthlyFeeMinor,
    status
  })
}

/** Composes an internal unary telecom service over the real Memory Transport provider. */
export function newTelecomProvisioningMicroservice(
  provision: ProvisionTelecomService
): TelecomProvisioningMicroservice {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  return Object.freeze({
    server: newServer(
      serverTransport(transport),
      address(serviceAddress),
      handler(
        serviceName,
        endpointName,
        async function provisionService(ctx: Context, message: Message): Promise<Message> {
          return encodeMessage(await provision(ctx, decodeCommand(message.body)))
        }
      )
    ),
    client: Object.freeze({
      async provision(ctx: Context, command: ProvisionServiceCommand): Promise<ProvisionedService> {
        const response = await client.call(
          ctx,
          {
            service: serviceName,
            endpoint: endpointName,
            message: encodeMessage(command)
          },
          withAddress(serviceAddress)
        )
        return decodeService(response.body)
      }
    })
  })
}
