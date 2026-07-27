import type { Context } from "@likego/context"

/** Captures one put call's immutable effective options. */
export interface PutOptions {
  readonly expiresInMs: number | null
}

/** Reduces one immutable put option snapshot to its next candidate. */
export type PutOption = (options: PutOptions) => PutOptions

/** Defines the complete provider-neutral Cache contract. */
export interface Cache {
  /** Reads one exact key or returns null when no unexpired value exists. */
  get(ctx: Context, key: string): Promise<Uint8Array | null>

  /** Creates or replaces one exact key with caller-owned bytes. */
  put(
    ctx: Context,
    key: string,
    value: Uint8Array,
    ...options: readonly PutOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
  ): Promise<void>

  /** Deletes one exact key; missing keys are successful no-ops. */
  delete(ctx: Context, key: string): Promise<void>

  /** Returns one stable provider diagnostic name. */
  string(): string
}
