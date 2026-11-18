# 架構

go-like 是一層組裝。`@go-like/core` 宣告插座，並實作那些不需要第三方用戶端的機制。插頭填入一個插座。應用程式建立原生物件、建出插頭，並決定哪個 App 層級擁有它。

有用的問題是：誰接納這個物件、它坐在哪個層級、誰觀察它的終態，以及哪個 runtime 或後端賦予那個結果意義？

## 插座與插頭

```text
Application composition root
  |
  +--> Context, metadata, struct, health, resilience     core mechanisms
  |
  +--> Lifecycle
  |      telemetry(tel) -> resources(...) -> server(...) -> registrar
  |
  +--> External Web
  |      Handler on @go-like/core/web
  |      host on @go-like/core/web/node or @go-like/core/web/bun
  |
  +--> Internal calls
  |      Client, Server, Transport
  |      memory and Fetch transports in core; gRPC on @go-like/connectrpc
  |
  +--> State
  |      Config, Registry, Store, Cache sockets
  |      memory references in core; Consul, etcd, Vault, Kubernetes,
  |      ZooKeeper, mDNS, YAML, Redis, and file plugs
  |
  +--> Messages and jobs
  |      Broker and Job sockets
  |      memory broker in core; NATS, RabbitMQ, BullMQ, and Croner plugs
  |
  +--> Telemetry sockets
         LogHandler, TracerProvider, MeterProvider, Propagator
         filled by @go-like/otel, @go-like/pino/log, @go-like/winston/log,
         @go-like/prometheus/metric
```

Core 在固定的呼叫點記錄每個工作單元。插頭不會包裝 `newClient` 或 Web handler 來加一個 span。Core 內部的 import 方向由 `test/portable-lane.test.ts` 強制：較低的層不 import 根入口。

## 三個層級

`newApp(...options)` 依參數順序套用選項。同一個物件不能同時出現在 `resources(...)` 與 `server(...)`。把 `Telemetry` 套組傳進任一個清單，會是型別錯誤，也會是 runtime 的 `TypeError`。

| 層級      | 選項                            | 啟動                                                                                                                           | 停止                                                                                                         |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Telemetry | `telemetry(tel)` 取代上一個套組 | 最先。先是 log handler，然後是 tracer，然後是 meter。每個 `lifecycle.start` 都會檢查是否立刻失敗。失敗時會回滾已經啟動的那些。 | 最後，在 `afterStop` 之後，使用它自己的 `stopTimeout` 預算。Tracer 與 meter 一起 drain，然後是 log handler。 |
| Resources | `resources(...)` 取代上一個清單 | 在 `beforeStart` 之後、任何 server 之前。依宣告順序。每個 `start(ctx)` 都會被 await，而且必須在資源可用時 resolve。            | 每個已啟動的 server 都停止之後，依宣告的反向順序。一次停止失敗會被記錄下來，下一個資源仍會停止。             |
| Servers   | `server(...)` 取代上一個清單    | 先發出所有 `start` 呼叫，再做一次立刻失敗檢查。`start` 可以一直 pending，直到原生物件結束。可以選擇實作 `Endpointer`。         | 並行 `stop`，然後 join 每一個 `start` promise。                                                              |

Hook：`beforeStart` 在 resource 層級之前執行。`afterStart` 在註冊之後執行。`beforeStop` 在註銷之前執行。`afterStop` 在 resource 層級之後、telemetry drain 之前執行。啟動 hook 失敗即停。停止 hook 當作清理來跑。

註冊只用 server 層級。資源是依賴，不是要公告的位址。

```text
run()
  1  install signal() or another runtime option
  2  phase = starting
  3  admit telemetry
  4  open the start budget, if startTimeout is set
  5  beforeStart
  6  admit each resource and wait
  7  launch every server, then check for an immediate failure
  8  prepare endpoints and register, server tier only
  9  afterStart
 10  phase = ready; go_like.app.ready flips with the ready probe
 11  wait for stop or the first participant failure

stop()
  1  phase = stopping; the ready probe fails from this moment
  2  open the shared stop budget, if stopTimeout is set
  3  cancel the application Context
  4  join startup inside that budget
  5  beforeStop
  6  deregister
  7  cancel the server Context and stop launched servers concurrently
  8  join server start promises
  9  cancel the resource Context and stop owned resources in reverse order
 10  join resource start promises inside the same budget
 11  afterStop
 12  cancel the telemetry Context and stop the bundle on a fresh budget of the same length
```

