# 快速开始

只装服务真正需要的包就行。一个常见的 HTTP 服务会用到 `@go-like/context`、`@go-like/core`、`@go-like/web`，再加一个能导出原生 Fetch Handler 的 Web 框架。内部服务调用才需要 `@go-like/client`、`@go-like/transport` 和 `@go-like/transport-http`；注册中心、配置中心和存储后端都由应用明确选择，不会偷偷塞进默认全家桶。

> [!IMPORTANT]
> 当前仓库通过 `workspace:*` 关联 manifest 版本为 `0.0.1` 的 `@go-like/*` 包；该版本尚未发布到 npm。下面的 `bun add` 命令描述首发后的用法；当前源码请在仓库 checkout 的根目录验证并运行：
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @go-like/context @go-like/core @go-like/web
```

创建 `src/main.ts`：

```ts
import process from "node:process"

import { background } from "@go-like/context"
import { afterStart, context, name, newApp, server, stopTimeout } from "@go-like/core"
import { signal } from "@go-like/core/node"
import type { Handler } from "@go-like/web"
import { newNodeServer, port } from "@go-like/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from go-like", path })
}

const webServer = newNodeServer(handler, port(3000))
const app = newApp(
  context(background()),
  name("hello"),
  server(webServer),
  stopTimeout(30_000),
  signal(),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=hello\n")
  })
)

await app.run()
```

运行：

```sh
bun run src/main.ts
```

先等终端出现 `GO_LIKE_EXAMPLE_READY=hello`，再发送请求。只要对象实现结构式 `Server` 接口，就能放进应用。`@go-like/croner`、`@go-like/bullmq`、`@go-like/pino` 和 `@go-like/winston` 已经替常见库做好生命周期衔接，但不会复制原库的一大堆配置项。

连接、密钥、路由和框架配置仍由业务项目创建，再把最小能力注入 go-like，通常就是原生对象或一个 `fetch`。这样测试好写，停机时谁负责关什么也一眼看得明白。
