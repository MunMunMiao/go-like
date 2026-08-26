# 診所預約：從 0 到 1

這是一條從 0 到 1 的引導專案路徑，透過真實業務不變量（無論請求從哪裡來都必須維持的規則）學習 go-like，而不是再做一個泛用的 Todo list。頁面描述目標結構和可執行 checkpoint，不宣稱目標目錄已經作為可以複製執行的完整應用程式提交。專案是一個診所預約服務，包含程序內 policy service（負責驗證預約規則的內部服務）、作為權威來源的預約 repository、可丟棄的 availability cache、health endpoints，以及一個明確的 application lifecycle。

repository 已經有 `examples/healthcare-appointments`，本指南以它為起點。它目前使用 raw JSON `Message` 處理 policy service。下面的 typed `Endpoint` 與 `Struct` 版本，是根據目前的 public exports 寫出的升級路徑；本次文件階段沒有把它加入範例。描述驗證結果時，請把這兩件事分開看待。

## 業務不變量

服務必須維持五條規則：

1. 同一位醫師不能有時間重疊的 active appointments。
2. 取消預約後，時段重新可用。
3. 使用同一個 appointment ID 重複提交相同的預約請求時，操作必須具冪等性。
4. 重複使用 appointment ID，但提交不同的預約內容時，必須拒絕。
5. Availability 只作為加速手段快取；repository 仍然是權威來源。

目前 repository 範例用記憶體內的 repository 實作前四條規則，並透過內部 policy service 驗證預約的最長時間。它沒有宣稱提供資料庫、分散式鎖、持久化 cache、authentication 或正式上線等級的預約流程。

## 你會建立什麼

```text
clinic-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- contract.ts       # typed policy Endpoint and Structs
|   |-- service.ts        # domain invariant and canonical repository
|   |-- transport.ts      # policy Server and Client over Memory Transport
|   |-- cache.ts          # availability cache and invalidation policy
|   |-- http.ts           # Fetch routes and health delegation
|   `-- main.ts           # one composition root and one Core App
`-- test/
    |-- main.test.ts      # domain, typed call, HTTP, cache, health, cancellation
    `-- node-e2e.ts       # real bind, request, stop, and port release
```

現有 workspace example 目前的目錄樹比較小：

```text
examples/healthcare-appointments/
|-- package.json
|-- tsconfig.json
|-- README.md
|-- src/
|   |-- service.ts
|   |-- transport.ts      # current raw JSON policy boundary
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

第二棵樹才是目前 checkout 中已經存在的真實結構。第一棵樹是本教學各個里程碑的目標形狀。

## 前置條件與指令

在 repository 根目錄執行：

```sh
bun install --frozen-lockfile
```

目前 checkout 中，packages 透過 workspace dependencies 互相連結。Repository 不會把 runtime 或工具版本當成執行資格。每個被選取的驗證 lane 只檢查所需工具能否執行，並記錄實際環境；執行結果由命令行為與結果決定，而不是由版本號決定。目前 package 文件說明這些 packages 尚未發布到 npm。

執行現有的 baseline example：

```sh
HOST=127.0.0.1 PORT=3000 bun run --cwd examples/healthcare-appointments start
```

`start` script 會建置 root packages、建立 prepared Node bundle，再執行它。送出流量前，先等到出現 `GO_LIKE_EXAMPLE_READY` 那一行。在另一個終端機執行：

```sh
NOW=$(($(date +%s) * 1000))
curl -i -sS http://127.0.0.1:3000/v1/appointments \
  -H 'content-type: application/json' \
  -d "{\"appointmentId\":\"appointment-1\",\"doctorId\":\"doctor-1\",\"patientId\":\"patient-1\",\"startsAt\":$((NOW + 3600000)),\"endsAt\":$((NOW + 5400000))}"

curl -i -sS -X DELETE \
  http://127.0.0.1:3000/v1/appointments/appointment-1
```

使用 `Ctrl-C` 停掉前景程序。不要為 policy service 另外啟動一個隱藏的 App；目前範例把 policy Server 與 Web Server 放在同一個 Core App 中。

目前範例的 focused checks 是：

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
```

範例還宣告了一個 E2E wrapper：

```sh
bun run --cwd examples/healthcare-appointments test:e2e
```

這個指令會建置並執行 example E2E task。它是可以執行的指令，不表示目前 checkout 已經通過。

## M0：先寫領域規則

領域模組即使使用的記憶體內 repository 關鍵區段是同步的，也應該採用 Context-first 形式。這樣取消能力與未來替換 provider 的邊界都會清楚可見：

```ts
import type { Context } from "@go-like/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment extends BookAppointmentCommand {
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}
```

Repository 在修改狀態前應該檢查 `ctx.err()`。目前範例的 `newMemoryAppointmentRepository()` 會這樣做，並且為每個 appointment 保存 fingerprint。它使用下面的 overlap predicate：

```ts
function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}
```

這個 predicate 允許相鄰的預約，但會讓同一位醫師的 active appointments 在重疊時失敗。取消會把儲存的 status 改成 `cancelled`；再次取消會回傳同一筆已取消的記錄。

### M0 測試

加入 HTTP 或 transport 前，先寫這些測試：

```ts
import { background } from "@go-like/context"
import { expect, test } from "bun:test"

