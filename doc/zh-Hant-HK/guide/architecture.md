# 架構

LikeGo 採用平鋪、可以獨立發布嘅套件，唔係一個乜都包辦嘅大框架。`@likego/core` 組合應用同 Server 生命週期，`@likego/context` 傳遞取消、限期、原因同值；其餘 SPI 各自定義一個能力領域，具體後端放喺獨立 provider 套件。

整體可以分幾條線：應用面負責啟動、接納、透過 `Promise.allSettled` 彙總各個 Server 嘅並行停止結果、hook 同終態；呼叫面包含服務探索、節點選擇、Client、Server 投影同 Transport；事件面處理 Broker 同 typed codec；運維面有設定快照、Store、健康檢查、指標、追蹤同日誌；對外 Web 接標準 Fetch Handler，同內部 transport 分得開。需要依次關閉嘅元件，應該喺同一個 `Server` 入面組合次序。

依賴方向會集中去可攜接口。Provider 可以用官方 SDK 或 runtime host，但 SPI 唔會反過來依賴某個實作，所以 Bun、Node.js、Deno 或其他支援 Web API 嘅後端都可以共用組合方式。

LikeGo 冇 service locator。應用自己建立依賴再傳入，多幾行裝配其實有著數：connection、watcher、listener 同關閉責任全部睇得見，出事時唔使估。