`run()` 只能執行一次。`stop()` 是冪等的，並共用同一個 promise。`App.stop()` 不接收 Context。第一個停止原因勝出：`App.stop()` 與 `signal()` 是 `requested`；父 Context 結束時是 `context_canceled`；啟動失敗是 `start_failed`；就緒之後已接納的參與者失敗是 `server_failed`。單一失敗會以它自己被丟出。多個失敗會依階段順序組成一個 `AggregateError`，telemetry 放在最後。

兄弟 server 沒有反向順序的保證。如果 worker 必須在它的佇列之前停止，把佇列放進 `resources(...)`，把 worker 放進 `server(...)`。Resource 層級的存在，就是為了讓這個組合等待接納。手寫的 `Server` 若 `start` 永不 resolve，會卡住資源接納；原生物件用 `newResourceServer`，或把長時間存活的參與者放進 `server(...)`。

## Context 範圍

```text
parent
  -> appContext          canceled at the start of stop
       -> telemetryContext    canceled just before Telemetry.stop
       -> resourceContext     canceled just before the resource tier stops
       -> serverContext       canceled just before Server.stop
       -> startContext        appContext, plus startTimeout when configured
       -> stopContext         withoutCancel(appContext), plus the shared stopTimeout
       -> telemetryStop       a second stopTimeout, opened when the drain begins
```

長時間執行的 `start(ctx)` 收到的是它自己那個層級的 Context。那個 Context 會活到該層級被要求停止，所以資源在 server 仍在 drain 時不會看到取消。Telemetry 用自己的 Context，原因相同：在停止一開始就取消 `appContext`，不可以在它觀察的 server 之前把 telemetry drain 掉。

## 時間預算與擁有權

`startTimeout` 涵蓋 hook、資源接納、端點準備、註冊與 `afterStart`。它不涵蓋 telemetry 接納，也不會把 server 的 `start` 變成就緒 promise。預設 `0` 表示沒有上限。`registrarTimeout` 預設 10 秒，用來限制 register 與 deregister 呼叫。

`stopTimeout` 是 hook、註銷、server 層級與 resource 層級共用的呼叫端等待預算。Telemetry drain 在那個階段開始時，再開一段同樣長度的預算，所以匯出可以在共用預算用完之後仍然完成。一段永不 settle 的 drain 會讓 `App.run()` 大約等待兩倍的 `stopTimeout`。預設 `0` 表示兩段都沒有上限。共用預算已經用完時，後面的 `stop` 呼叫仍會發出。Core 不會繼續等，逾時也不是原生終態。插頭自己的逾時留在插頭：OpenTelemetry 關閉的預設是 25 秒，Pino drain 的預設是 25 秒，Winston handler 自己沒有 drain 逾時。

`start` resolve 之後，App 擁有這個參與者。`newResourceServer({ open, terminal, close })` 在 `open` 完成時 resolve `start`；省略 `open` 時則立刻 resolve。`close` 是唯一的擁有者 drain，呼叫時帶的是第一個停止 Context 的 `withoutCancel`。`open` 失敗時不會呼叫 `close`。第二次 `start` 會以 `GO_LIKE_RESOURCE_ALREADY_STARTED` 拒絕。在停止之前乾淨地 settle 的 `terminal`，會讓 App 以 `GO_LIKE_RESOURCE_CLOSED` 失敗。以 `Error` resolve 或 reject，會讓 App 帶著那個錯誤失敗。Terminal promise 是私下觀察的；它不是公開的插座欄位。

## 就緒

`readyProbe(registry, name?)` 註冊一個同步探針，預設名稱是 `"app"`。它只在 `run()` 處於 ready 階段時通過，而且與 `go_like.app.ready` gauge 在同一刻翻轉。窗口之外它丟出 `AppNotReadyError`（`GO_LIKE_APP_NOT_READY`），`phase` 為 `created`、`starting`、`stopping` 或 `stopped`。`run()` settle 之後，探針會被移除。從未執行過的 App 維持 `created`。

