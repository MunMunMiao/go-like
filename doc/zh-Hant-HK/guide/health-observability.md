# 健康檢查與可觀測性

`@likego/health` 分開處理 liveness 同 readiness。空 liveness registry 會回報健康，因為程序的確仲行緊；空 readiness registry 就 fail closed，未有任何就緒 probe 時唔應該先收流量。要 HTTP endpoint 可以用 `@likego/web/health` 轉成標準 Web response。

指標同追蹤都係顯式裝配。`@likego/prometheus` 服務應用自己擁有嘅 `prom-client` Registry，唔會掂 global Registry。`@likego/otel` 接受應用建立嘅 OpenTelemetry provider，亦有 Client、unary middleware、Broker wrapper；佢唔會安裝 global provider、exporter、context manager 或自動 instrumentation。

日誌同樣保留原生能力。`@likego/pino`、`@likego/winston` 只負責 destination 或 logger 嘅關閉邊界，level、redaction、格式、transport、child logger 同欄位規範全部由應用決定。

指標 label 要限制值域，憑證唔可以塞入 attribute。要保持 async trace 父子關係，應用必須安裝 runtime 真正支援嘅 context manager；匯出失敗亦要如實反映喺終態，唔可以靜靜吞咗。
