# 診所預約：由 0 到 1

呢條路線跟一條業務不變量，穿過內部政策呼叫、Fetch Handler、健康檢查同一個 App。可執行樹係 `examples/healthcare-appointments`。下面片段用該例子嘅名稱。可丟棄嘅 availability 快取係你喺同一個組合根加嘅額外 milestone。佢唔係第二個權威來源。

## 不變量

1. 同一位醫生唔可以有時間重疊嘅 active 預約。
2. 取消會釋放時段。
3. 用同一個 appointment id 重複提交相同內容係冪等嘅。
4. 用同一個 appointment id 提交唔同內容會被拒絕。
5. 如果你加咗快取嘅 availability 投影，佢永遠唔可以單獨授權一次預約。

例子用記憶體 repository 實作前四條規則，並經 `appointment-policy.v1/check` 檢查最長時長。佢冇宣稱資料庫、分散式鎖、身分驗證，或者正式診所流程。

## 佈局

```text
examples/healthcare-appointments/
  src/contract.ts    defineService and Structs
  src/service.ts     repository and booking rules
  src/transport.ts   memory Server and Client
  src/http.ts        Fetch handler
  src/main.ts        Node host and App
  test/main.test.ts
```

由 repo 根：

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

套件版本 `0.0.1` 唔能夠證明 npm 可用。喺呢個 checkout 入面，例子需要嘅唯一 go-like 依賴係 `@go-like/core`。

## M0：領域規則

`src/service.ts` 擁有 `BookAppointmentCommand`、repository 同重疊檢查。就算記憶體 repository 唔阻塞，Context 仍然係第一個參數。之後嘅儲存或快取可以用同一個簽名。

例子拒絕壞 id、非正數窗口、重疊，以及用唔同內容重用嘅 id。呢啲案例嘅測試同 repository 放埋一齊，冇 App，亦冇 HTTP。

## M1：政策服務

`src/contract.ts` 綁定操作：

```ts
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

const command = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: command,
    response: struct.object({ allowed: struct.literal(true) })
  }
})
```

`src/transport.ts` 將兩端放喺同一個 memory transport。位址 `memory://appointment-policy.v1` 唔係操作名稱。

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { appointmentPolicy } from "./contract"

const transport = newMemoryTransport()
const server = newServer(serverTransport(transport), address("memory://appointment-policy.v1"))
appointmentPolicy.registerHandler(server, {
  check(_ctx, command) {
    if (command.endsAt - command.startsAt > 7_200_000) {
      throw serviceError("appointment_policy_rejected", "appointment duration exceeds policy", 409)
    }
    return { allowed: true as const }
  }
})
const caller = appointmentPolicy.newClient(
  newClient(withTransport(transport), withEndpoint("memory://appointment-policy.v1"))
)
```

`src/http.ts` 係 `contextHandler`。佢將請求 Context 傳入預約同取消。HTTP 400 係畸形 body。HTTP 409 係被拒絕嘅預約。呢啲狀態係 Web Handler 嘅選擇。政策失敗係內部呼叫上 status 409 嘅 `ServiceError`。

## M2：availability 快取

Memory cache 係可選而且程序內嘅。Key 同 value 都係 bytes。Repository 保持權威：命中就跳過讀取，未命中或過期就再讀，預約或取消會刪除 key。快取錯誤唔可以變成一次成功預約。

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` 唔係 `Server`。`@go-like/redis/cache` 係 `Server`；嗰隻放喺 `resources(...)`。

## M3：liveness 同 readiness

建立一個 registry，令 App 指向佢，再自己分派 `/livez` 同 `/readyz`。冇 `readyProbe`，`/readyz` 保持 503。

```ts
import { newApp, readyProbe, server } from "@go-like/core"
import { newProbeRegistry } from "@go-like/core/health"
import { createHealthHandler, type Handler } from "@go-like/core/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policyServer.endpoint(ctx)
})
const health = createHealthHandler(probes)

const handler: Handler = async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/livez" || pathname === "/readyz") return await health(request)
  return appointmentHandler(request)
}

const app = newApp(readyProbe(probes), server(policyServer, web))
void handler
void app
```

## M4：一個生命週期持有者

例子入面嘅 `src/main.ts` 係組合根：repository、政策服務、Handler、`newNodeServer`、`signal()`，以及喺寫 `GO_LIKE_EXAMPLE_READY` 之前等 `endpoint(ctx)` 嘅 `afterStart`。你暴露 `/readyz` 時加上 `readyProbe`。如果政策 client 活得比 memory server 耐，喺 `afterStop` 關閉佢。

```ts
import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
  })
)
await app.run()
```

`server(...)` 一齊啟動兩個參與者。政策 server 係程序內嘅，所以唔需要資源層。Redis 快取或檔案儲存就需要。

## M5：測試確立咗咩

`test/main.test.ts` 檢驗記憶體規則同內部呼叫。通過嘅單元測試唔確立 Docker、已發布 tarball，或者正式預約系統。如果你聲稱一個結果，就記錄該命令。見[驗證](/zh-Hant-HK/reference/verification)。

## 排查

| 症狀                  | 檢查                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `Cannot find package` | 行 `bun install --frozen-lockfile`。Import 係 `@go-like/core/...`。 |
| HTTP 404              | Handler 唔識呢條路徑。健康路由唔會幫你掛上。                        |
| HTTP 400              | JSON body 冇通過 Handler 自己嘅檢查。                               |
| HTTP 409              | Repository 或政策拒絕咗該 command。                                 |
| 有型別呼叫驗證失敗    | 請求或回應唔符合 Struct。                                           |
| Client 去唔到 server  | Client 同 server 必須共用同一個 `newMemoryTransport()` 實例。       |
| `app.run()` 唔返回    | 佢等到停止。`signal()` 或 `app.stop()` 先結束佢。                   |
| `EADDRINUSE`          | 埠已被佔用。                                                        |
| 快取值消失            | Memory cache 係程序內嘅。TTL 同 `delete` 亦會移除佢。               |
| `/readyz` 係 503      | 註冊一個 ready probe，包括 `readyProbe(probes)`。                   |
