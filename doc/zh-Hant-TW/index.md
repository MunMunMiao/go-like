# LikeGo

LikeGo 是一套給 TypeScript 後端使用的 Go 風格微服務工具套件。它把生命週期、Context、服務呼叫、服務探索、訊息、設定、儲存、健康檢查與可觀測性拆成清楚的小套件，不會要求團隊把現有框架或 runtime 全部換掉。

可攜式程式碼只依賴標準 Web API，像是 `Request`、`Response`、`Headers`、`AbortSignal`、Web Streams 與外部傳入的 `fetch`。Node.js、Bun、Deno 專屬能力會放在獨立入口。已經匯出 Fetch 的框架不需要 LikeGo 適配套件：Hono、Elysia 與 H3 2.x 的 `app.fetch` 可以直接交給 `@likego/web`；H3 1.x 使用 `toWebHandler(app)`。Croner、BullMQ、NATS、Pino、Winston 等資源才使用生命週期適配器。

第一次閱讀建議從[開始使用](/zh-Hant-TW/guide/getting-started)開始，再看[架構](/zh-Hant-TW/guide/architecture)。[套件參考](/zh-Hant-TW/reference/packages)列出每個責任邊界；[驗證](/zh-Hant-TW/reference/verification)則說明哪些能力真的跑過測試，而不是只停在「照理說應該可以」。

## 這裡所說的 Go 風格

會阻塞的工作把 Context 放在第一個參數、資源由誰持有要講清楚、停止後要有穩定終態，小介面則透過結構型別實作。這不代表硬搬 Go 的命名或 channel；TypeScript 仍使用自然的 export，第三方套件特有語意也保留在原生物件上。
