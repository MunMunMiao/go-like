# 開始使用

服務用到咩先裝咩。一個普通 HTTP 服務通常會有 `@go-like/context`、`@go-like/core`、`@go-like/web`，再揀一個可以匯出原生 Fetch Handler 嘅 Web 框架。內部服務呼叫需要 `@go-like/client`、`@go-like/transport` 同一個具體 transport provider，例如測試用嘅 `@go-like/transport-memory` 或網絡用嘅 `@go-like/transport-http`；註冊中心、設定來源同儲存後端全部由應用明確揀，唔會暗中塞入預設組合。

> [!IMPORTANT]
> 目前 repo checkout 透過 `workspace:*` 連結 manifest 版本為 `0.0.1` 嘅 `@go-like/*` 套件；呢個版本仲未發布到 npm。下面嘅 `bun add` 係發布後嘅用法。要驗證同執行目前源碼，請喺 repo 根目錄運行：
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @go-like/context @go-like/core @go-like/web
```

建立 `src/main.ts`：

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

執行：

```sh
bun run src/main.ts
```

送 request 之前，先等 terminal 出現 `GO_LIKE_EXAMPLE_READY=hello`。任何符合結構式 `Server` 介面嘅物件都可以加入。`@go-like/croner`、`@go-like/bullmq`、`@go-like/pino`、`@go-like/winston` 已經幫常用套件接好生命週期，但唔會再抄一份原生 options 出嚟。

連線、憑證、路由同框架設定繼續由應用建立，只將最小能力交畀 go-like，通常係原生物件或者一個 `fetch`。咁樣測試易控制，停機嗰陣邊個要關邊項資源都清清楚楚。
