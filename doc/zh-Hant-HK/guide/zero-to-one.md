# 診所預約：由 0 到 1

呢份係一條用真實業務不變量（無論請求由邊度嚟都要守住嘅規則）學 go-like 嘅小型 project 路線，唔係再砌一個泛用 Todo list。目標係整一個診所預約服務，入面有程序內 policy service（驗證預約規則嘅內部服務）、作為權威來源嘅預約 repository、可丟棄嘅 availability cache、health endpoints，同一個清楚嘅 application lifecycle。頁面會分開講目前 checkout 真係有咩，同埋逐個 milestone 要自己加咩，避免將設計練習講成已經存在嘅完整 project。

repo 而家已經有 `examples/healthcare-appointments`，呢份指南由佢開始。而家嘅 policy service 用 `defineService("appointment-policy.v1")` 嘅 `check`、`withEndpoint("memory://appointment-policy.v1")` 同 `serviceError(..., 409)`。下面片段跟呢個 example 一致。

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
|   |-- transport.ts      # defineService appointment-policy.v1
|   |-- http.ts
|   `-- main.ts
`-- test/main.test.ts
```

第二棵樹才是目前 checkout 中已經存在的真實結構。第一棵樹是本教學各個里程碑的目標形狀。

## 前置條件同指令

在 repository 根目錄執行：

```sh
bun install --frozen-lockfile
```

呢個 checkout 使用版本 `0.0.1` 嘅 `workspace:*` 套件。Manifest 版本唔能夠證明 npm 可用；喺 workspace 外安裝之前，要獨立核實發布狀態。

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

用 `Ctrl-C` 停前景程序。唔好另外開一個睇唔見嘅 App 畀 policy service；而家個 example 將 policy Server 同 Web Server 放喺同一個 Core App 入面。

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
import { newBookAppointment, newMemoryAppointmentRepository } from "../src/service"
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

typed internal contract 使用 `@go-like/struct` 與 `@go-like/transport` 的 `defineService`。這是 JSON Fetch body 上的 runtime Struct validation，不是 IDL 或 generated Protobuf service。

### `src/contract.ts`

```ts
import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"

const appointmentPolicyCommand = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const appointmentPolicyDecision = struct.object({
  allowed: struct.literal(true)
})

export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: appointmentPolicyCommand,
    response: appointmentPolicyDecision
  }
})
```

路由 token 匹配 `^[A-Za-z0-9._~-]+$`（URL unreserved），且不能恰好是 `.` 或 `..`。`defineService` 的服務名和每個 endpoint 鍵組成 URL 路徑 `/<service>/<endpoint>`。它們不是網路位址。節點位址由 `withEndpoint` 提供。

### `src/transport.ts`

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/client"
import type { Context } from "@go-like/context"
import { address, newServer, transport as serverTransport, type Server } from "@go-like/server"
import { serviceError } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

import { appointmentPolicy } from "./contract"

const policyAddress = "memory://appointment-policy.v1"

export interface AppointmentPolicy {
  readonly server: Server
  validate(
    ctx: Context,
    command: {
      readonly appointmentId: string
      readonly doctorId: string
      readonly patientId: string
      readonly startsAt: number
      readonly endsAt: number
    }
  ): Promise<void>
  close(ctx: Context): Promise<void>
}

export function newAppointmentPolicy(maximumDurationMs = 7_200_000): AppointmentPolicy {
  const transport = newMemoryTransport()
  const server = newServer(serverTransport(transport), address(policyAddress))
  appointmentPolicy.registerHandler(server, {
    check(_ctx, command) {
      if (command.endsAt - command.startsAt > maximumDurationMs) {
        throw serviceError(
          "appointment_policy_rejected",
          "appointment duration exceeds policy",
          409
        )
      }
      return { allowed: true }
    }
  })
  const client = newClient(withTransport(transport), withEndpoint(policyAddress))
  const caller = appointmentPolicy.newClient(client)
  const policy: AppointmentPolicy = {
    server,
    async validate(ctx, command) {
      await caller.check(ctx, command)
    },
    close(ctx) {
      return client.close(ctx)
    }
  }
  return Object.freeze(policy)
}
```

已提交的範例用 `appointmentPolicy.registerHandler` 登記 `check`，過長預約以 `serviceError(..., 409)` 拒絕。所有權不變：一個 Memory Transport 實例、一個內部 Server、一個 Client，以及對該 Client 的明確 close。

