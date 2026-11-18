# go-like

go-like 係一組明確嘅 TypeScript 建構元件，畀 Bun 同 Node.js 上嘅後端服務用。`@go-like/core` 係零 runtime 依賴嘅插座面板：Context、應用生命週期、內部呼叫、設定、服務探索、記錄、快取、訊息、作業、健康檢查，同遙測底座。其餘十九個套件係插頭。一隻插頭用應用自己建立嘅生態 client，填一個或多個插座。`@go-like/protoc-gen-like` 係建置時嘅 Protobuf 產生器，唔依賴 core。

應用仍然係組合根。佢建立原生物件，傳入插頭建構函式，再將結果裝上 `newApp`。冇一個全域登記處去放 server、logger 或遙測 provider。

> [!IMPORTANT]
> 呢個 checkout 係私人 `0.0.1` workspace。Manifest 版本唔能夠證明 npm 可用。例子用 workspace 套件，打算喺 checkout 入面行；除非獨立確認過有已發布版本。

> [!NOTE]
> 英文 `doc/` 樹係呢條文件軌道嘅 canonical 來源。套件原始碼、manifest 同針對性測試先係 API 權威。Repo 入面存在嘅測試或 E2E script 只係已宣告覆蓋；未真正跑過一條命令並記錄退出狀態之前，唔算通過。

## 揀一條閱讀路線

| 讀者                   | 由呢度開始                                       | 跟住讀                                                                                    | 準備好就係                                                      |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 初學 go-like           | [開始使用](/zh-Hant-HK/guide/getting-started)    | [架構](/zh-Hant-HK/guide/architecture)、[診所預約 project](/zh-Hant-HK/guide/zero-to-one) | 你可以啟動一個 Web 服務、傳入 Context、暴露健康檢查，然後停佢   |
| 熟手 TypeScript 工程師 | [架構](/zh-Hant-HK/guide/architecture)           | [服務呼叫](/zh-Hant-HK/guide/service-call)、[比較](/zh-Hant-HK/guide/comparison)          | 你可以講出每項資源嘅持有者、層同終態邊界                        |
| Go 或 Kratos 讀者      | [開始使用](/zh-Hant-HK/guide/getting-started)    | [術語](/reference/terminology)、[服務呼叫](/zh-Hant-HK/guide/service-call)                | 你可以對應 Context 同 Server 概念，而唔假設 gRPC 或 Go ABI 相容 |
| 框架使用者             | [比較](/zh-Hant-HK/guide/comparison)             | [遷移](/zh-Hant-HK/guide/migration)、[架構](/zh-Hant-HK/guide/architecture)               | 你可以保留原生 router，只加你需要嘅生命週期或呼叫邊界           |
| 插頭作者               | [Provider 索引](/zh-Hant-HK/reference/providers) | [驗證](/zh-Hant-HK/reference/verification)、[聲明](/reference/claims)                     | 你可以講出一隻插頭嘅插座、runtime、ownership 同證據限制         |

## Canonical 學習路線

`doc/guide/` 下面四頁 canonical 路線係故意逐步加深：

1. [開始使用](/zh-Hant-HK/guide/getting-started)：行一個標準 Fetch Handler、一個 Node host、一個接納訊號，同一個 App。
2. [診所預約](/zh-Hant-HK/guide/zero-to-one)：將生命週期變成具體領域、內部 unary 呼叫、快取、健康檢查、測試同停機練習。
3. [比較](/zh-Hant-HK/guide/comparison)：解釋 go-like 同 NestJS、Fastify、Hono、Elysia、Koa、tRPC、go-micro、go-kratos 刻意唔同嘅地方。
4. [遷移](/zh-Hant-HK/guide/migration)：將遷移前套件對應到 20 個套件嘅佈局。

[套件](/zh-Hant-HK/reference/packages)係 20 個套件、75 個公開入口嘅清單。[Provider](/zh-Hant-HK/reference/providers)指向每隻生態插頭嘅 README。

## 心智模型

三條規則貫穿成個程式庫：

1. **Context 優先。** 每次 I/O 都將 `ctx: Context` 放喺第一個參數。Context 帶取消、deadline、AppInfo、請求 metadata，同而家嘅遙測狀態。
2. **明確組合。** 應用建立每個實作再傳入。插頭唔會自己做全域註冊。
3. **每項工作一條路。** 用 `newBrokerServer` 訂閱，用 `newScheduleServer` 排程，用 `JobQueue.worker` 消費隊列，用 `newResourceServer` 接上原生資源，用 `readyProbe` 加 `createHealthHandler` 發布就緒。

```text
Application main.ts
  construct plugs from native objects the application created
  newTelemetry({...})  newConfig(...)  newServer(...)  newClient(...)
        |
        v
@go-like/core  newApp(...)
  telemetry(tel)     admitted first, drained last
  resources(...)     started in order, each start awaited, stopped in reverse
  server(...)        started together, stopped together
  registrar(r)       after the server tier is admitted
  readyProbe(...)    ready only between startup completion and stop
```

