# 診所預約：從 0 到 1

這條路徑用一次內部政策呼叫、一個 Fetch handler、健康檢查與一個 App，跟著一條業務不變條件走。可執行的樹是 `examples/healthcare-appointments`。下面的片段使用那個範例的名稱。可丟棄的可預約時段快取是你在同一個組裝根裡另外加上的里程碑。它不是第二個事實來源。

## 不變條件

1. 同一位醫師不能有時間重疊的有效預約。
2. 取消會釋出時段。
3. 以相同內容重複同一個預約 id 是冪等的。
4. 用不同內容重用同一個預約 id 會被拒絕。
5. 若另外加上可預約時段的快取投影，它本身不能授權一筆預約。

這個範例用記憶體中的 repository 實作前四條規則，並透過 `appointment-policy.v1/check` 檢查最長時長。它沒有主張資料庫、分散式鎖、身分驗證，或正式營運的診所流程。

## 目錄結構

```text
examples/healthcare-appointments/
  src/contract.ts    defineService and Structs
  src/service.ts     repository and booking rules
  src/transport.ts   memory Server and Client
  src/http.ts        Fetch handler
  src/main.ts        Node host and App
  test/main.test.ts
```

從 repository 根目錄：

```sh
bun install --frozen-lockfile
bun run --cwd examples/healthcare-appointments test:unit
```

套件版本 `0.0.1` 不能證明 npm 上已可安裝。在這個 checkout 裡，範例需要的 go-like 依賴只有 `@go-like/core`。

## M0：領域規則

`src/service.ts` 擁有 `BookAppointmentCommand`、repository 與重疊檢查。即使記憶體中的 repository 不會阻塞，Context 仍是第一個參數。之後的 store 或快取可以使用同一個簽章。

這個範例拒絕不合法的 id、非正的時間窗、重疊，以及用不同內容重用的 id。那些案例的測試放在 repository 旁邊，不需要 App，也不需要 HTTP。

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

`src/transport.ts` 把兩端放在同一個 memory transport 上。位址 `memory://appointment-policy.v1` 不是操作名稱。

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

`src/http.ts` 是一個 `contextHandler`。它把請求 Context 轉進預約與取消。HTTP 400 是畸形的 body。HTTP 409 是被拒絕的預約。那些狀態是 Web handler 的選擇。政策失敗在內部呼叫上是 status 409 的 `ServiceError`。

## M2：可預約時段快取

記憶體快取是可選的，而且只在這個程序裡。鍵與值都是位元組。Repository 維持權威：命中就略過一次讀取，未命中或過期就再讀一次，預約或取消會刪除那個鍵。快取錯誤不可以變成一次成功的預約。

```ts
import { expiresIn } from "@go-like/core/cache"
import { newMemoryCache } from "@go-like/core/cache/memory"

const cache = newMemoryCache()
await cache.put(ctx, key, bytes, expiresIn(5_000))
const hit = await cache.get(ctx, key)
```

`newMemoryCache` 不是 `Server`。`@go-like/redis/cache` 是 `Server`；那個要放進 `resources(...)`。

## M3：存活與就緒

建立一個 registry，讓 App 指向它，並自己分派 `/livez` 與 `/readyz`。沒有 `readyProbe` 時，`/readyz` 維持 503。

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

## M4：一個生命週期擁有者

範例裡的 `src/main.ts` 是組裝根：repository、政策服務、handler、`newNodeServer`、`signal()`，以及在寫出 `GO_LIKE_EXAMPLE_READY` 之前等待 `endpoint(ctx)` 的 `afterStart`。要露出 `/readyz` 時加上 `readyProbe`。如果政策用戶端比 memory server 活得更久，在 `afterStop` 關閉它。

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

`server(...)` 一起啟動兩個參與者。政策 server 在程序內，所以不需要 resource 層級。Redis 快取或檔案儲存才需要。

## M5：測試所確立的範圍

`test/main.test.ts` 演練記憶體中的規則與內部呼叫。通過的單元測試沒有確立 Docker、已發布的 tarball，或一套正式營運的預約系統。若你要主張一個結果，把指令記錄下來。見[驗證](/zh-Hant-TW/reference/verification)。

## 問題排查

| 現象                  | 檢查                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `Cannot find package` | 執行 `bun install --frozen-lockfile`。Import 是 `@go-like/core/...`。 |
| HTTP 404              | Handler 不認識那條路徑。健康檢查路由不會替你掛上。                    |
| HTTP 400              | JSON body 沒有通過 handler 自己的檢查。                               |
| HTTP 409              | Repository 或政策拒絕了這道命令。                                     |
| 帶型別的呼叫驗證失敗  | 請求或回應不符合 Struct。                                             |
| 用戶端連不到 server   | 用戶端與 server 必須共用同一個 `newMemoryTransport()` 實例。          |
| `app.run()` 不會回傳  | 它會等到停止。`signal()` 或 `app.stop()` 會結束它。                   |
| `EADDRINUSE`          | 連接埠已被占用。                                                      |
| 快取值消失了          | 記憶體快取只在這個程序裡。TTL 與 `delete` 也會把它移除。              |
| `/readyz` 是 503      | 註冊一個就緒探針，包含 `readyProbe(probes)`。                         |
