# 開始使用

呢份指南行 go-like 最短而有用嘅路線：

1. 喺一個 App 入面，用 Node host 行一個標準 Fetch Handler。
2. 註冊就緒，令 `/readyz` 可以通過。
3. Handler 做可取消工作時，加上明確嘅請求 Context。
4. 呢個生命週期清楚之後，去[診所預約 project](/zh-Hant-HK/guide/zero-to-one)。

go-like 唔係 router。Handler 可以嚟自普通 Web 程式碼、Hono、Elysia、H3，或者任何暴露標準 Fetch 形狀嘅框架。

## 安裝之前

Repo 根係私人嘅，套件版本記錄為 `0.0.1`。呢個版本唔能夠證明 npm 可用。由 checkout：

```sh
bun install --frozen-lockfile
```

Repo 唔將 runtime 或工具版本當成執行資格。每條被選中嘅驗證通道會檢查所需工具可唔可以行，並記錄觀察到嘅環境。

獨立確認有已發布版本之後，一個細小嘅 Node Web 服務依賴一個套件：

```sh
bun add @go-like/core
```

日誌、指標、追蹤同生態後端係獨立插頭。只有應用要建立該原生 client 先至加一隻。

## 一個 Web 服務

`Handler` 喺 `@go-like/core/web`。Node host 喺 `@go-like/core/web/node`。程序信號喺 `@go-like/core/node`。下面嘅形狀係而家嘅公開 API。自己傳 `signal()`：core 唔會安裝信號處理器。將 `readyProbe(probes)` 放喺健康 Handler 用緊嘅同一個 registry，否則 `/readyz` 保持關閉。

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

`run()` 喺 App 停止之後 resolve。`Ctrl-C` 送出 `SIGINT`。`signal()` 將第一個 `SIGTERM`、`SIGQUIT` 或 `SIGINT` 對應到同一個冪等 `App.stop()`，並將 `process.exitCode` 設為 `128` 加信號編號。之後嘅信號留畀 runtime。

空 liveness 通過。空 readiness fail closed。`readyProbe` 只喺啟動完成之後、停止開始之前通過。見[健康檢查與可觀測性](/zh-Hant-HK/guide/health-observability)。

### 第一個檢查點

- Handler 擁有 URL 路由。
- `web` 擁有監聽 socket。
- `app` 接納該 server，然後停佢。
- 設定咗 `stopTimeout` 時，佢限制 `run()` 等幾耐。佢本身唔會令一個忽略關閉嘅原生 socket 結束。

## 加上請求 Context

`contextHandler` 將 `(ctx, request)` 適配成 Fetch `Handler`。Host 將請求 Context 存放喺 `Request`。`requestContext(request)` 讀返佢。Context 帶 AppInfo；裝咗遙測時亦帶 `http.server` span。請求結束或中止時，佢會被取消。

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

Handler 返回 body 之後仲要繼續嘅工作，亦要觀察 `request.signal`。`contextHandler` 喺 Handler 返回 `Response` 時結束自己嘅 Context。

## 用現有 Fetch 框架

Hono、Elysia 同 H3 例子將框架嘅 Fetch 函式傳畀 `newNodeServer`，再將該 host 放入 `server(...)`。框架保留路由同 middleware。

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

可執行副本係 `examples/hono`、`examples/elysia`、`examples/h3` 同 `examples/vanilla-web`。

## 按次序學

1. 呢頁：一個 host、一個 App、一個 ready probe。
2. [診所預約](/zh-Hant-HK/guide/zero-to-one)：一條領域不變量同一次內部 unary 呼叫。
3. [架構](/zh-Hant-HK/guide/architecture)：資源層、Server 層同埋時限。
4. [服務呼叫](/zh-Hant-HK/guide/service-call)，然後[設定、註冊中心、儲存同快取](/zh-Hant-HK/guide/config-registry-store)。
5. 要加日誌、指標或追蹤時，讀[健康檢查與可觀測性](/zh-Hant-HK/guide/health-observability)。

## Checkout 命令

喺 repo 根，`bun install --frozen-lockfile` 之後：

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

呢啲命令會 typecheck，並且執行例子嘅單元測試。佢哋唔會啟動 Docker，亦唔證明 npm 發布。

## 第一次運行嘅失敗

| 你見到嘅                                        | 通常係咩意思                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/readyz` 回 503                                | Registry 冇通過嘅 readiness probe。註冊一個；如果 App 本身都要計，包括 `readyProbe(probes)`。 |
| 程序喺 `SIGTERM` 退出而冇 drain                 | 漏咗 `signal()`。                                                                             |
| `TypeError: pass telemetry with telemetry(...)` | `Telemetry` bundle 被傳入 `server(...)` 或 `resources(...)`。用 `telemetry(tel)`。            |
| 埠已經被佔用                                    | 另一個程序持有佢。Host 錯誤係 runtime 嘅 listen 錯誤。                                        |
| `Cannot find package`                           | Workspace 未安裝，或者 import 仍然用遷移前 specifier。見[遷移](/zh-Hant-HK/guide/migration)。 |
