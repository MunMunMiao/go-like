# 健康檢查與可觀測性

`@go-like/health` 分開處理 liveness 同 readiness。空 liveness registry 會回報健康，因為程序的確仲行緊；空 readiness registry 就 fail closed，未有任何就緒 probe 時唔應該先收流量。要 HTTP endpoint 可以用 `@go-like/web/health` 轉成標準 Web response。預設路徑係 `GET /livez` 同 `GET /readyz`：健康回 `200`，失敗回 `503`，唔支援嘅 method 回 `405`，未知路徑回 `404`。空 liveness 係 `200`，空 readiness 係 `503`；要由應用自己將 Handler 掛入 Web router/host 先會有呢兩條路徑。

```ts
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"

const probes = newProbeRegistry()
const health = createHealthHandler(probes)
// 喺應用自己嘅 route table 將 /livez 同 /readyz 指向 health。
```

如果已經將 health Handler 掛喺 `127.0.0.1:3000`，可以用 `curl -i http://127.0.0.1:3000/livez` 檢查；單獨執行呢條 command 唔會自動建立 endpoint。

指標同追蹤都係顯式裝配。`@go-like/prometheus` 服務應用自己擁有嘅 `prom-client` Registry，唔會掂 global Registry。`@go-like/otel` 接受應用建立嘅 OpenTelemetry provider，亦有 Client、unary middleware、Broker wrapper；佢唔會安裝 global provider、exporter、context manager 或自動 instrumentation。

日誌同樣保留原生能力。`@go-like/pino`、`@go-like/winston` 只負責 destination 或 logger 嘅關閉邊界，level、redaction、格式、transport、child logger 同欄位規範全部由應用決定。

指標 label 要限制值域，憑證唔可以塞入 attribute。要保持 async trace 父子關係，應用必須安裝 runtime 真正支援嘅 context manager；匯出失敗亦要如實反映喺終態，唔可以靜靜吞咗。
