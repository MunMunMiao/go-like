import { copyFile, mkdir, rm } from "node:fs/promises"

const source = new URL("../test/fixtures/protobuf-rpc/.artifacts/gen/order/v1/", import.meta.url)
const target = new URL("../packages/transport/grpc-buf/.artifacts/gen/", import.meta.url)
const order = new URL("order/v1/", target)

await rm(target, { recursive: true, force: true })
await mkdir(order, { recursive: true })
await Promise.all(
  ["order_pb.ts", "order_like.ts"].map((file) =>
    copyFile(new URL(file, source), new URL(file, order))
  )
)
