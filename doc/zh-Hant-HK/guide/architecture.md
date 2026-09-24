# 架構

go-like 採用平鋪、可以獨立發布嘅套件，唔係一個乜都包辦嘅大框架。`@go-like/core` 組合應用同 Server 生命週期，`@go-like/context` 傳遞取消、限期、原因同值；其餘 SPI 各自定義一個能力領域，具體後端放喺獨立 provider 套件。

整體可以分幾條線：應用面負責啟動、接納、hook 同終態；Core 會並行呼叫各個 sibling Server 嘅 `stop(ctx)`，等待各自嘅 terminal result，再彙總 lifecycle failure，但唔保證按反向宣告次序停止。呼叫面包含服務探索、節點選擇、Client、Server 投影同 Transport；事件面處理 Broker 同 typed codec；營運面有設定快照、Store、健康檢查、指標、追蹤同日誌；對外 Web 接標準 Fetch Handler，同內部 transport 分得開。需要依次關閉嘅元件，應該喺同一個 `Server` 入面組合次序。

依賴方向會集中去可攜接口。Provider 可以用官方 SDK 或 runtime host，但 SPI 唔會反過來依賴某個實作，所以 Bun、Node.js、Deno 或其他支援 Web API 嘅後端都可以共用組合方式。

go-like 冇 service locator。應用自己建立依賴再傳入，多幾行裝配其實有著數：connection、watcher、listener 同關閉責任全部睇得見，出事時唔使估。

> [!NOTE]
> 呢頁係方便快速睇嘅本地化摘要。完整 lifecycle DAG、ownership map 同各 provider 嘅邊界，請睇[英文 canonical 頁面](/guide/architecture)；呢份摘要唔承諾所有 runtime 都有通用 parity。

## Request 同 lifecycle 地圖

```text
application composition root
  -> Context：取消 / deadline / values
  -> Core App：接納 / hooks / stop 結果
  -> Web Handler -> runtime host -> listener
  -> 內部 Client -> Discovery -> Selector -> Transport -> Server

App.stop()
  -> 撤銷已接納 instance
  -> 取消 Server runtime
  -> 並行呼叫 Server.stop
  -> 等 terminal result -> 一個結果
```

`Server.start(ctx)` 或 `afterStart` 本身唔代表 readiness。要喺 hook 入面等 `endpoint(ctx)` 或資源本身嘅接納訊號，再宣布就緒。Core 會並行停止 sibling Server；需要嚴格次序嘅資源應放喺同一個 owner。