// The concrete repository factory is the one in src/service.ts.
test("rejects an overlapping active slot", () => {
  const repository = newMemoryAppointmentRepository()
  const book = newBookAppointment(repository, () => 1_000)
  book(background(), {
    appointmentId: "a-1",
    doctorId: "doctor-1",
    patientId: "patient-1",
    startsAt: 2_000,
    endsAt: 3_000
  })

  expect(() =>
    book(background(), {
      appointmentId: "a-2",
      doctorId: "doctor-1",
      patientId: "patient-2",
      startsAt: 2_500,
      endsAt: 3_500
    })
  ).toThrow("doctor time conflict")
})
```

目前的 `test/main.test.ts` 已經包含這個案例，以及取消重用、冪等取消和 HTTP handler 檢查。在你的環境執行上面指令之前，這些測試只是已經檢視過的 repository evidence。

## M1：一個 typed internal policy service

typed internal contract 使用 `@go-like/struct` 與 `@go-like/transport`。這是 unary Message 邊界上的 runtime validation，不是 IDL 或 generated RPC service。

### `src/contract.ts`

```ts
import { struct, type Infer } from "@go-like/struct"
import { endpoint } from "@go-like/transport"

const CheckRequest = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const CheckResponse = struct.object({
  allowed: struct.boolean()
})

export type CheckRequest = Infer<typeof CheckRequest>
export type CheckResponse = Infer<typeof CheckResponse>

