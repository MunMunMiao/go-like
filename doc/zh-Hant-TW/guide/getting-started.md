# 開始使用

這份指南走 go-like 最短、而且有用的一條路：

1. 在同一個 App 裡，於 Node host 上跑一個標準 Fetch handler。
2. 註冊就緒，讓 `/readyz` 可以通過。
3. 當 handler 做的工作可以取消時，加上明確的請求 Context。
4. 這段生命週期清楚之後，接著看[診所預約專案](/zh-Hant-TW/guide/zero-to-one)。

go-like 不是 router。Handler 可以來自一般的 Web 程式碼、Hono、Elysia、H3，或其他暴露標準 Fetch 形狀的框架。

## 安裝之前

Repository 根目錄是私人的，套件版本記為 `0.0.1`。這個版本不能證明 npm 上已可安裝。從 checkout：

```sh
bun install --frozen-lockfile
```

這個 repository 不用 runtime 或工具版本來決定能不能執行。每一條被選中的驗證通道會檢查它需要的工具能否運行，並記錄觀察到的環境。

當一份正式發布被另行確認之後，一個小型的 Node Web 服務只依賴一個套件：

```sh
bun add @go-like/core
```

日誌、指標、追蹤與生態系後端是各自的插頭。只有當應用程式要建立那個原生用戶端時，才加上對應的插頭。

## 一個 Web 服務

`Handler` 在 `@go-like/core/web`。Node host 在 `@go-like/core/web/node`。程序訊號在 `@go-like/core/node`。下面的形狀是目前的公開 API。`signal()` 要自己傳入：core 不會安裝 signal handler。`readyProbe(probes)` 要掛在健康檢查 handler 使用的同一個 registry 上，否則 `/readyz` 會維持關閉。

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

`run()` 在 App 停止之後 resolve。`Ctrl-C` 送出 `SIGINT`。`signal()` 把第一個 `SIGTERM`、`SIGQUIT` 或 `SIGINT` 對到同一個冪等的 `App.stop()`，並把 `process.exitCode` 設成 `128` 加上訊號編號。之後的訊號留給 runtime。

空白的存活檢查視為通過。空白的就緒檢查失敗即關閉。`readyProbe` 只在啟動完成之後、停止開始之前通過。見[健康檢查與可觀測性](/zh-Hant-TW/guide/health-observability)。

### 第一個檢查點

- Handler 擁有 URL 路由。
- `web` 擁有監聽 socket。
- `app` 接納那個 server，然後停止它。
- 有設定 `stopTimeout` 時，它限制 `run()` 等待多久。它本身不會結束一個不理會關閉的原生 socket。

## 加上請求 Context

`contextHandler` 把 `(ctx, request)` 接成 Fetch `Handler`。Host 把請求 Context 放在 `Request` 上。`requestContext(request)` 再把它讀回來。這個 Context 帶著 AppInfo；裝了 telemetry 時，也帶著 `http.server` span。請求結束或中止時，它會被取消。

```ts
import type { Context } from "@go-like/core/context"
import { contextHandler, type Handler } from "@go-like/core/web"

export const handler: Handler = contextHandler(async (ctx: Context, request: Request) => {
  if (ctx.err() !== null) return new Response(null, { status: 499 })
  const url = new URL(request.url)
  return Response.json({ path: url.pathname })
})
```

如果有工作在 handler 回傳 body 之後還要繼續，也要觀察 `request.signal`。`contextHandler` 在 handler 回傳 `Response` 時結束它的 Context。

## 使用既有的 Fetch 框架

Hono、Elysia 與 H3 的範例把框架的 Fetch 函式傳給 `newNodeServer`，再把那個 host 放進 `server(...)`。路由與 middleware 仍由框架保留。

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

可執行的複本在 `examples/hono`、`examples/elysia`、`examples/h3` 與 `examples/vanilla-web`。

## 建議的閱讀順序

1. 本頁：一個 host、一個 App、一個就緒探針。
2. [診所預約](/zh-Hant-TW/guide/zero-to-one)：一條領域不變條件，以及一次內部 unary 呼叫。
3. [架構](/zh-Hant-TW/guide/architecture)：resource 層級、server 層級，以及時間預算。
4. [服務呼叫](/zh-Hant-TW/guide/service-call)，然後是[設定、服務註冊、儲存與快取](/zh-Hant-TW/guide/config-registry-store)。
5. 要加日誌、指標或追蹤時，讀[健康檢查與可觀測性](/zh-Hant-TW/guide/health-observability)。

## Checkout 指令

在 repository 根目錄，`bun install --frozen-lockfile` 之後：

```sh
bun run --cwd examples/vanilla-web test:unit
bun run --cwd examples/healthcare-appointments test:unit
```

這兩道指令會做型別檢查並執行範例的單元測試。它們不會啟動 Docker，也不能證明 npm 已發布。

## 第一次執行時的失敗

| 看到的現象                                      | 通常的意思                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/readyz` 回 503                                | Registry 裡沒有通過的就緒探針。註冊一個；若 App 本身也要算進去，包含 `readyProbe(probes)`。           |
| 程序在 `SIGTERM` 時直接結束，沒有 drain         | 沒有傳入 `signal()`。                                                                                 |
| `TypeError: pass telemetry with telemetry(...)` | `Telemetry` 套組被傳進 `server(...)` 或 `resources(...)`。改用 `telemetry(tel)`。                     |
| 連接埠已被占用                                  | 另一個程序佔著它。Host 的錯誤就是 runtime 的 listen 錯誤。                                            |
| `Cannot find package`                           | Workspace 還沒安裝，或 import 仍使用遷移前的 specifier。見[遷移與導入](/zh-Hant-TW/guide/migration)。 |
