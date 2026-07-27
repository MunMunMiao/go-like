import type { Transport } from "@likego/transport"

/** Implements the provider-neutral Transport SPI inside one explicit process-local namespace. */
export interface MemoryTransport extends Transport {
  /** Returns the stable provider kind. */
  kind(): "memory"
}
