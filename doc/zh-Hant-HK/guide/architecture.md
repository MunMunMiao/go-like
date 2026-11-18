# 架構

go-like 係一層組合。`@go-like/core` 宣告插座，並實作唔需要第三方 client 嘅機制。插頭填一個插座。應用建立原生物件、砌好插頭，再揀 App 邊一層擁有佢。

有用嘅問題係：邊個接納呢個物件、佢坐喺邊一層、邊個觀察佢嘅終態結果，以及邊個 runtime 或後端令個結果有意義？

## 插座同插頭

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

Core 喺固定呼叫點記錄每個工作單元。插頭唔會包住 `newClient` 或 Web Handler 去加一個 span。Core 內部嘅 import 方向由 `test/portable-lane.test.ts` 強制：較低層唔 import 根入口。

## 三層

`newApp(...options)` 按參數次序套用 option。同一個物件唔可以同時出現喺 `resources(...)` 同 `server(...)`。將 `Telemetry` bundle 傳入任何一個清單都係型別錯誤，亦係 runtime `TypeError`。

| 層     | Option                             | 啟動                                                                                                               | 停止                                                                                                         |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 遙測   | `telemetry(tel)` 取代之前嘅 bundle | 最先。先 log handler，再 tracer，再 meter。每個 `lifecycle.start` 都會檢查係咪即時失敗。失敗會回滾已經啟動嘅部分。 | 最後，喺 `afterStop` 之後，用佢自己嘅 `stopTimeout` 時限。Tracer 同 meter 一齊 drain，然後先至 log handler。 |
| 資源   | `resources(...)` 取代之前嘅清單    | 喺 `beforeStart` 之後、任何 server 之前。按宣告次序。每個 `start(ctx)` 都會 await，而且必須喺資源可用時 resolve。  | 所有已啟動嘅 server 停咗之後，按宣告嘅反向次序。一次 stop 失敗會記錄低，下一個資源仍然會停。                 |
| Server | `server(...)` 取代之前嘅清單       | 全部 `start` 呼叫先發出，然後做一次即時失敗檢查。`start` 可以一直 pending，直到原生物件結束。可選 `Endpointer`。   | 並行 `stop`，然後 join 每個 `start` promise。                                                                |

Hook：`beforeStart` 喺資源層之前行。`afterStart` 喺註冊之後行。`beforeStop` 喺撤銷註冊之前行。`afterStop` 喺資源層之後、遙測 drain 之前行。啟動 hook 一失敗就停。停止 hook 當清理來行。

註冊只用 Server 層。資源係依賴，唔係要公布嘅位址。

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

`run()` 只可以行一次。`stop()` 係冪等嘅，而且共用同一個 promise。`App.stop()` 唔接收 Context。第一個停止原因贏：`App.stop()` 同 `signal()` 係 `requested`，父 Context 結束係 `context_canceled`，啟動失敗係 `start_failed`，ready 之後已接納參與者失敗係 `server_failed`。一個失敗會原樣拋出。多個失敗會按階段次序合成一個 `AggregateError`，遙測放最後。

Sibling server 冇反向次序保證。如果 worker 一定要喺 queue 之前停，將 queue 放喺 `resources(...)`，worker 放喺 `server(...)`。資源層嘅存在，就係令呢個組合等接納完成。手寫 `Server` 如果 `start` 永遠唔 resolve，就會卡住資源層嘅接納；原生物件用 `newResourceServer`，或者將長命參與者放喺 `server(...)`。

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

長時間運行嘅 `start(ctx)` 收到佢自己那一層嘅 Context。呢個 Context 會活到該層被要求停止，所以 server 仲喺度 drain 嗰陣，資源睇唔到取消。遙測用自己嘅 Context，原因一樣：停機一開始就取消 `appContext`，唔可以喺佢觀察緊嘅 server 之前 drain 遙測。

## 時限同持有

`startTimeout` 覆蓋 hook、資源接納、endpoint 準備、註冊同 `afterStart`。佢唔覆蓋遙測接納，亦唔會將 server 嘅 `start` 變成就緒 promise。預設 `0` 代表冇上限。`registrarTimeout` 預設 10 秒，限制 register 同 deregister 呼叫。

`stopTimeout` 係 hook、撤銷註冊、Server 層同資源層共用嘅呼叫方等待時限。遙測 drain 喺該階段開始時再開一段同樣長度嘅時限，所以共用時限用盡之後，export 仍然可以完成。一個永不結束嘅 drain 會令 `App.run()` 大約等兩倍 `stopTimeout`。預設 `0` 代表兩段都冇上限。共用時限已經用盡之後，後面嘅 `stop` 呼叫仍然會發出。Core 唔會繼續等，逾時亦唔係原生終態。插頭自己嘅逾時留喺插頭：OpenTelemetry 關閉預設係 25 秒，Pino drain 預設係 25 秒，Winston handler 冇自己嘅 drain 逾時。

