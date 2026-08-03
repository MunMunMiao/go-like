# LikeGo

LikeGo 係一套畀 TypeScript 後端使用、帶 Go 風格嘅微服務工具組。生命週期、Context、服務呼叫、服務探索、訊息、設定、儲存、健康檢查同可觀測性都拆成細小而清楚嘅套件，唔會逼你成個框架或者 runtime 推倒重來。

可攜部分只會用標準 Web API，包括 `Request`、`Response`、`Headers`、`AbortSignal`、Web Streams 同由應用傳入嘅 `fetch`。Node.js、Bun、Deno 專屬能力會另開入口。已經匯出 Fetch 嘅框架唔需要 LikeGo 適配套件：Hono、Elysia 同 H3 2.x 嘅 `app.fetch` 可以直接交畀 `@likego/web`；H3 1.x 使用 `toWebHandler(app)`。Croner、BullMQ、NATS、Pino、Winston 等資源先使用生命週期適配器。

初次使用可以先睇[開始使用](/zh-Hant-HK/guide/getting-started)，再讀[架構](/zh-Hant-HK/guide/architecture)。[套件參考](/zh-Hant-HK/reference/packages)講清楚每個包負責邊一截；[驗證](/zh-Hant-HK/reference/verification)就列出真正跑過嘅檢查，唔會用一句「應該得」當證據。

## 呢度所講嘅 Go 風格

阻塞工作將 Context 放喺第一個參數，資源邊個持有要寫明，停止之後有穩定終態，小接口用結構類型滿足。唔係將 Go 命名、channel 或 goroutine 生搬去 TypeScript；TS export 保持自然，第三方套件獨有語意亦留返喺原生物件。
