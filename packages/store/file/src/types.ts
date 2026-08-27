import type { Context } from "@go-like/context"
import type { Server } from "@go-like/core"
import type { Store } from "@go-like/store"

/** Identifies the lifecycle state of one File Store lock owner. */
export type FileStoreState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed"

/** Describes a File Store operation attempted outside its owned lock lifetime. */
export interface FileStoreStateError extends Error {
  readonly name: "FileStoreStateError"
  readonly code: "GO_LIKE_FILE_STORE_STATE"
  readonly operation: string
  readonly state: FileStoreState
}

/** Combines provider-neutral Store operations with the File provider's lock lifecycle. */
export interface FileStore extends Store, Server {}

/** Owns one exclusively admitted Store directory and its bounded filesystem operations. */
export interface FileStoreDirectory {
  /** Releases the exclusive directory ownership after admitted operations finish. */
  close(ctx: Context): Promise<void>
  /** Reads one provider-owned file or returns null when it does not exist. */
  read(ctx: Context, name: string): Promise<Uint8Array | null>
  /** Exclusively creates one provider-owned candidate with the supplied complete bytes. */
  write(ctx: Context, name: string, bytes: Uint8Array): Promise<void>
  /** Atomically replaces one provider-owned target with one provider-owned source. */
  rename(ctx: Context, source: string, target: string): Promise<void>
  /** Removes one provider-owned file and reports whether it existed. */
  remove(ctx: Context, name: string): Promise<boolean>
}

/** Supplies portable filesystem ownership without exposing runtime path APIs to the Store. */
export interface FileStoreHost {
  /** Creates the directory if needed and exclusively acquires its Store owner lock. */
  acquire(ctx: Context, directory: string): Promise<FileStoreDirectory>
}

/** Identifies one secret-safe reason an on-disk snapshot could not be admitted. */
export type FileStoreCorruptionReason = "encoding" | "json" | "schema" | "checksum" | "record"

/** Describes a stable secret-safe snapshot corruption failure. */
export interface FileStoreCorruptionError extends Error {
  readonly name: "FileStoreCorruptionError"
  readonly code: "GO_LIKE_FILE_STORE_CORRUPTION"
  readonly reason: FileStoreCorruptionReason
}

/** Describes a stable failure to acquire a directory already owned by another Store. */
export interface FileStoreLockedError extends Error {
  readonly name: "FileStoreLockedError"
  readonly code: "GO_LIKE_FILE_STORE_LOCKED"
}
