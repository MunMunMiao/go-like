# go-like

go-like 是一套給 Bun 與 Node.js 上的後端服務使用的、界線明確的 TypeScript 組裝元件。`@go-like/core` 是零 runtime 依賴的插座面板：Context、應用程式生命週期、內部呼叫、設定、服務探索、資料記錄、快取、訊息、工作、健康檢查，以及 telemetry 的基礎。另外十九個套件是插頭。插頭用應用程式自己建立的生態系用戶端，填入一個或多個插座。`@go-like/protoc-gen-like` 是建置期的 Protobuf 產生器，不依賴 core。

應用程式仍然是組裝根。它建立原生物件，傳給插頭的建構函式，再把結果裝到 `newApp` 上。這裡沒有 server、logger 或 telemetry provider 的全域登錄。

> [!IMPORTANT]
> 這個 checkout 是私人的 `0.0.1` 工作區。Manifest 上的版本不能證明 npm 上已可安裝。範例使用 workspace 套件；除非另行確認已有正式發布，否則應從 checkout 執行。

> [!NOTE]
> 英文 `doc/` 樹是這條文件線的基準來源。套件原始碼、manifest 與針對性測試才是 API 的依據。Repository 裡存在的測試或 E2E 腳本只表示已宣告的覆蓋範圍；在指令實際跑過、且結束狀態被記錄之前，它不是通過結果。

## 選一條閱讀路線

| 讀者                       | 從這裡開始                                    | 接著讀                                                                                | 可以進下一階段的時候                                            |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 剛接觸 go-like             | [開始使用](/zh-Hant-TW/guide/getting-started) | [架構](/zh-Hant-TW/guide/architecture)、[診所預約專案](/zh-Hant-TW/guide/zero-to-one) | 能啟動一個 Web 服務、傳入 Context、露出健康檢查，並把它停止     |
| 有經驗的 TypeScript 工程師 | [架構](/zh-Hant-TW/guide/architecture)        | [服務呼叫](/zh-Hant-TW/guide/service-call)、[工具比較](/zh-Hant-TW/guide/comparison)  | 能說出每個資源的擁有者、層級與終態邊界                          |
| Go 或 Kratos 讀者          | [開始使用](/zh-Hant-TW/guide/getting-started) | [術語](/reference/terminology)、[服務呼叫](/zh-Hant-TW/guide/service-call)            | 能對上 Context 與 Server 的概念，且不會假設 gRPC 或 Go ABI 相容 |
| 框架使用者                 | [工具比較](/zh-Hant-TW/guide/comparison)      | [遷移與導入](/zh-Hant-TW/guide/migration)、[架構](/zh-Hant-TW/guide/architecture)     | 能保留原本的 router，只加上需要的生命週期或呼叫邊界             |
| 插頭作者                   | [Provider](/zh-Hant-TW/reference/providers)   | [驗證](/zh-Hant-TW/reference/verification)、[聲明與證據](/reference/claims)           | 能說出一個插頭的插座、runtime、擁有權與證據限制                 |

## 基準學習路徑

`doc/guide/` 下的四頁基準路徑是刻意由淺入深的：

1. [開始使用](/zh-Hant-TW/guide/getting-started)跑一個標準 Fetch Handler、一個 Node host、一個接納訊號，以及一個 App。
2. [診所預約](/zh-Hant-TW/guide/zero-to-one)把生命週期做成一個具體領域、內部 unary 呼叫、快取、健康檢查、測試與停止練習。
3. [工具比較](/zh-Hant-TW/guide/comparison)說明 go-like 與 NestJS、Fastify、Hono、Elysia、Koa、tRPC、go-micro、go-kratos 之間那些刻意不同的地方。
4. [遷移與導入](/zh-Hant-TW/guide/migration)把遷移前的套件對到這 20 個套件的配置。

[套件](/zh-Hant-TW/reference/packages)是 20 個套件、75 個公開入口的清單。[Provider](/zh-Hant-TW/reference/providers)指向每個生態系插頭的 README。

## 心智模型

三條規則貫穿整個函式庫：

1. **Context 優先。** 每個 I/O 操作都把 `ctx: Context` 放在第一個參數。Context 帶著取消、deadline、AppInfo、請求 metadata，以及目前的 telemetry 狀態。
2. **明確組裝。** 應用程式建立每一個實作再傳進來。插頭不會把自己註冊到全域。
3. **一件事一條路。** 用 `newBrokerServer` 訂閱，用 `newScheduleServer` 排程，用 `JobQueue.worker` 消費佇列，用 `newResourceServer` 接上原生資源，用 `readyProbe` 加上 `createHealthHandler` 發布就緒。

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

五個名詞就夠讀完這個站：

