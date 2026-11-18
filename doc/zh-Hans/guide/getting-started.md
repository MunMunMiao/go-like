# 快速开始

本指南走 go-like 里最短的一条有用路径：

1. 在一个 App 里，于 Node 宿主上运行标准 Fetch handler。
2. 注册就绪，使 `/readyz` 可以通过。
3. 当 handler 做可取消的工作时，加上显式的请求 Context。
4. 这条生命周期清楚之后，转到[诊所预约：从 0 到 1](/zh-Hans/guide/zero-to-one)。

go-like 不是路由器。Handler 可以来自普通 Web 代码、Hono、Elysia、H3，或任何暴露标准 Fetch 形态的框架。

## 安装之前

仓库根是私有的，包版本记为 `0.0.1`。该版本不能证明 npm 可用。在 checkout 中：

```sh
bun install --frozen-lockfile
```

仓库不用 runtime 或工具版本作为执行资格。每条选定的验证 lane 会检查所需工具能否运行，并记录观察到的环境。

当某个已发布版本被独立确认之后，一个小型 Node Web 服务只依赖一个包：

```sh
bun add @go-like/core
```

日志、指标、追踪和生态后端是单独的插头。只有应用要构造那个原生客户端时才加一个。

## 一个 Web 服务

`Handler` 在 `@go-like/core/web`。Node 宿主在 `@go-like/core/web/node`。进程信号在 `@go-like/core/node`。下面的形态是当前公共 API。`signal()` 要自己传入：core 不会安装信号处理器。把 `readyProbe(probes)` 传到健康检查 handler 使用的同一个 registry 上，否则 `/readyz` 保持关闭。

```ts
import { name, newApp, readyProbe, server, version } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { signal } from "@go-like/core/node"
import { contextHandler, createHealthHandler, requestContext } from "@go-like/core/web"
import { newNodeServer, port } from "@go-like/core/web/node"

const probes = newProbeRegistry()
probes.register("ready", "warmup", async () => {
  // Check a process-local dependency here. Return to pass, throw to fail.
})

const health = createHealthHandler(probes)
const handler = contextHandler(async (ctx, request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return Response.json({
    path: pathname,
    hasContext: requestContext(request) !== null && ctx.err() === null
  })
})

const web = newNodeServer(handler, port(3000))
export const app = newApp(
  signal(),
  name("hello-web"),
  version("v1"),
  readyProbe(probes),
  server(web)
)

await app.run()
```

`run()` 在 App 停止之后 resolve。`Ctrl-C` 送达 `SIGINT`。`signal()` 把第一个 `SIGTERM`、`SIGQUIT` 或 `SIGINT` 映射到同一次幂等的 `App.stop()`，并把 `process.exitCode` 设为 `128` 加上信号编号。之后的信号留给 runtime。

空的存活检查通过。空的就绪检查 fail closed。`readyProbe` 只在启动完成之后、停止开始之前通过。见[健康与可观测性](/zh-Hans/guide/health-observability)。

### 第一个检查点

- Handler 拥有 URL 路由。
- `web` 拥有监听套接字。
- `app` 接纳这个 server，然后停止它。
- 设置了 `stopTimeout` 时，它限制 `run()` 等待多久。它本身不会结束一个忽视停机的原生套接字。

## 加上请求 Context

`contextHandler` 把 `(ctx, request)` 适配成 Fetch `Handler`。宿主把请求 Context 存在 `Request` 上。`requestContext(request)` 再读出来。Context 携带 AppInfo；安装了观测时，还携带 `http.server` span。请求结束或中止时，Context 被取消。

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

如果工作在 handler 返回 body 之后还要继续，也要观察 `request.signal`。`contextHandler` 在 handler 返回 `Response` 时结束它的 Context。

## 使用现有的 Fetch 框架

Hono、Elysia 和 H3 示例把框架的 Fetch 函数传给 `newNodeServer`，再把该宿主放进 `server(...)`。框架继续拥有路由和 middleware。

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/core/web/node"

const app = new Hono()
app.get("/hello", (c) => c.json({ ok: true }))

const web = newNodeServer(app.fetch, port(3000))
await newApp(signal(), name("hono"), server(web)).run()
```

可运行的副本是 `examples/hono`、`examples/elysia`、`examples/h3` 和 `examples/vanilla-web`。

## 按顺序学习

1. 本页：一个宿主、一个 App、一个就绪探针。
2. [诊所预约：从 0 到 1](/zh-Hans/guide/zero-to-one)：一条领域不变量和一次内部 unary 调用。
3. [架构](/zh-Hans/guide/architecture)：资源层、server 层和预算。
4. [服务调用](/zh-Hans/guide/service-call)，然后是[配置、注册中心、存储与缓存](/zh-Hans/guide/config-registry-store)。
5. 要加日志、指标或追踪时，读[健康与可观测性](/zh-Hans/guide/health-observability)。

## Checkout 命令

在仓库根目录，`bun install --frozen-lockfile` 之后：

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

这些命令会做类型检查并运行示例的单元测试。它们不启动 Docker，也不证明 npm 发布。

## 首次运行失败

| 看到的现象                                      | 通常的含义                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/readyz` 返回 503                              | registry 里没有通过的就绪探针。注册一个；如果 App 自身也应计入，包括 `readyProbe(probes)`。          |
| 进程在 `SIGTERM` 上退出且没有排空               | 漏了 `signal()`。                                                                                    |
| `TypeError: pass telemetry with telemetry(...)` | `Telemetry` bundle 被传进了 `server(...)` 或 `resources(...)`。改用 `telemetry(tel)`。               |
| 端口已被占用                                    | 另一个进程占着它。宿主错误就是 runtime 的 listen 错误。                                              |
| `Cannot find package`                           | workspace 还没安装，或者 import 仍使用迁移前的 specifier。见[迁移与接入](/zh-Hans/guide/migration)。 |