`createHealthHandler(probes)` 投影出 `/livez` 與 `/readyz`。空白的存活檢查通過。空白的就緒檢查失敗即關閉，所以沒有 `readyProbe` 或其他就緒探針的 handler，`/readyz` 會回 503。每一個已註冊的就緒探針都必須通過。Core 不會註冊存活探針。

內部的 `newServer` listener 仍會以空的 200 回答 `GET` 與 `HEAD` `/healthz`。那個回應表示 unary listener 接受了請求。它不是探針 registry。

## Listener 與發布的連接埠

綁定 `127.0.0.1` 再呼叫那個位址的範例，是正確的本機形狀。Docker 發布的連接埠可以在容器開始提供該協定之前，就經由 proxy 接受 TCP。若你啟動的拓撲是 Compose 網路，就用服務 DNS 連到 Redis、AMQP、etcd 與應用程式 HTTP。

Server 層級上的 `Server.start(ctx)` 不表示就緒。`Endpointer.endpoint(ctx)` 回傳一個可以公告的位址。`afterStart` 表示 Core 已經走到那個 hook。

`startRecoveringRabbitMqBroker` 可以在 connector 設定完成之前就接納一個 broker handle，所以 HTTP 可以綁定而不等待 AMQP。在 generation 出現之前，publish 維持關閉。那是 handle 的接納，不是一條健康檢查路由。

## 請求路徑

```text
External Web
  Request -> framework or Handler -> Response -> host writes the body

Internal unary
  Context + operation
    -> Client middleware
    -> direct address or Discovery snapshot
    -> Filters, then Selector
    -> Transport
    -> POST /<service>/<endpoint>
    -> Server middleware, Struct decode, handler, Struct encode
```

操作身分是 `service/endpoint`，例如 `appointment-policy.v1/check`。`ServiceInstance` 的 endpoint 是不透明的傳輸位址，例如 `memory://orders` 或 `https://orders.example`。

## Runtime 可攜性

可攜式入口使用標準 JavaScript 與 Web API，或呼叫端注入的能力。可攜式入口不承諾 TCP listener、程序訊號、檔案監看、UDP multicast 或廠商用戶端。

| 入口                                                                                          | 在哪裡執行                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `@go-like/core` 的概念入口，包含 `/web`、`/transport/http`、`/transport/memory`               | 可攜。`/transport/http` 用 Fetch 撥出。監聽需要注入的 host。          |
| `@go-like/core/node`、`/transport/http/node`、`/web/node`、`/config/node`                     | Node API。`/web/node` 在那些 API 存在的地方也可以跑。                 |
| `@go-like/core/web/bun`                                                                       | Bun host。                                                            |
| `@go-like/mdns/registry/node`、`@go-like/zookeeper/registry/node`、`@go-like/file/store/node` | 該插頭的 Node host。兄弟入口維持可攜，建在注入的 host 或 factory 上。 |
| `@go-like/connectrpc`                                                                         | 可攜的 Fetch handler。                                                |
| `@go-like/connectrpc/node`                                                                    | Node gRPC server 與用戶端。                                           |
| NATS、RabbitMQ、Redis、BullMQ                                                                 | Node 與 Bun，跟隨原生用戶端。                                         |

套件 export 不使用條件式的 `bun` 或 `node` condition。Import 你要的那個子路徑。TypeScript 的 `DOM` library 提供型別。它不是 runtime polyfill。

## 組裝

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { newNodeServer, port } from "@go-like/core/web/node"

const policy = defineService("policy", {
  check: {
    request: struct.object({ ok: struct.boolean() }),
    response: struct.object({ ok: struct.boolean() })
  }
})

const transport = newMemoryTransport()
const policyServer = newServer(serverTransport(transport), address("memory://policy"))
policy.registerHandler(policyServer, {
  check() {
    return { ok: true }
  }
})
const policyClient = newClient(withTransport(transport), withEndpoint("memory://policy"))
const webServer = newNodeServer((_request: Request) => new Response("ok"), port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
void app
```

`newApp` 不會變成容器，memory transport 也不會變成網路。Credentials、factory，以及 App 沒有拿到的那些物件的關閉，留在組裝根。

較早的設計筆記使用 `ServerHandle`、`AppHandle` 這類名稱。本頁上的簽章是今天匯出的那些。`Server` 與 `Endpointer` 從 `@go-like/core/lifecycle` 匯出，不是從根入口。
