# 開始使用

只安裝服務用得到的套件。一個常見 HTTP 服務通常會用 `@go-like/context`、`@go-like/core`、`@go-like/web`，再挑一個能匯出原生 Fetch Handler 的 Web 框架。內部服務呼叫才需要 `@go-like/client`、`@go-like/transport` 與 `@go-like/transport-http`；註冊中心、設定來源和儲存後端都由應用程式明確選擇。

> [!IMPORTANT]
> 目前 repository checkout 透過 `workspace:*` 連結 manifest 版本為 `0.0.1` 的 `@go-like/*` 套件；這個版本尚未發布到 npm。以下 `bun add` 是發布後的用法。若要驗證並執行目前原始碼，請在 repository 根目錄執行：
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

送出請求前，先等 terminal 出現 `GO_LIKE_EXAMPLE_READY=hello`。任何符合結構式 `Server` 介面的物件都能加入應用程式。`@go-like/croner`、`@go-like/bullmq`、`@go-like/pino`、`@go-like/winston` 已經把常見套件的生命週期接好，但不會複製原套件整套選項。

連線、憑證、路由和框架設定仍由應用程式建立，再把最小必要能力傳給 go-like，通常是原生物件或一個 `fetch`。這樣測試容易控制，關機時誰該關閉什麼也不會互相猜。