export const checkAppointment = endpoint(
  "appointment-policy",
  "AppointmentPolicy.Check",
  CheckRequest,
  CheckResponse
)
```

route token 使用可見的 ASCII，而且不能包含 `/` 或 `*`。`Endpoint` 包含 request 與 response Struct 實例，以及兩個 route token。它不描述網路位址，也不代表產生式 client。

### `src/transport.ts`

```ts
import { newClient, withAddress, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"

import { checkAppointment, type CheckRequest, type CheckResponse } from "./contract"

const policyAddress = "memory://appointment-policy"

export interface AppointmentPolicy {
  readonly server: Server
  validate(ctx: Context, request: CheckRequest): Promise<CheckResponse>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const client = newClient(withTransport(transport))
  const server = newServer(
    serverTransport(transport),
    address(policyAddress),
    handler(checkAppointment, (_ctx, request) => {
      if (request.endsAt - request.startsAt > maximumDurationMs) {
        throw new Error("appointment duration exceeds policy")
      }
      return { allowed: true }
    })
  )

  return Object.freeze({
    server,
    async validate(ctx: Context, request: CheckRequest): Promise<CheckResponse> {
      return await client.call(ctx, checkAppointment, request, withAddress(policyAddress))
    },
    close(ctx: Context): Promise<void> {
      return client.close(ctx)
    }
  })
}
```

目前提交的範例使用 raw `Message` policy handler，以及 status 為 `409` 的 `serviceError(...)`。這是有效的低階邊界。上面的 typed 版本改變的是 request 與 response codec，不是核心所有權模型：一個 Memory Transport 實例、一個內部 Server、一個 Client，以及明確的 close。

### 持續傳遞 Context

預約 use case 應該把同一個 request Context 傳給 policy Client 與 repository：

```ts
async function validatedBook(ctx: Context, command: CheckRequest): Promise<Appointment> {
  await policy.validate(ctx, command)
  return repository.book(ctx, command)
}
```

用 `background()` 取代 `ctx` 會遺失 request deadline、取消訊號與 Context ancestry。這是 correctness regression，不是無害的簡化。

### M1 測試

至少測試以下內容：

| 測試                   | 預期結果                                            |
| ---------------------- | --------------------------------------------------- |
| valid typed request    | `allowed: true`，並建立 booked appointment          |
| overlong request       | 在 repository mutation 前失敗                       |
| invalid field type     | typed request decode failure                        |
| invalid response shape | 在 Server boundary 的 typed response encode failure |
| canceled Context       | policy 與 repository 觀察到同一個 cancellation      |
| client close           | resident Transport Client 的 cleanup 是明確的       |

目前範例的 policy test 已經驗證會在 repository mutation 前拒絕，以及能透過 `Client -> Memory Transport -> Server` 成功呼叫。typed test 是建議增加的擴充。

## M2：availability Cache

Cache 適合用來做讀取投影，不適合當成預約的權威來源。Cache package 提供 Context-first 的 `get`、`put` 與 `delete`；`@go-like/cache-memory` 提供 `newMemoryCache()`，`@go-like/cache` 提供 `expiresIn(...)`：

```ts
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"

const availabilityCache = newMemoryCache()

async function readAvailability(ctx: Context, doctorId: string) {
  const key = `availability/${doctorId}`
  const cached = await availabilityCache.get(ctx, key)
  if (cached !== null) {
    return JSON.parse(new TextDecoder().decode(cached)) as Availability
  }

  const authoritative = repository.readAvailability(ctx, doctorId)
  await availabilityCache.put(
    ctx,
    key,
    new TextEncoder().encode(JSON.stringify(authoritative)),
    expiresIn(30_000)
  )
  return authoritative
}

async function invalidateAvailability(ctx: Context, doctorId: string): Promise<void> {
  await availabilityCache.delete(ctx, `availability/${doctorId}`)
}
```

`repository.readAvailability(...)` 是本教學中由應用程式擁有的方法，不是 go-like export。Booking 與 cancellation 都必須在權威 mutation 後刪除這個 key。如果失效操作失敗，應該回報失敗並選擇明確的一致性策略；不要默默把 cache 當成預約的事實來源。

### M2 測試

- miss 會讀取 repository 並填入 cache；
- hit 不會再次讀取 repository；
- booking 或 cancellation 會刪除 projection；
- 過期值會回退到 repository；
- cache failure 不會把正確的 authoritative read 變成錯誤的 booking result；
- 程序重啟會依設計遺失 Memory Cache 狀態。

## M3：liveness 與 readiness

在 composition root 建立 registry，並把兩個路徑委派給 `createHealthHandler(...)`：

```ts
import { createHealthHandler } from "@go-like/web/health"
import { newProbeRegistry } from "@go-like/health"
import type { Handler } from "@go-like/web"

const probes = newProbeRegistry()
probes.register("ready", "policy", async (ctx) => {
  await policy.server.endpoint(ctx)
})

const healthHandler = createHealthHandler(probes)
const appointmentHandler: Handler = newAppointmentHandler(book, cancel)

const webHandler: Handler = (request) => {
  const path = new URL(request.url).pathname
  if (path === "/livez" || path === "/readyz") return healthHandler(request)
  return appointmentHandler(request)
}
```

預設路由是 `/livez` 與 `/readyz`。空的 liveness 是 healthy；空的 readiness 則 fail closed。上面的 `policy` probe 讓 readiness 依賴內部 listener admission，但不會假裝外部資料庫永遠等同於程序 liveness。

正式服務只應該把真正位於流量前方的依賴加入 readiness。Probe name 是 public identifier，health payload 會刻意進行脫敏。

## M4：一個生命週期擁有者

Composition root 應該只建立一次資源，並把它們放進同一個 App：

```ts
import process from "node:process"
import { afterStart, afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

const policy = newAppointmentPolicy()
const httpServer = newNodeServer(webHandler, hostname("127.0.0.1"), port(3000))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async (ctx) => {
    await httpServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=healthcare-appointments\n")
  }),
  afterStop((ctx) => policy.close(ctx))
)

