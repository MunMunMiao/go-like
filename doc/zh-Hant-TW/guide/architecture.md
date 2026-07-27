# 架構

LikeGo 使用平鋪、可以獨立發布的套件，而不是做成一個包辦全部功能的大框架。`@likego/core` 組合應用程式與 Server 生命週期，`@likego/context` 傳遞取消、期限、原因和值；其餘 SPI 各自定義一個能力領域，實作則留在獨立 provider 套件。

整體可分成幾個平面：應用平面負責啟動、接納、透過 `Promise.allSettled` 彙整各個 Server 的並行停止結果、hook 與終態；呼叫平面包含服務探索、節點選擇、Client、Server 投影和 Transport；事件平面處理 Broker 與 typed codec；維運平面包括設定快照、Store、健康檢查、指標、追蹤及日誌；對外 Web 則接標準 Fetch Handler，跟內部傳輸不是同一層。需要依序關閉的元件，應在同一個 `Server` 內組合其順序。

依賴方向往可攜式介面集中。Provider 可以使用官方 SDK 或 runtime host，但 SPI 不會反過來依賴具體實作，所以 Bun、Node.js、Deno 或其他支援 Web API 的後端能共用同一套業務組合。

LikeGo 沒有 service locator。應用程式自己建立依賴再傳入；多幾行組裝程式其實很划算，因為 connection、watcher、listener 和關閉責任都看得見。
