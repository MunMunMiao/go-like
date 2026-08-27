# 健康檢查與可觀測性

`@go-like/health` 分開處理 liveness 與 readiness。空的 liveness registry 會回報健康，因為程序的確還活著；空的 readiness registry 則 fail closed，沒有任何就緒探針時不該先收流量。需要 HTTP 端點時，可用 `@go-like/web/health` 轉成標準 Web 回應。預設路徑是 `GET /livez` 與 `GET /readyz`：健康回應 `200`，失敗回應 `503`，不支援的方法回應 `405`，未知路徑回應 `404`。空的 liveness 是 `200`，空的 readiness 是 `503`；必須由應用程式把 Handler 掛到自己的 Web router/host 才會出現這兩個路徑。

```ts
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"

const probes = newProbeRegistry()
const health = createHealthHandler(probes)
// 在應用程式自己的 route table 將 /livez 與 /readyz 指向 health。
```

如果應用程式已把 health Handler 掛在 `127.0.0.1:3000`，可以執行 `curl -i http://127.0.0.1:3000/livez`；單獨執行這個指令不會自動建立 endpoint。

指標和追蹤都採顯式組裝。`@go-like/prometheus` 服務應用自己持有的 `prom-client` Registry，不動全域 Registry。`@go-like/otel` 接受應用建立的 OpenTelemetry provider，也提供 Client、unary middleware、Broker wrapper；它不會安裝全域 provider、exporter、context manager 或自動 instrumentation。

日誌同樣保留原生能力。`@go-like/pino`、`@go-like/winston` 只負責 destination 或 logger 的關閉邊界，level、遮罩、格式、transport、child logger 與欄位規範都由應用決定。

指標 label 要限制值域，憑證不能放進 attribute。若要維持非同步 trace 親子關係，應用必須安裝該 runtime 支援的 context manager；匯出失敗也要老實反映在終態，不能靜默略過。