### 持續傳遞 Context

預約 use case 應該把同一個 request Context 傳給 policy Client 與 repository：

```ts
import type { Context } from "@go-like/context"

interface BookCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

interface Appointment {
  readonly id: string
}

declare const policy: {
  validate(ctx: Context, command: BookCommand): Promise<void>
}
declare const repository: {
  book(ctx: Context, command: BookCommand): Promise<Appointment>
}

async function validatedBook(ctx: Context, command: BookCommand): Promise<Appointment> {
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
import type { Context } from "@go-like/context"
import { expiresIn } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"
import type { AppointmentRepository } from "./service"

interface Availability {
  readonly doctorId: string
  readonly slots: readonly { readonly startsAt: number; readonly endsAt: number }[]
}

interface AvailabilityRepository extends AppointmentRepository {
  readAvailability(ctx: Context, doctorId: string): Availability
}

const availabilityCache = newMemoryCache()
declare const repository: AvailabilityRepository

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
import type { Context } from "@go-like/context"
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"
import type { Handler } from "@go-like/web"

import type { Appointment, BookAppointmentCommand } from "./service"
import { newBookAppointment, newCancelAppointment, newMemoryAppointmentRepository } from "./service"
import { newAppointmentPolicy } from "./transport"
import { newAppointmentHandler } from "./http"

const repository = newMemoryAppointmentRepository()
const policy = newAppointmentPolicy()
const book = async (ctx: Context, command: BookAppointmentCommand): Promise<Appointment> => {
  const decision = await policy.validate(ctx, command)
  if (!decision.allowed) throw new Error("appointment policy rejected request")
  return newBookAppointment(repository)(ctx, command)
}
const cancel = newCancelAppointment(repository)
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

## 遇到問題點算

### `Cannot find package "@go-like/..."`

你可能在 workspace 外執行，或正在依賴尚未發布的 package。請從 repository 根目錄執行 `bun install --frozen-lockfile`，並執行 workspace script，例如 `bun run --cwd examples/healthcare-appointments start`。

### 請求回傳 `404`

目前範例只暴露 `POST /v1/appointments` 與 `DELETE /v1/appointments/{appointmentId}`。檢查 method、path 與 `GO_LIKE_EXAMPLE_READY` 那一行。Health routes 屬於 M3 tutorial extension，不在目前已提交的範例中。

### 請求回傳 `400`

範例要求 ID 是字串，`startsAt`／`endsAt` 是數字。相對於注入的 clock，`startsAt` 必須在未來，而且 `endsAt` 必須大於 `startsAt`。確認 shell arithmetic 產生的是數字，而不是帶引號的字串。

### 請求回傳 `409`

可能是醫師時段與 active appointment 重疊、appointment ID 被不同內容重複使用，或 policy service 拒絕了預約時間長度。policy 在 repository mutation 前呼叫，因此 policy rejection 不應該建立記錄。

### typed call 回報 invalid request 或 response body

檢查 client 同 server 是否使用同一組 `Endpoint` Structs，並確認 request Content-Type 正好係 `application/json`。`server.registerHandler(contract, fn)` 會喺 Server boundary 做 JSON 同 Struct validation。

### Memory Client 無法連到 Server

`newMemoryTransport()` 建立的是實例私有的 address map。Client 與 Server 必須共用同一個 Transport 實例，而且綁定的 `memory:` address 必須完全一致。在兩個分別建立的 Memory Transport 實例中使用相同 URL，並不會連通。

### `app.run()` 看起來卡住了

`Server.start(ctx)` 或 `afterStart` 本身唔代表 readiness。要喺 hook 入面等 `endpoint(ctx)` 或資源本身嘅接納訊號，再宣布就緒。Core 會並行停止 sibling Server；需要嚴格次序嘅資源應放喺同一個 owner。

### Stop 回傳 timeout 或 aggregate error

timeout 限制的是呼叫方等待 cleanup 的時間，不代表原生資源已經停止；sibling Servers 會並行停止。判斷 shutdown 是否乾淨前，請檢查 primary error、adapter terminal barrier，以及殘留程序或 socket 證據。

### Cache 資料消失了

`@go-like/cache-memory` 是程序內且可丟棄的。權威記錄應使用明確的 Store provider，並記錄它實際的 durability 與 ownership；不要把 Cache 當成資料庫。

## 邊界回顧

呢個 project 用一條真實但保持細小嘅路線教你用 go-like：

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
