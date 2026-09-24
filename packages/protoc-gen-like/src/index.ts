import type { DescService } from "@bufbuild/protobuf"
import { createEcmaScriptPlugin, safeIdentifier, type GeneratedFile } from "@bufbuild/protoplugin"

function printService(output: GeneratedFile, service: DescService): void {
  const context = output.import("Context", "@go-like/context", true)
  const messageInitShape = output.import("MessageInitShape", "@bufbuild/protobuf", true)
  const messageShape = output.import("MessageShape", "@bufbuild/protobuf", true)
  const createClient = output.import("createClient", "@connectrpc/connect")
  const serviceRegistrar = output.import("ServiceRegistrar", "@go-like/transport-grpc-buf", true)
  const callOptions = output.import("callOptions", "@go-like/transport-grpc-buf")
  const fromHandlerContext = output.import("fromHandlerContext", "@go-like/transport-grpc-buf")
  const serviceSchema = output.importSchema(service)
  const handlerName = `${service.name}Handler`
  const clientName = `${service.name}Client`
  // Local symbols participate in the upstream import allocator without emitting self-imports.
  const localPath = `./${service.file.name}_like.js`
  const server = output.import("server", localPath)
  const handler = output.import("handler", localPath)
  const client = output.import("client", localPath)
  const stub = output.import("stub", localPath)

  output.print(output.export("interface", handlerName), " {")
  for (const method of service.methods) {
    const name = safeIdentifier(method.localName)
    const input = output.importSchema(method.input, true)
    const response = output.importSchema(method.output, true)
    switch (method.methodKind) {
      case "unary":
        void output.print`  ${name}(ctx: ${context}, request: ${messageShape}<typeof ${input}>): ${messageInitShape}<typeof ${response}> | Promise<${messageInitShape}<typeof ${response}>>`
        break
      case "server_streaming":
        void output.print`  ${name}(ctx: ${context}, request: ${messageShape}<typeof ${input}>): AsyncIterable<${messageInitShape}<typeof ${response}>>`
        break
      case "client_streaming":
        void output.print`  ${name}(ctx: ${context}, request: AsyncIterable<${messageShape}<typeof ${input}>>): Promise<${messageInitShape}<typeof ${response}>>`
        break
      case "bidi_streaming":
        void output.print`  ${name}(ctx: ${context}, request: AsyncIterable<${messageShape}<typeof ${input}>>): AsyncIterable<${messageInitShape}<typeof ${response}>>`
        break
    }
  }
  output.print("}")
  output.print()

  void output.print`${output.export("function", `register${service.name}Handler`)}(${server}: ${serviceRegistrar}, ${handler}: ${handlerName}): void {`
  void output.print`  ${server}.service(${serviceSchema}, {`
  for (const method of service.methods) {
    const name = safeIdentifier(method.localName)
    void output.print`    ${method.localName}: (request, ctx) => ${handler}.${name}(${fromHandlerContext}(ctx), request),`
  }
  output.print("  })")
  output.print("}")
  output.print()

  output.print(output.export("interface", clientName), " {")
  for (const method of service.methods) {
    const name = safeIdentifier(method.localName)
    const input = output.importSchema(method.input, true)
    const response = output.importSchema(method.output, true)
    switch (method.methodKind) {
      case "unary":
        void output.print`  ${name}(ctx: ${context}, request: ${messageInitShape}<typeof ${input}>): Promise<${messageShape}<typeof ${response}>>`
        break
      case "client_streaming":
        void output.print`  ${name}(ctx: ${context}, request: AsyncIterable<${messageInitShape}<typeof ${input}>>): Promise<${messageShape}<typeof ${response}>>`
        break
      case "server_streaming":
        void output.print`  ${name}(ctx: ${context}, request: ${messageInitShape}<typeof ${input}>): AsyncIterable<${messageShape}<typeof ${response}>>`
        break
      case "bidi_streaming":
        void output.print`  ${name}(ctx: ${context}, request: AsyncIterable<${messageInitShape}<typeof ${input}>>): AsyncIterable<${messageShape}<typeof ${response}>>`
        break
    }
  }
  output.print("}")
  output.print()

  void output.print`${output.export("function", `new${service.name}Client`)}(${client}: ConnectTransport): ${clientName} {`
  void output.print`  const ${stub} = ${createClient}(${serviceSchema}, ${client})`
  output.print("  return {")
  for (const method of service.methods) {
    void output.print`    ${safeIdentifier(method.localName)}: (ctx, request) => ${stub}.${method.localName}(request, ${callOptions}(ctx)),`
  }
  output.print("  }")
  output.print("}")
}

export const protocGenLike = createEcmaScriptPlugin({
  name: "protoc-gen-like",
  version: "0.0.1",
  generateTs(schema) {
    for (const proto of schema.files) {
      if (proto.services.length === 0) continue
      const output = schema.generateFile(`${proto.name}_like.ts`)
      output.preamble(proto)
      const connectTransport = output.import("ConnectTransport", `./${proto.name}_like.js`, true)
      void output.print`type ${connectTransport} = ${output.import("Transport", "@connectrpc/connect", true)}`
      output.print()
      for (const [index, service] of proto.services.entries()) {
        if (index > 0) output.print()
        printService(output, service)
      }
    }
  }
})