`start` resolve 之後，App 擁有該參與者。`newResourceServer({ open, terminal, close })` 喺 `open` 完成時 resolve `start`；省略 `open` 就即時 resolve。`close` 係唯一嘅持有者 drain，呼叫時用第一次停止 Context 嘅 `withoutCancel`。`open` 失敗就唔會呼叫 `close`。第二次 `start` 會以 `GO_LIKE_RESOURCE_ALREADY_STARTED` 拒絕。乾淨嘅 `terminal` 喺停止之前結束，會令 App 以 `GO_LIKE_RESOURCE_CLOSED` 失敗。`Error` resolution 或 rejection 會令 App 以該錯誤失敗。Terminal promise 係私人觀察嘅；佢唔係公開插座欄位。

## 就緒

`readyProbe(registry, name?)` 註冊一個同步 probe，預設名稱 `"app"`。只有 `run()` 處於 ready 階段先至通過，而且同 `go_like.app.ready` gauge 同一刻翻轉。窗口之外會拋 `AppNotReadyError`（`GO_LIKE_APP_NOT_READY`），`phase` 係 `created`、`starting`、`stopping` 或 `stopped`。`run()` 結束之後，probe 會被移除。從未運行過嘅 App 保持 `created`。

`createHealthHandler(probes)` 投影 `/livez` 同 `/readyz`。空 liveness 通過。空 readiness fail closed，所以冇 `readyProbe` 或其他 ready probe 嘅 Handler，`/readyz` 會回 503。每個已註冊嘅 ready probe 都要通過。Core 唔會註冊 liveness probe。

內部 `newServer` listener 仍然會以空 200 回應 `GET` 同 `HEAD` `/healthz`。呢個回應代表 unary listener 接受咗請求。佢唔係 probe registry。

## Listener 同公布埠

例子綁定 `127.0.0.1` 再呼叫該位址，係正確嘅本機形狀。Docker 公布埠可以喺容器仲未提供協議之前，就經 proxy 接受 TCP。你啟動嘅拓撲如果係 Compose 網絡，就用服務 DNS 接觸 Redis、AMQP、etcd 同應用 HTTP。

Server 層上嘅 `Server.start(ctx)` 唔代表就緒。`Endpointer.endpoint(ctx)` 返回一個可以公布嘅位址。`afterStart` 代表 Core 去到咗呢個 hook。

`startRecoveringRabbitMqBroker` 可以喺 connector 設定完成之前接納 broker handle，所以 HTTP 可以唔等 AMQP 就綁定。有世代存在之前，發布保持關閉。呢個係接納 handle，唔係一條健康路由。

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

操作身份係 `service/endpoint`，例如 `appointment-policy.v1/check`。`ServiceInstance` 嘅 endpoint 係不透明傳輸位址，例如 `memory://orders` 或 `https://orders.example`。

## Runtime 可攜性

可攜入口用標準 JavaScript 同 Web API，或者呼叫方注入嘅能力。可攜入口唔承諾 TCP listener、程序信號、檔案監看、UDP multicast 或廠商 client。

| 入口                                                                                          | 喺邊度行                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@go-like/core` 概念入口，包括 `/web`、`/transport/http`、`/transport/memory`                 | 可攜。`/transport/http` 用 Fetch 撥出。監聽需要注入嘅 host。        |
| `@go-like/core/node`、`/transport/http/node`、`/web/node`、`/config/node`                     | Node API。`/web/node` 亦可以喺呢啲 API 存在嘅地方行。               |
| `@go-like/core/web/bun`                                                                       | Bun host。                                                          |
| `@go-like/mdns/registry/node`、`@go-like/zookeeper/registry/node`、`@go-like/file/store/node` | 該插頭嘅 Node host。兄弟入口喺注入嘅 host 或 factory 之上保持可攜。 |
| `@go-like/connectrpc`                                                                         | 可攜 Fetch Handler。                                                |
| `@go-like/connectrpc/node`                                                                    | Node gRPC server 同 client。                                        |
| NATS、RabbitMQ、Redis、BullMQ                                                                 | Node 同 Bun，跟原生 client。                                        |

套件 export 唔使用條件式 `bun` 或 `node` condition。Import 你想要嘅 subpath。TypeScript `DOM` library 提供型別。佢唔係 runtime polyfill。

## 組合

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

`newApp` 唔會變成容器，memory transport 亦唔會變成網絡。憑證、factory，以及 App 冇收到嘅物件嘅關閉，留喺組合根。

較早嘅設計筆記用過 `ServerHandle`、`AppHandle` 呢類名稱。呢頁嘅簽名先係今日匯出嘅簽名。`Server` 同 `Endpointer` 由 `@go-like/core/lifecycle` 匯出，唔係由根入口匯出。
