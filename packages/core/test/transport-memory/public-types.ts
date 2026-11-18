import type { Context } from "../../src/context"
import type { Transport } from "../../src/transport"

import { newMemoryTransport, type MemoryTransport } from "../../src/transport/memory/index"

declare const ctx: Context
const memory: MemoryTransport = newMemoryTransport()
const transport: Transport = memory
const kind: "memory" = memory.kind()
const listener = memory.listen(ctx, "memory://orders")
const client = memory.dial(ctx, "memory://orders")

void [client, kind, listener, transport]

// @ts-expect-error Memory Transport construction does not accept hidden global state.
newMemoryTransport({ listeners: new Map() })
