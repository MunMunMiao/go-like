# 開始使用

服務用到咩先裝咩。一個普通 HTTP 服務通常會有 `@likego/context`、`@likego/core`、`@likego/web`，再揀一個 Web 框架橋接套件。內部服務呼叫先需要 `@likego/client`、`@likego/transport` 同 `@likego/transport-http`；註冊中心、設定來源同儲存後端全部由應用明確揀，唔會暗中塞入預設組合。

> [!IMPORTANT]
> 目前 repo checkout 透過 `workspace:*` 連結 manifest 版本為 `0.0.1` 嘅 `@likego/*` 套件；呢個版本仲未發布到 npm。下面嘅 `bun add` 係發布後嘅用法。要驗證同執行目前源碼，請喺 repo 根目錄運行：
>
> ```sh
> bun install --frozen-lockfile
> bun run test:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @likego/context @likego/core @likego/web
```

建立 `src/main.ts`：

```ts
import { background } from "@likego/context"
import { context, name, newApp, server, stopTimeout } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Handler } from "@likego/web"
import { newNodeServer, port } from "@likego/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from LikeGo", path })
}

const app = newApp(
  context(background()),
  name("hello"),
  server(newNodeServer(handler, port(3000))),
  stopTimeout(30_000),
  signal()
)

await app.run()
```

執行：

```sh
bun run src/main.ts
```

任何符合結構式 `Server` 接口嘅物件都可以加入。`@likego/croner`、`@likego/bullmq`、`@likego/pino`、`@likego/winston` 已經幫常用套件接好生命週期，但唔會再抄一份原生 options 出嚟。

連線、憑證、路由同框架設定繼續由應用建立，只將最小能力交畀 LikeGo，通常係原生物件或者一個 `fetch`。咁樣測試易控制，停機嗰陣邊個要關邊項資源都清清楚楚。
