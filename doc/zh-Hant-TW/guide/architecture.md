# 架構

go-like 使用平鋪、可以獨立發布的套件，而不是做成一個包辦全部功能的大框架。`@go-like/core` 組合應用程式與 Server 生命週期，`@go-like/context` 傳遞取消、期限、原因和值；其餘 SPI 各自定義一個能力領域，實作則留在獨立 provider 套件。

整體可分成幾個平面：應用平面負責啟動、接納、hook 與終態；Core 會並行呼叫各個 sibling Server 的 `stop(ctx)`，等待各自的 terminal result，再彙整 lifecycle failure，但不保證按反向宣告順序停止。需要依序關閉的元件，應在同一個 `Server` 內組合其順序；呼叫平面包含服務探索、節點選擇、Client、Server 投影和 Transport；事件平面處理 Broker 與 typed codec；維運平面包括設定快照、Store、健康檢查、指標、追蹤及日誌；對外 Web 則接標準 Fetch Handler，跟內部傳輸不是同一層。

依賴方向往可攜式介面集中。Provider 可以使用官方 SDK 或 runtime host，但 SPI 不會反過來依賴具體實作，所以 Bun、Node.js、Deno 或其他支援 Web API 的後端能共用同一套業務組合。

go-like 沒有 service locator。應用程式自己建立依賴再傳入；多幾行組裝程式其實很划算，因為 connection、watcher、listener 和關閉責任都看得見。

> [!NOTE]
> 這頁是方便快速閱讀的本地化摘要。完整 lifecycle DAG、ownership map 與各 provider 的邊界，請看[英文 canonical 頁面](/guide/architecture)；這份摘要不承諾所有 runtime 都有通用 parity。

## Request 與 lifecycle 地圖

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
  -> 等待 terminal result -> 一個結果
```

`Server.start(ctx)` 不等於 readiness。要觀察 admission，請用 `endpoint(ctx)` 或 `afterStart` hook。Core 也不保證 sibling Server 會按反向順序停止；如果順序重要，就把相關資源組合在同一個 `Server` 或明確 hook 裡。