await app.run()
```

`afterStop` hook 是 policy Client 的明確順序邊界。Core 本身會並行停止 sibling Servers。如果依賴更複雜，需要嚴格順序，就把相關資源組合進一個 Server 或明確的 hook，不要依賴宣告順序。

`signal()` 是 Node/Bun process adapter。領域程式碼、typed contract、Memory Transport 與 health modules 可以保持可攜；匯入 `@go-like/core/node` 是一個有意識的 runtime 選擇。

## M5：測試計畫與證據

| 層次       | 測試                                                               | 證據目標                                        |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| Domain     | overlap、cancellation reuse、idempotency、conflicting ID           | `src/service.ts` 行為與 unit test 結果          |
| Context    | canceled booking 不會修改 repository，也不會呼叫 policy            | focused Context test                            |
| Typed call | Struct decode/encode、policy rejection、response validation        | `@go-like/client` 與 `@go-like/server` boundary |
| Cache      | miss、hit、TTL、invalidation、failure fallback                     | `newMemoryCache()` tests                        |
| Health     | empty liveness、empty readiness、failing probe、405/404            | `newProbeRegistry()` 與 `createHealthHandler()` |
| HTTP       | `POST`、`DELETE`、invalid JSON、conflict status                    | standard Fetch Handler test                     |
| Lifecycle  | policy 與 Web Server 在同一個 App 下被 admitted；明確 close Client | Core App 與 Server terminal behavior            |
| Node E2E   | real bind、request、signal、stop、port release                     | example E2E wrapper 與 residual checks          |

目前 repository example 的 focused commands 是：

```sh
bun run --cwd examples/healthcare-appointments typecheck
bun run --cwd examples/healthcare-appointments test:unit
bun run --cwd examples/healthcare-appointments test:e2e
```

整個 examples lane：

```sh
bun run test:e2e:examples
```

完整 E2E lane 會建置 packages 並使用 repository runner。Docker providers 與 cross-runtime consumers 屬於不同範圍。請記錄 candidate commit、runtime versions、exit status、summary，以及殘留程序或 container；有 script 不等於執行通過。

## 里程碑

| 里程碑 | 交付物                                         | 何時進入下一步                                           |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| M0     | Domain repository 與 invariant tests           | overlap 與 cancellation 行為已確定                       |
| M1     | 透過 Memory Transport 的 typed policy Endpoint | 呼叫確實經過 Client/Server/Transport，而不是直接呼叫函式 |
| M2     | 帶有 invalidation 的 cache projection          | cache failure 不會取代 authority                         |
| M3     | `/livez` 與 `/readyz`                          | 已理解空 readiness 與 failing probes                     |
| M4     | 一個 App、signal、明確的 Client cleanup        | 每個 admitted resource 都有一個 owner                    |
| M5     | Unit 與 Node E2E evidence                      | 結果已連同 command 與 exit status 記錄                   |

在這些里程碑清楚之前，不要加入 Registry、Redis、Vault、真正的 Broker、authentication 或 retries。每一項都會增加新的所有權或故障模型，應該有意識地引入。

## 故障排除

### `Cannot find package "@go-like/..."`

你可能在 workspace 外執行，或正在依賴尚未發布的 package。請從 repository 根目錄執行 `bun install --frozen-lockfile`，並執行 workspace script，例如 `bun run --cwd examples/healthcare-appointments start`。

### 請求回傳 `404`

目前範例只暴露 `POST /v1/appointments` 與 `DELETE /v1/appointments/{appointmentId}`。檢查 method、path 與 `GO_LIKE_EXAMPLE_READY` 那一行。Health routes 屬於 M3 tutorial extension，不在目前已提交的範例中。

### 請求回傳 `400`

範例要求 ID 是字串，`startsAt`／`endsAt` 是數字。相對於注入的 clock，`startsAt` 必須在未來，而且 `endsAt` 必須大於 `startsAt`。確認 shell arithmetic 產生的是數字，而不是帶引號的字串。

### 請求回傳 `409`

可能是醫師時段與 active appointment 重疊、appointment ID 被不同內容重複使用，或 policy service 拒絕了預約時間長度。policy 在 repository mutation 前呼叫，因此 policy rejection 不應該建立記錄。

### typed call 回報 invalid request 或 response body

檢查 client 與 server 是否使用同一組 `Endpoint` Structs，並確認 request Content-Type 正好是 `application/json`。`handler(contract, fn)` 會在 Server boundary 做 JSON 與 Struct validation。

### Memory Client 無法連到 Server

`newMemoryTransport()` 建立的是實例私有的 address map。Client 與 Server 必須共用同一個 Transport 實例，而且綁定的 `memory:` address 必須完全一致。在兩個分別建立的 Memory Transport 實例中使用相同 URL，並不會連通。

### `app.run()` 看起來卡住了

長時間執行的 `Server.start(ctx)` 可能會一直 pending，直到服務生命週期結束，這是預期行為。`app.run()` 會在 stop 與終態 cleanup 後 resolve，不會在 listener 剛綁定後立即 resolve。使用 `afterStart` 或 `server.endpoint(ctx)` 觀察 admission signal。

### Stop 回傳 timeout 或 aggregate error

timeout 限制的是呼叫方等待 cleanup 的時間，不代表原生資源已經停止；sibling Servers 會並行停止。判斷 shutdown 是否乾淨前，請檢查 primary error、adapter terminal barrier，以及殘留程序或 socket 證據。

### Cache 資料消失了

`@go-like/cache-memory` 是程序內且可丟棄的。權威記錄應使用明確的 Store provider，並記錄它實際的 durability 與 ownership；不要把 Cache 當成資料庫。

## 邊界回顧

這個專案用一條真實但維持小巧的路徑教你使用 go-like：

```text
Request
  -> standard Fetch Handler
  -> Context-first appointment use case
  -> typed Client call
  -> Memory Transport
  -> unary Server policy handler
  -> canonical appointment repository
  -> disposable availability Cache
  -> Response

App.stop()
  -> deregistration if configured
  -> concurrent Server stop
  -> explicit Client / provider cleanup
  -> terminal result
```

它不涉及 gRPC、Protobuf、IDL generation、內部全雙工 streams、分散式鎖、持久化訊息或正式上線等級的 authentication。這些屬於小型專案之外的獨立設計決策。
