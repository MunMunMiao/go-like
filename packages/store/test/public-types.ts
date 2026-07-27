import { background, type Context } from "@likego/context"

import {
  cursor,
  expiresIn,
  ifRevision,
  limit,
  prefix,
  type DeleteOption,
  type DeleteOptions,
  type ListOption,
  type ListOptions,
  type Store,
  type StoreConflictError,
  type StorePage,
  type StoreRecord,
  type StoreRecordInput,
  type WriteOption,
  type WriteOptions
} from "../src/index"
import {
  deleteOptions,
  listOptions,
  snapshotStorePage,
  snapshotStoreRecord,
  snapshotStoreRecordInput,
  writeOptions
} from "../src/provider"
const input: StoreRecordInput = snapshotStoreRecordInput({
  key: "key",
  value: new Uint8Array([1])
})
const record: StoreRecord = snapshotStoreRecord({
  key: input.key,
  value: input.value,
  metadata: input.metadata ?? {},
  revision: "one",
  expiresAt: null
})
const page: StorePage = snapshotStorePage({ records: [record], cursor: null })
const writeOption: WriteOption = expiresIn(1)
const revisionOption: WriteOption & DeleteOption = ifRevision("one")
const deleteOption: DeleteOption = revisionOption
const listOption: ListOption = prefix("key")
const resumed: ListOption = cursor("next")
const limited: ListOption = limit(1)
const writes: WriteOptions = writeOptions(writeOption, revisionOption)
const deletes: DeleteOptions = deleteOptions(deleteOption)
const lists: ListOptions = listOptions(listOption, resumed, limited)

const store: Store = {
  async read(_ctx, _key) {
    return record
  },
  async write(_ctx, _record, ..._options) {
    return record
  },
  async delete(_ctx, _key, ..._options) {
    return true
  },
  async list(_ctx, ..._options) {
    return page
  },
  string() {
    return "typed"
  }
}
declare const conflictError: StoreConflictError

void [background(), conflictError, deletes, lists, writes]

// @ts-expect-error Store operations require a Context first.
store.read("key")
// @ts-expect-error TTL accepts positive numbers, not strings.
expiresIn("1")
// @ts-expect-error Store input values are bytes.
snapshotStoreRecordInput({ key: "key", value: "value" })
