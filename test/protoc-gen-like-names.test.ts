import { expect, test } from "bun:test"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { CodeGeneratorRequestSchema, CodeGeneratorResponseSchema } from "@bufbuild/protobuf/wkt"
import { createRouterTransport, type Transport } from "@connectrpc/connect"
import type { ServiceRegistrar } from "@go-like/transport-grpc-buf"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { protocGenLike } from "../packages/protoc-gen-like/src/index"
import { background, type Context } from "../packages/context/src/index"

test("generated service names cannot shadow imports, public factories or local parameters", async () => {
  const root = resolve(import.meta.dir, "..")
  const services = [
    "Echo",
    "EchoClient",
    "EchoHandler",
    "ConnectTransport",
    "Context",
    "ServiceRegistrar",
    "createClient",
    "callOptions",
    "fromHandlerContext",
    "newEchoClient",
    "registerEchoHandler",
    "stub",
    "client",
    "handler",
    "server"
  ]
  const request = create(CodeGeneratorRequestSchema, {
    fileToGenerate: ["names.proto"],
    parameter: "target=ts,import_extension=js",
    protoFile: [
      {
        name: "names.proto",
        package: "names",
        syntax: "proto3",
        messageType: [{ name: "Message", field: [{ name: "value", number: 1, type: 9 }] }],
        service: services.map((name) => ({
          name,
          method: [{ name: "Call", inputType: ".names.Message", outputType: ".names.Message" }]
        }))
      }
    ]
  })
  const protobuf = spawnSync(
    "node",
    [join(root, "node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es")],
    {
      input: toBinary(CodeGeneratorRequestSchema, request),
      timeout: 10_000
    }
  )
  expect(protobuf.error).toBeUndefined()
  expect(protobuf.status, protobuf.stderr.toString()).toBe(0)
  const schemas = fromBinary(CodeGeneratorResponseSchema, protobuf.stdout)
  const glue = protocGenLike.run(request)
  expect(schemas.error).toBe("")
  expect(glue.error).toBe("")
  await mkdir(join(root, ".artifacts"), { recursive: true })
  const directory = await mkdtemp(join(root, ".artifacts/generator-names-"))
  try {
    for (const file of [...schemas.file, ...glue.file]) {
      await writeFile(join(directory, file.name), file.content)
    }
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: join(root, "tsconfig.base.json"),
        compilerOptions: { noEmit: true, skipLibCheck: true, types: ["bun"] },
        include: ["*.ts"]
      })
    )
    const types = spawnSync(
      join(root, "node_modules/.bin/tsc"),
      ["-p", directory, "--pretty", "false"],
      {
        encoding: "utf8",
        timeout: 10_000
      }
    )
    expect(types.error).toBeUndefined()
    expect(types.status, types.stdout + types.stderr).toBe(0)

    type Handler = { call(ctx: Context, request: { value: string }): { value: string } }
    const generated = (await import(
      pathToFileURL(join(directory, "names_like.ts")).href
    )) as Record<string, unknown>
    const transport = createRouterTransport((server) => {
      for (const name of services) {
        const register = generated[`register${name}Handler`] as (
          server: ServiceRegistrar,
          handler: Handler
        ) => void
        register(server, { call: (_ctx, request) => ({ value: `${name}:${request.value}` }) })
      }
    })
    for (const name of services) {
      const factory = generated[`new${name}Client`] as (client: Transport) => {
        call(ctx: Context, request: { value: string }): Promise<{ value: string }>
      }
      expect((await factory(transport).call(background(), { value: "request" })).value).toBe(
        `${name}:request`
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
