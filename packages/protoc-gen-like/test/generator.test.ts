import { expect, test } from "bun:test"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import {
  CodeGeneratorRequestSchema,
  CodeGeneratorResponseSchema,
  DescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
  MethodDescriptorProtoSchema,
  ServiceDescriptorProtoSchema
} from "@bufbuild/protobuf/wkt"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { protocGenLike } from "../src/index"

function field(name: string) {
  return {
    name,
    number: 1,
    label: FieldDescriptorProto_Label.OPTIONAL,
    type: FieldDescriptorProto_Type.STRING
  }
}

function descriptorRequest() {
  const request = create(DescriptorProtoSchema, { name: "OrderRequest", field: [field("id")] })
  const response = create(DescriptorProtoSchema, { name: "OrderResponse", field: [field("id")] })
  const method = (name: string, clientStreaming = false, serverStreaming = false) =>
    create(MethodDescriptorProtoSchema, {
      name,
      inputType: ".acme.v1.OrderRequest",
      outputType: ".acme.v1.OrderResponse",
      clientStreaming,
      serverStreaming
    })
  const order = create(FileDescriptorProtoSchema, {
    name: "acme/order.proto",
    package: "acme.v1",
    syntax: "proto3",
    messageType: [request, response],
    service: [
      create(ServiceDescriptorProtoSchema, {
        name: "OrderService",
        method: [
          method("GetOrder"),
          method("WatchOrders", false, true),
          method("UploadOrders", true),
          method("SyncOrders", true, true),
          method("Delete")
        ]
      }),
      create(ServiceDescriptorProtoSchema, {
        name: "AuditService",
        method: [method("Record")]
      })
    ]
  })
  const empty = create(FileDescriptorProtoSchema, {
    name: "acme/empty.proto",
    package: "acme.v1",
    syntax: "proto3",
    messageType: [create(DescriptorProtoSchema, { name: "Empty" })]
  })
  return create(CodeGeneratorRequestSchema, {
    fileToGenerate: ["acme/order.proto", "acme/empty.proto"],
    protoFile: [order, empty],
    parameter: "target=ts,import_extension=js"
  })
}

async function writeGeneratedFiles(
  directory: string,
  files: readonly { name: string; content: string }[]
): Promise<void> {
  for (const file of files) {
    const path = join(directory, file.name)
    await mkdir(resolve(path, ".."), { recursive: true })
    await writeFile(path, file.content)
  }
}

test("generated glue registers handlers and preserves RPC behavior", async () => {
  const request = descriptorRequest()
  const response = protocGenLike.run(request)
  expect(response.error).toBe("")

  const directory = await mkdtemp(resolve(import.meta.dir, "../.artifacts/generator-runtime-"))
  try {
    const protobuf = spawnSync(
      resolve(import.meta.dir, "../../../node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es"),
      [],
      { input: toBinary(CodeGeneratorRequestSchema, request), timeout: 10_000 }
    )
    expect(protobuf.error).toBeUndefined()
    expect(protobuf.status, protobuf.stderr.toString()).toBe(0)
    const generatedProtobuf = fromBinary(CodeGeneratorResponseSchema, protobuf.stdout)
    expect(generatedProtobuf.error).toBe("")

    await writeGeneratedFiles(directory, generatedProtobuf.file)
    await writeGeneratedFiles(directory, response.file)

    const runtimeScript = `
import { createRouterTransport } from "@connectrpc/connect"
import { background } from "@go-like/context"
const generated = await import(${JSON.stringify(pathToFileURL(join(directory, "acme/order_like.ts")).href)})
const context = background()
const transport = createRouterTransport((server) => {
  generated.registerOrderServiceHandler(server, {
    getOrder: (ctx, value) => ({
      id: (ctx.done() === null ? "missing" : "ctx") + ":" + value.id
    }),
    watchOrders: async function* (ctx, value) {
      yield {
        id: (ctx.done() === null ? "missing" : "ctx") + ":watch:" + value.id
      }
    },
    uploadOrders: async function (ctx, values) {
      const ids = []
      for await (const value of values) ids.push(value.id)
      return {
        id: (ctx.done() === null ? "missing" : "ctx") + ":upload:" + ids.join(",")
      }
    },
    syncOrders: async function* (ctx, values) {
      for await (const value of values) {
        yield {
          id: (ctx.done() === null ? "missing" : "ctx") + ":sync:" + value.id
        }
      }
    },
    delete$: (ctx, value) => ({
      id: (ctx.done() === null ? "missing" : "ctx") + ":delete:" + value.id
    })
  })
  generated.registerAuditServiceHandler(server, {
    record: (ctx, value) => ({
      id: (ctx.done() === null ? "missing" : "ctx") + ":audit:" + value.id
    })
  })
})
const orderClient = generated.newOrderServiceClient(transport)
const auditClient = generated.newAuditServiceClient(transport)
const watched = []
for await (const value of orderClient.watchOrders(context, { id: "4" })) watched.push(value)
const synced = []
for await (const value of orderClient.syncOrders(context, (async function* () {
  yield { id: "7" }
})())) synced.push(value)
const uploaded = await orderClient.uploadOrders(context, (async function* () {
  yield { id: "5" }
  yield { id: "6" }
})())
console.log(JSON.stringify({
  getOrder: (await orderClient.getOrder(context, { id: "1" })).id,
  deleteOrder: (await orderClient.delete$(context, { id: "2" })).id,
  record: (await auditClient.record(context, { id: "3" })).id,
  watched: watched.map((value) => value.id),
  uploaded: (await uploaded).id,
  synced: synced.map((value) => value.id)
}))
`
    const runtimePath = join(directory, "runtime.mjs")
    await writeFile(runtimePath, runtimeScript)
    const child = Bun.spawn([process.execPath, runtimePath], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe"
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    clearTimeout(timeout)
    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      getOrder: "ctx:1",
      deleteOrder: "ctx:delete:2",
      record: "ctx:audit:3",
      watched: ["ctx:watch:4"],
      uploaded: "ctx:upload:5,6",
      synced: ["ctx:sync:7"]
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
