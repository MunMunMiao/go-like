import type { Transport } from ".."

/** Implements the provider-neutral Transport SPI inside one explicit process-local namespace. */
export interface MemoryTransport extends Transport {
  /** Returns the stable provider kind. */
  kind(): "memory"
}