五個名詞就夠讀完成個網站：

- **插座**係 core 宣告嘅結構式契約（`Server`、`LogHandler`、`Registry`、`Broker`、`Store`，同其他）。插頭實作插座。佢唔會包住 core 嘅呼叫點。
- **Context** 係可取消工作嘅明確範圍。
- **Server** 係 `start(ctx)` 同 `stop(ctx)`。喺 `resources(...)` 入面，start resolve 代表資源可用。喺 `server(...)` 入面，start 可以一直 pending，直到原生物件結束。
- **App** 接納呢啲層、hook、註冊同停機。佢唔係依賴注入容器。
- **Handler** 係標準 Web 函式 `(Request) => Response | Promise<Response>`。Handler 本身唔係監聽中嘅 server。

對外 Web 同內部服務呼叫保持分開。產生出嚟嘅 Protobuf RPC 係再遠一步嘅可選路徑：`@go-like/protoc-gen-like` 產生 ctx-first 膠水，`@go-like/connectrpc` 將 Connect 同 gRPC-Web 適配到 Fetch，`@go-like/connectrpc/node` 託管標準 gRPC。見[串流](/zh-Hant-HK/guide/streaming)。

## 應用仍然擁有嘅部分

而家嘅產品邊界將下面呢啲留畀應用或原生程式庫：

- 路由、框架 middleware、Web Streams 同 WebSocket upgrade；
- 業務政策、憑證同授權；
- 原生 acknowledgement、lease、重試同協議細節；
- OpenTelemetry SDK 建構、logger 設定同 exporter 選擇；
- 持久性、交易，以及記憶體參考實作喺跨程序時嘅任何意義；
- npm 發布、hosted CI 狀態，或者由 manifest 推斷出嚟嘅 production-ready 聲明。

## 公開清單

Workspace 發布 **20** 個 `@go-like/*` 套件，呢個 checkout 全部係版本 `0.0.1`，同 **75** 個公開入口。`@go-like/core` 佔 41 個。其餘 34 個屬於插頭同產生器。產生出嚟嘅 `dist/package.json` metadata export 唔係額外嘅原始碼 API。

用[套件參考](/zh-Hant-HK/reference/packages)揀入口，用[Provider 索引](/zh-Hant-HK/reference/providers)打開插頭 README。[聲明帳](/reference/claims)記錄公開措辭背後嘅證據級別。

## 驗證邊界

一份歷史 repo 契約審查報告過 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` 嘅本機結果：`bun run typecheck`、`bun run test:unit` 同 `bun run fmt:check` 通過。該報告數到 2,736 個單元測試、1,514 個已格式化檔案，以及 66 個原始碼 export 入口嘅成功 import 審查。呢個數目描述遷移前嘅樹。而家嘅清單係 75 個入口。該審查冇確立 `build`、`doc:build`、Docker provider E2E、已發布 tarball consumer、npm 發布、hosted CI，或者 60 分鐘 soak。

將原始碼或 script 聲明變成發布聲明之前，先讀[驗證](/zh-Hant-HK/reference/verification)。

## 下一步

- [開始使用](/zh-Hant-HK/guide/getting-started)：行一個 Web Handler，同第一個生命週期檢查點。
- [架構](/zh-Hant-HK/guide/architecture)：層、Context 範圍、啟動同停止次序、就緒同埋時限。
- [診所預約](/zh-Hant-HK/guide/zero-to-one)：一條業務不變量，由 HTTP 去到內部政策呼叫、健康檢查同停機。
- [服務呼叫](/zh-Hant-HK/guide/service-call)：有型別嘅 Memory Transport，然後服務探索、選擇同重試。
- [設定、註冊中心、儲存同快取](/zh-Hant-HK/guide/config-registry-store)：四個契約，每個生態一個共用 client。
- [Broker、事件同作業](/zh-Hant-HK/guide/broker-events)：bytes、codec、排程同隊列。
- [健康檢查與可觀測性](/zh-Hant-HK/guide/health-observability)：probe、`newTelemetry`，同四隻遙測插頭。
- [比較](/zh-Hant-HK/guide/comparison)同[遷移](/zh-Hant-HK/guide/migration)：同其他工具嘅 ownership，以及 import codemod。
- [套件](/zh-Hant-HK/reference/packages)、[Provider](/zh-Hant-HK/reference/providers)、[錯誤處理](/reference/errors)、[術語](/reference/terminology)同[驗證](/zh-Hant-HK/reference/verification)。

Node 26.12.1 同 Bun 1.4.4 嘅託管 gRPC 慢消費者 drain 記錄喺[原生 gRPC drain 矩陣](/reference/claims#native-grpc-drain-status)。較早嘅 Connect 2.1.2 同 Bun 1.4.2 Fetch 取消觀察仍然留喺[聲明帳](/reference/claims#stream-cancellation-limits)。
