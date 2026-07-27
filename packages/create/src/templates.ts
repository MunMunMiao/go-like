export interface ProjectFile {
  readonly path: string
  readonly content: string
}

export interface ProjectDependencies {
  readonly "@likego/core": string
  readonly "@likego/server": string
  readonly "@likego/transport": string
  readonly "@likego/transport-http": string
}

/** Encodes one generated JSON file with the repository's stable indentation. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Creates the generated internal unary endpoint contract. */
function contract(projectName: string): string {
  return `import { endpoint } from "@likego/transport"
import { jsonCodec } from "@likego/transport/json"

export interface GreetRequest {
  readonly name: string
}

export interface GreetResponse {
  readonly message: string
}

const requestSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "likego-create",
    validate(value: unknown) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const name = Reflect.get(value, "name")
        if (typeof name === "string" && name.trim().length > 0) {
          return { value: Object.freeze({ name }) }
        }
      }
      return { issues: [{ message: "name must be a non-empty string" }] }
    }
  }
}

const responseSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "likego-create",
    validate(value: unknown) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const message = Reflect.get(value, "message")
        if (typeof message === "string") return { value: Object.freeze({ message }) }
      }
      return { issues: [{ message: "message must be a string" }] }
    }
  }
}

export const greetService = "${projectName}.greeter"
export const greetOperation = "Greet"
export const greetEndpoint = endpoint(
  greetService,
  greetOperation,
  jsonCodec<GreetRequest>(requestSchema),
  jsonCodec<GreetResponse>(responseSchema)
)
`
}

/** Creates the generated business service. */
function service(): string {
  return `import type { GreetRequest, GreetResponse } from "./contract.ts"

/** Applies the greeting business rule without owning transport or lifecycle state. */
export function greet(request: GreetRequest): GreetResponse {
  const name = request.name.trim()
  if (name.length === 0) throw new TypeError("greet request name must not be blank")
  return Object.freeze({ message: "Hello, " + name + "!" })
}
`
}

/** Creates the generated Node application composition root. */
function main(projectName: string): string {
  return `import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import {
  address,
  handler,
  newServer,
  transport as serverTransport
} from "@likego/server"
import { newNodeHTTPTransport } from "@likego/transport-http/node"

import { greetEndpoint, greetOperation, greetService } from "./contract.ts"
import { greet } from "./service.ts"

const listenAddress = process.env.LIKEGO_ADDRESS ?? "127.0.0.1:8080"
const unaryServer = newServer(
  serverTransport(newNodeHTTPTransport()),
  address(listenAddress),
  handler(greetEndpoint, (_ctx, request) => greet(request))
)

const app = newApp(
  signal(),
  name("${projectName}"),
  server(unaryServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    const endpoint = await unaryServer.endpoint(ctx)
    const curl = [
      "curl --fail-with-body --request POST '" + endpoint + "'",
      "--header 'Content-Type: application/json'",
      "--header 'Likego-Service: " + greetService + "'",
      "--header 'Likego-Endpoint: " + greetOperation + "'",
      "--data '{\\"name\\":\\"LikeGo\\"}'"
    ].join(" \\\\\\n  ")
    process.stdout.write(
      "LIKEGO_READY=" + JSON.stringify({ service: greetService, endpoint }) + "\\n"
    )
    process.stdout.write("CURL=" + curl + "\\n")
  })
)

await app.run()
`
}

/** Creates the generated unit test. */
function serviceTest(): string {
  return `import assert from "node:assert/strict"
import test from "node:test"

import { greetEndpoint } from "../src/contract.ts"
import { greet } from "../src/service.ts"

test("greets one validated caller", async () => {
  assert.deepEqual(greet({ name: " LikeGo " }), { message: "Hello, LikeGo!" })

  const body = await greetEndpoint.requestCodec.encode({ name: "LikeGo" })
  assert.deepEqual(await greetEndpoint.requestCodec.decode(body), { name: "LikeGo" })
})

test("rejects blank names", () => {
  assert.throws(() => greet({ name: " " }), /must not be blank/)
})
`
}

/** Creates one directly runnable Node 24+ LikeGo internal unary service project. */
export function projectFiles(
  projectName: string,
  dependencies: ProjectDependencies
): readonly ProjectFile[] {
  const serviceName = `${projectName}.greeter`
  return Object.freeze([
    Object.freeze({ path: ".gitignore", content: "node_modules\\n*.tsbuildinfo\\n" }),
    Object.freeze({
      path: "package.json",
      content: json({
        name: projectName,
        version: "0.0.1",
        private: true,
        packageManager: "bun@1.3.14",
        type: "module",
        scripts: {
          start: "node src/main.ts",
          test: "node --test test/service.test.ts",
          typecheck: "tsc -p tsconfig.json --pretty false"
        },
        dependencies,
        devDependencies: {
          "@types/node": "26.1.1",
          typescript: "7.0.2"
        },
        engines: { node: ">=24.18.0" }
      })
    }),
    Object.freeze({
      path: "tsconfig.json",
      content: json({
        $schema: "https://json.schemastore.org/tsconfig",
        compilerOptions: {
          target: "ES2024",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          erasableSyntaxOnly: true,
          allowImportingTsExtensions: true,
          types: ["node"]
        },
        include: ["src/**/*.ts", "test/**/*.ts"]
      })
    }),
    Object.freeze({
      path: "README.md",
      content: `# ${projectName}

这是由 \`@likego/create\` 生成的内部 unary 微服务，不是外部 Web 页面。

## 运行

\`\`\`sh
bun install
bun run start
\`\`\`

服务默认监听 \`127.0.0.1:8080\`。看到 \`LIKEGO_READY\` 后，在另一个终端调用：

\`\`\`sh
curl --fail-with-body --request POST "http://127.0.0.1:8080/" \\
  --header "Content-Type: application/json" \\
  --header "Likego-Service: ${serviceName}" \\
  --header "Likego-Endpoint: Greet" \\
  --data '{"name":"LikeGo"}'
\`\`\`

可以通过 \`LIKEGO_ADDRESS=127.0.0.1:0\` 使用随机端口；启动日志会输出实际 endpoint 和可复制的
\`CURL=\` 命令。

## 验证

\`\`\`sh
bun run test
bun run typecheck
\`\`\`

## 目录

\`\`\`text
src/
├── contract.ts  # 内部 unary contract 与 JSON codec
├── service.ts   # 不持有基础设施的业务逻辑
└── main.ts      # Transport、Server 与 App 生命周期组装
test/
└── service.test.ts
\`\`\`
`
    }),
    Object.freeze({ path: "src/contract.ts", content: contract(projectName) }),
    Object.freeze({ path: "src/service.ts", content: service() }),
    Object.freeze({ path: "src/main.ts", content: main(projectName) }),
    Object.freeze({ path: "test/service.test.ts", content: serviceTest() })
  ])
}
