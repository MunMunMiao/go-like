import { background } from "@go-like/core/context"
import type { Server } from "@go-like/core/lifecycle"
import type { Store } from "@go-like/core/store"

import {
  newFileStore,
  type FileStore,
  type FileStoreCorruptionError,
  type FileStoreCorruptionReason,
  type FileStoreDirectory,
  type FileStoreHost,
  type FileStoreLockedError,
  type FileStoreStateError
} from "../src/store/index"
import {
  newFileStoreCorruptionError,
  newFileStoreLockedError,
  newFileStoreStateError
} from "../src/store/store"
import { newNodeFileStoreHost } from "../src/store/node"

const host: FileStoreHost = newNodeFileStoreHost()
const fileStore: FileStore = newFileStore(host, "directory")
const store: Store = fileStore
const server: Server = fileStore
const corruptionReason: FileStoreCorruptionReason = "checksum"
const corruption: FileStoreCorruptionError = newFileStoreCorruptionError(corruptionReason)
const locked: FileStoreLockedError = newFileStoreLockedError()
const state: FileStoreStateError = newFileStoreStateError("read", "idle")
declare const directory: FileStoreDirectory

void [background(), corruption, directory, locked, server, state, store]

// @ts-expect-error File Store construction requires an injected filesystem host.
newFileStore("directory")
// @ts-expect-error Corruption reasons are a stable closed union.
newFileStoreCorruptionError("unknown")
