import { background } from "@likego/context"
import type { Server } from "@likego/core"
import type { Store } from "../../src/index"

import {
  newFileStore,
  newFileStoreCorruptionError,
  newFileStoreLockedError,
  newFileStoreStateError,
  type FileStore,
  type FileStoreCorruptionError,
  type FileStoreCorruptionReason,
  type FileStoreDirectory,
  type FileStoreHost,
  type FileStoreLockedError,
  type FileStoreStateError
} from "../src/index"
import { newNodeFileStoreHost } from "../src/node"

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
