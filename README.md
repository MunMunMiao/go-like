# go-like

go-like 是一套面向后端服务、以 Go 风格设计的 TypeScript 工具包。应用继续使用 Hono、Elysia、Croner、
BullMQ、NATS、Pino、Winston、OpenTelemetry 等官方 API。go-like 提供插座、生命周期和必要的适配：显式
`Context`、`newApp` 的分层启停，以及配置、发现、缓存、存储、消息、任务和观测的插头。

可运行案例见 [`examples/README.md`](examples/README.md)。每个目录都是本仓库 workspace 里的 private 小程序，
使用 `workspace:*` 依赖。复制单个目录不等于得到可独立安装的项目。

> [!IMPORTANT]
> 当前包版本是 `0.0.1`，尚未发布到 npm。下面的 `bun add` 描述发布之后的安装。在本仓库里，于根目录执行
> `bun install --frozen-lockfile`。启动一个不依赖外部服务的程序：
> `bun run --cwd examples/vanilla-web start`。

## 设计准则

- `Context` 是有取消语义的操作的第一个参数。
- 公共接口使用结构类型。不要求继承、decorator、反射或依赖注入容器。
- 构造使用同步 functional options。`Server` 使用 `start` 与 `stop`。`App` 只用 `run` 与 `stop` 编排它们。
- 运行时值使用 `camelCase`。类型、接口和 Error 构造器使用 `PascalCase`。
- 可移植入口只依赖 ECMAScript 与标准 Web API。Node 与 Bun 绑定放在单独入口。
- 没有全局默认实例，也没有全局注册。应用构造插头并传入。
- 外部 HTTP 使用 `@go-like/core/web` 的单参数 `Handler`。内部 JSON RPC 使用 `@go-like/core/transport`、
  `@go-like/core/server` 与 `@go-like/core/client`。Connect 与 gRPC 使用 `@go-like/connectrpc`。

## 仓库树

根清单 `version` 为锁步版本 `0.0.1`。`workspaces` 是 `packages/*` 与 `examples/*`。包目录平铺，不再嵌套。

```text
likego/
  package.json
  packages/
    core/                         @go-like/core
    otel/  pino/  winston/  prometheus/
    consul/  etcd/  vault/  kubernetes/  zookeeper/  mdns/  yaml/
    nats/  rabbitmq/  redis/  bullmq/  croner/  file/
    connectrpc/  protoc-gen-like/
  examples/                       44 个示例
  e2e/
  doc/
  research/
  README.md
```

入口合计 75 个：core 41 个，插头与生成器 34 个。各包说明见 [`packages/core/README.md`](packages/core/README.md)
以及同目录下其余 19 个 README。

## 包

除 `@go-like/protoc-gen-like` 外，每个插头的 `peerDependencies["@go-like/core"]` 都是精确版本 `0.0.1`，
dev 依赖是 `workspace:*`。下表的第三方依赖按当前清单：peer、可选 peer、常规依赖。通道里 `P` 是可移植，
`N` 是 Node.js，`B` 是 Bun。

