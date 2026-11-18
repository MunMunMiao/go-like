import { SQL } from "bun"

import { newResourceServer, type Server } from "@go-like/core/lifecycle"
import type { NatsConnection } from "@nats-io/transport-node"

/** Closes the application-owned SQL pool after every server has stopped. */
export function newLedgerDatabaseResource(sql: SQL): Server {
  return newResourceServer({
    close: async () => {
      await sql.close({ timeout: 5 })
    }
  })
}

/**
 * Admits the application-owned NATS connection into the resource tier.
 * An unexpected close fails the App. Stop drains the connection once.
 */
export function newLedgerNatsResource(connection: NatsConnection): Server {
  return newResourceServer({
    terminal: connection.closed(),
    close: async () => {
      if (!connection.isClosed()) await connection.drain()
    }
  })
}
