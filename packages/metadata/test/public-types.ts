import type { Context } from "@likego/context"

import {
  append,
  appendToClientContext,
  fromClientContext,
  fromServerContext,
  clone,
  get,
  keys,
  merge,
  mergeToClientContext,
  newClientContext,
  newMetadata,
  newServerContext,
  propagateToClientContext,
  remove,
  set,
  values,
  type Metadata,
  type MetadataInput,
  type MetadataValue,
  type PropagationOptions
} from "../src/index"

declare const ctx: Context
const input: MetadataInput = { trace: ["one", "two"] }
const value: MetadataValue = "three"
const metadata: Metadata = newMetadata(input)
const copied: Metadata = clone(metadata)
const appended: Metadata = append(metadata, "trace", value)
const replaced: Metadata = set(metadata, "trace", "replacement")
const removed: Metadata = remove(metadata, "trace")
const merged: Metadata = merge(metadata, copied)
const first: string | null = get(metadata, "trace")
const all: readonly string[] = values(metadata, "trace")
const names: readonly string[] = keys(metadata)
const clientContext: Context = newClientContext(ctx, metadata)
const appendedClientContext: Context = appendToClientContext(ctx, "trace", "one", "tenant", "a")
const mergedClientContext: Context = mergeToClientContext(ctx, metadata)
const client: Metadata | null = fromClientContext(ctx)
const serverContext: Context = newServerContext(ctx, metadata)
const server: Metadata | null = fromServerContext(ctx)
const propagationOptions: PropagationOptions = {
  exact: ["trace-id"],
  prefix: ["x-baggage-"]
}
const propagatedContext: Context = propagateToClientContext(ctx, propagationOptions)

void [
  appended,
  appendedClientContext,
  all,
  client,
  clientContext,
  copied,
  first,
  merged,
  mergedClientContext,
  metadata,
  names,
  removed,
  replaced,
  server,
  serverContext,
  propagatedContext
]

// @ts-expect-error Metadata values must be strings or string arrays.
newMetadata({ invalid: 1 })
// @ts-expect-error Context must be the first argument.
newClientContext(metadata, ctx)
// @ts-expect-error Context key/value pairs must be strings.
appendToClientContext(ctx, "trace", 1)
// @ts-expect-error Exact propagation rules must be strings.
propagateToClientContext(ctx, { exact: [1] })
// @ts-expect-error Prefix propagation rules must be strings.
propagateToClientContext(ctx, { prefix: [false] })
