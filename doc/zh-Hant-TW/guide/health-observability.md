# 健康檢查與可觀測性

`@likego/health` 分開處理 liveness 與 readiness。空的 liveness registry 會回報健康，因為程序的確還活著；空的 readiness registry 則 fail closed，沒有任何就緒探針時不該先收流量。需要 HTTP 端點時，可用 `@likego/web/health` 轉成標準 Web 回應。

指標和追蹤都採顯式組裝。`@likego/prometheus` 服務應用自己持有的 `prom-client` Registry，不動全域 Registry。`@likego/otel` 接受應用建立的 OpenTelemetry provider，也提供 Client、unary middleware、Broker wrapper；它不會安裝全域 provider、exporter、context manager 或自動 instrumentation。

日誌同樣保留原生能力。`@likego/pino`、`@likego/winston` 只負責 destination 或 logger 的關閉邊界，level、遮罩、格式、transport、child logger 與欄位規範都由應用決定。

指標 label 要限制值域，憑證不能放進 attribute。若要維持非同步 trace 親子關係，應用必須安裝該 runtime 支援的 context manager；匯出失敗也要老實反映在終態，不能靜默略過。
