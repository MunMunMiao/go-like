# 開始使用

只安裝服務用得到的套件。一個常見 HTTP 服務通常會用 `@likego/context`、`@likego/core`、`@likego/web`，再挑一個 Web 框架橋接套件。內部服務呼叫才需要 `@likego/client`、`@likego/transport` 與 `@likego/transport-http`；註冊中心、設定來源和儲存後端都由應用程式明確選擇。

> [!IMPORTANT]
> 目前 repository checkout 透過 `workspace:*` 連結 manifest 版本為 `0.0.1` 的 `@likego/*` 套件；這個版本尚未發布到 npm。以下 `bun add` 是發布後的用法。若要驗證並執行目前原始碼，請在 repository 根目錄執行：
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

任何符合結構式 `Server` 介面的物件都能加入應用程式。`@likego/croner`、`@likego/bullmq`、`@likego/pino`、`@likego/winston` 已經把常見套件的生命週期接好，但不會複製原套件整套選項。

連線、憑證、路由和框架設定仍由應用程式建立，再把最小必要能力傳給 LikeGo，通常是原生物件或一個 `fetch`。這樣測試容易控制，關機時誰該關閉什麼也不會互相猜。
