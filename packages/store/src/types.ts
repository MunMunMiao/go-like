import type { Context } from "@likego/context"

/** Describes one immutable record returned by a Store. */
export interface StoreRecord {
  readonly key: string
  readonly value: Uint8Array
  readonly metadata: Readonly<Record<string, string>>
  readonly revision: string
  readonly expiresAt: number | null
}

/** Describes one caller-owned record admitted by a Store write. */
export interface StoreRecordInput {
  readonly key: string
  readonly value: Uint8Array
  readonly metadata?: Readonly<Record<string, string>>
}

/** Describes one immutable, cursor-addressable Store page. */
export interface StorePage {
  readonly records: readonly StoreRecord[]
  readonly cursor: string | null
}

/** Captures one write call's immutable effective options. */
export interface WriteOptions {
  readonly expiresInMs: number | null
  readonly ifRevision: string | null
}

/** Captures one delete call's immutable effective options. */
export interface DeleteOptions {
  readonly ifRevision: string | null
}

/** Captures one list call's immutable effective options. */
export interface ListOptions {
  readonly prefix: string
  readonly limit: number | null
  readonly cursor: string | null
}

/** Reduces one immutable write option snapshot to its next candidate. */
export type WriteOption = (options: WriteOptions) => WriteOptions

/** Reduces one immutable delete option snapshot to its next candidate. */
export type DeleteOption = (options: DeleteOptions) => DeleteOptions

/** Reduces one immutable list option snapshot to its next candidate. */
export type ListOption = (options: ListOptions) => ListOptions

/** Describes a stable compare-and-swap conflict without interpreting provider revisions. */
export interface StoreConflictError extends Error {
  readonly name: "StoreConflictError"
  readonly code: "LIKEGO_STORE_CONFLICT"
  readonly key: string
  readonly expectedRevision: string
  readonly actualRevision: string | null
}

/** Defines the complete provider-neutral Store contract. */
export interface Store {
  /** Reads one exact key or returns null when no unexpired record exists. */
  read(ctx: Context, key: string): Promise<StoreRecord | null>

  /** Atomically creates or replaces one record and returns its admitted revision. */
  write(
    ctx: Context,
    record: StoreRecordInput,
    ...options: readonly WriteOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
  ): Promise<StoreRecord>

  /** Deletes one exact key and reports whether an unexpired record was removed. */
  delete(
    ctx: Context,
    key: string,
    ...options: readonly DeleteOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
  ): Promise<boolean>

  /** Lists one stable code-point-sorted page of unexpired records. */
  list(
    ctx: Context,
    ...options: readonly ListOption[] /* likego-typed-rest: preserves the Go-style functional-option ABI without coercion. */
  ): Promise<StorePage>

  /** Returns one stable provider diagnostic name. */
  string(): string
}
