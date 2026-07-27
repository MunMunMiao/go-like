import * as metadata from "@likego/metadata"

const expectedExports = [
  "append",
  "appendToClientContext",
  "clone",
  "fromClientContext",
  "fromServerContext",
  "get",
  "keys",
  "merge",
  "mergeToClientContext",
  "newClientContext",
  "newMetadata",
  "newServerContext",
  "propagateToClientContext",
  "remove",
  "set",
  "values"
].sort()

const actualExports = Object.keys(metadata).sort()
if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
  throw new Error(`unexpected @likego/metadata exports: ${actualExports.join(",")}`)
}

const snapshot = metadata.append(metadata.newMetadata({ Trace: "one" }), "trace", "two")
const replaced = metadata.set(snapshot, "TRACE", "replacement")
const removed = metadata.remove(replaced, "trace")
if (
  metadata.get(snapshot, "TRACE") !== "one" ||
  metadata.values(snapshot, "trace")[1] !== "two" ||
  metadata.get(replaced, "trace") !== "replacement" ||
  metadata.get(removed, "trace") !== null
) {
  throw new Error("built @likego/metadata multi-value smoke failed")
}