- **插座**是 core 宣告的結構式契約（`Server`、`LogHandler`、`Registry`、`Broker`、`Store`，以及其他）。插頭實作插座。它不包裝 core 的呼叫點。
- **Context** 是可取消工作的明確範圍。
- **Server** 是 `start(ctx)` 與 `stop(ctx)`。在 `resources(...)` 裡，`start` 會在資源可用時 resolve。在 `server(...)` 裡，`start` 可以一直 pending，直到原生物件結束。
- **App** 接納這些層級、hook、註冊與關閉。它不是依賴注入容器。
- **Handler** 是標準 Web 函式 `(Request) => Response | Promise<Response>`。Handler 本身不是正在監聽的 server。

對外 Web 與內部服務呼叫保持分開。產生的 Protobuf RPC 是另一條可選路徑：`@go-like/protoc-gen-like` 產生 ctx-first 的接線程式碼，`@go-like/connectrpc` 把 Connect 與 gRPC-Web 接到 Fetch，`@go-like/connectrpc/node` 託管標準 gRPC。見[串流處理](/zh-Hant-TW/guide/streaming)。

## 應用程式仍然擁有的部分

目前的產品邊界把這些留給應用程式或原生函式庫：

- 路由、框架 middleware、Web Streams 與 WebSocket upgrade；
- 業務政策、credentials 與授權；
- 原生的 acknowledgement、lease、重試與協定細節；
- OpenTelemetry SDK 的建立、logger 設定，以及 exporter 的選擇；
- 耐久性、交易，以及記憶體參考實作的任何跨程序意義；
- 從 manifest 推論出來的 npm 發布、託管 CI 狀態或正式環境就緒主張。

## 公開清單

這個工作區發布 **20** 個 `@go-like/*` 套件，在這個 checkout 都是版本 `0.0.1`，以及 **75** 個公開入口。`@go-like/core` 貢獻 41 個入口。其餘 34 個入口屬於插頭與產生器。產生出來的 `dist/package.json` metadata export 不是額外的原始碼 API。

用[套件參考](/zh-Hant-TW/reference/packages)選擇入口，用 [Provider 索引](/zh-Hant-TW/reference/providers)打開插頭 README。[聲明與證據](/reference/claims)記錄公開措辭背後的證據等級。

## 驗證邊界

一份歷史上的 repository 契約稽核，在 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` 報告了本機結果：`bun run typecheck`、`bun run test:unit` 與 `bun run fmt:check` 通過。該報告計數為 2,736 個單元測試、1,514 個已格式化檔案，以及 66 個原始碼匯出入口的匯入稽核成功。那個計數描述的是遷移前的樹。目前的清單是 75 個入口。該稽核沒有確立 `build`、`doc:build`、Docker provider E2E、已發布 tarball 的取用端、npm 發布、託管 CI，或 60 分鐘 soak。

把原始碼或腳本上的主張轉成發布主張之前，先讀[驗證](/zh-Hant-TW/reference/verification)。

## 下一步

- [開始使用](/zh-Hant-TW/guide/getting-started)：跑一個 Web handler，以及第一個生命週期檢查點。
- [架構](/zh-Hant-TW/guide/architecture)：層級、Context 範圍、啟動與停止順序、就緒，以及時間預算。
- [診所預約](/zh-Hant-TW/guide/zero-to-one)：一條業務不變條件，從 HTTP 走到內部政策呼叫、健康檢查與關閉。
- [服務呼叫](/zh-Hant-TW/guide/service-call)：帶型別的 Memory Transport，然後是服務探索、選擇與重試。
- [設定、服務註冊、儲存與快取](/zh-Hant-TW/guide/config-registry-store)：四個契約，每個生態系共用一個用戶端。
- [訊息代理、事件與工作](/zh-Hant-TW/guide/broker-events)：位元組、codec、排程與佇列。
- [健康檢查與可觀測性](/zh-Hant-TW/guide/health-observability)：探針、`newTelemetry`，以及四個 telemetry 插頭。
- [工具比較](/zh-Hant-TW/guide/comparison)與[遷移與導入](/zh-Hant-TW/guide/migration)：相對其他工具的擁有權，以及 import codemod。
- [套件](/zh-Hant-TW/reference/packages)、[Provider](/zh-Hant-TW/reference/providers)、[錯誤處理](/reference/errors)、[術語](/reference/terminology)與[驗證](/zh-Hant-TW/reference/verification)。

Node 26.12.1 與 Bun 1.4.4 的託管 gRPC 慢速消費者 drain，記錄在[原生 gRPC drain 矩陣](/reference/claims#native-grpc-drain-status)。較早的 Connect 2.1.2 與 Bun 1.4.2 Fetch 取消觀察，仍留在[聲明與證據](/reference/claims#stream-cancellation-limits)。