| #   | 包                         | 公开入口                                 | 填充的插座                                                                                                | 第三方依赖                                                                                                                                     | 通道                   |
| --- | -------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | `@go-like/core`            | 41 个                                    | core 的插座、机制、参考实现与绑定                                                                         | 无运行时依赖。`dependencies` 声明 `@types/node` `26.6.6`                                                                                       | P/N/B                  |
| 2   | `@go-like/otel`            | `.`                                      | `TracerProvider`、`Span`、`MeterProvider`、`Instrument`、`LogHandler`、`Propagator`、`TelemetryLifecycle` | `@opentelemetry/api` peer `^1.10.0`                                                                                                            | P                      |
| 3   | `@go-like/pino`            | `./log`                                  | `LogHandler`                                                                                              | `pino` peer `^10.4.0`；`@types/node` `26.6.6` 常规                                                                                             | N, B                   |
| 4   | `@go-like/winston`         | `./log`                                  | `LogHandler`                                                                                              | `winston` 可选 peer `^3.19.0`；`@types/node` `26.6.6` 常规                                                                                     | N, B                   |
| 5   | `@go-like/prometheus`      | `./metric`                               | `MeterProvider`、`Instrument`、`TelemetryLifecycle`；抓取用 Web `Handler`                                 | `prom-client` peer `^15.1.3`                                                                                                                   | N, B                   |
| 6   | `@go-like/consul`          | `.`、`./registry`、`./config`、`./store` | 共享客户端；`Registry`；`ConfigSource`；`Store`                                                           | 无                                                                                                                                             | P                      |
| 7   | `@go-like/etcd`            | `.`、`./registry`、`./config`、`./store` | 同 consul                                                                                                 | 无                                                                                                                                             | P                      |
| 8   | `@go-like/vault`           | `.`、`./config`、`./store`               | 共享客户端；`ConfigSource`；`Store`                                                                       | 无                                                                                                                                             | P                      |
| 9   | `@go-like/kubernetes`      | `.`、`./registry`、`./config`            | 共享客户端；`Registry`；`ConfigSource`                                                                    | 无                                                                                                                                             | P                      |
| 10  | `@go-like/zookeeper`       | `./registry`、`./registry/node`          | `Registry`；Node 客户端工厂                                                                               | `node-zookeeper-client` `1.2.1` 常规，只被 `./registry/node` 导入                                                                              | P；`/node` 为 N        |
| 11  | `@go-like/mdns`            | `./registry`、`./registry/node`          | `Registry`；`node:dgram` 宿主                                                                             | 无                                                                                                                                             | P；`/node` 为 N        |
| 12  | `@go-like/yaml`            | `./config`                               | `ConfigDecoder`                                                                                           | `js-yaml` `5.5.0` 常规                                                                                                                         | P                      |
| 13  | `@go-like/nats`            | `./broker`、`./jetstream`                | `Broker`、`Subscriber`                                                                                    | `@nats-io/transport-node` `3.4.0` 常规；`@nats-io/jetstream` 可选 peer `^3.4.0`；`@types/node` `26.6.6` 常规                                   | N, B                   |
| 14  | `@go-like/rabbitmq`        | `./broker`                               | `Broker`、`Subscriber`                                                                                    | `amqplib` 可选 peer `^2.3.1`；`@types/node` `26.6.6` 常规                                                                                      | N, B                   |
| 15  | `@go-like/redis`           | `./cache`                                | `Cache`；资源层 `Server`                                                                                  | `@redis/client` `6.3.1` 常规                                                                                                                   | N, B                   |
| 16  | `@go-like/bullmq`          | `./job`                                  | `JobQueue`；队列资源与 worker 的 `Server`                                                                 | `bullmq` peer `^6.7.5`；`@types/node` `26.6.6` 常规                                                                                            | N, B                   |
| 17  | `@go-like/croner`          | `./job`                                  | `Schedule`                                                                                                | `croner` `11.0.0` 常规                                                                                                                         | P                      |
| 18  | `@go-like/file`            | `./store`、`./store/node`                | `Store`；资源层 `Server`；Node 宿主                                                                       | 无                                                                                                                                             | P；`/node` 为 N        |
| 19  | `@go-like/connectrpc`      | `.`、`./node`                            | Web `Handler`；`./node` 的生命周期 `Server`、`Endpointer` 与 gRPC 客户端                                  | `@connectrpc/connect` peer `^2.3.0`；`@bufbuild/protobuf` peer `^2.17.0`；`@connectrpc/connect-node` `2.3.0` 常规；`@types/node` `26.6.6` 常规 | `.` 为 P；`/node` 为 N |
| 20  | `@go-like/protoc-gen-like` | `.`（含 `bin`）                          | 无。构建期插件                                                                                            | `@bufbuild/protoplugin` `2.17.0` 与 `@bufbuild/protobuf` `2.17.0`，均为常规。不依赖 core                                                       | 构建期                 |

## 快速开始

下面的程序只依赖 `@go-like/core`，在 Node.js 上提供一个 Web 服务和健康探针。`signal()` 必须显式传入。
`readyProbe` 与 `createHealthHandler` 共用同一个探针注册表。core 没有路由器，路径分派是普通函数。

```sh
bun add @go-like/core
```

`src/main.ts`：

```ts
import { name, newApp, readyProbe, server, version } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { signal } from "@go-like/core/node"
import { contextHandler, createHealthHandler, requestContext } from "@go-like/core/web"
import { newNodeServer, nodeShutdownTimeout, port } from "@go-like/core/web/node"

const probes = newProbeRegistry()
probes.register("ready", "warmup", async () => {})

const health = createHealthHandler(probes, { livePath: "/livez", readyPath: "/readyz" })
const handler = contextHandler(async (ctx, request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return Response.json({
    path: pathname,
    hasContext: requestContext(request) !== null && ctx.err() === null
  })
})

const web = newNodeServer(handler, port(3000), nodeShutdownTimeout(10_000))
const app = newApp(signal(), name("hello-web"), version("v1"), readyProbe(probes), server(web))

await app.run()
```

```sh
bun run src/main.ts
```

观测、Consul、消息和任务的组合见各插头 README 与 [`examples/README.md`](examples/README.md)。

## 文档

- [用户文档](doc/index.md)
- [示例索引](examples/README.md)
- [`@go-like/core` 入口索引](packages/core/README.md)
- [研究资料](research/README.md)

## 许可证

go-like 和每个发布包均采用 [MIT License](LICENSE)。
