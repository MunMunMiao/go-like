# go-like

go-like 係一套畀 TypeScript 後端用、帶 Go 風格嘅微服務建構元件。生命週期、Context、服務呼叫、服務探索、訊息、設定、儲存、健康檢查同可觀測性都拆成細小而清楚嘅套件，唔會逼你成個框架或者 runtime 推倒重來。

可攜部分只會用標準 Web API，包括 `Request`、`Response`、`Headers`、`AbortSignal`、Web Streams 同由應用傳入嘅 `fetch`。Node.js、Bun、Deno 專屬能力會另開入口。已經匯出 Fetch 嘅框架唔需要 go-like adapter 套件：Hono、Elysia 同 H3 2.x 嘅 `app.fetch` 可以直接交畀 `@go-like/web`；H3 1.x 使用 `toWebHandler(app)`。Croner、BullMQ、NATS、Pino、Winston 等資源先使用生命週期 adapter。

第一次閱讀可以先睇[開始使用](/zh-Hant-HK/guide/getting-started)，再按[診所預約：由 0 到 1](/zh-Hant-HK/guide/zero-to-one)跟住 milestone 行一次引導 project。已有現成服務要接入時，可以看[遷移同接入](/zh-Hant-HK/guide/migration)；想知道 go-like 同其他工具各自負責咩，請睇[go-like 同其他工具點樣分工](/zh-Hant-HK/guide/comparison)。

想知每個套件同 provider 負責邊一截，可以睇[套件同 provider 參考](/zh-Hant-HK/reference/providers)同[套件參考](/zh-Hant-HK/reference/packages)；想確認邊啲能力真係跑過測試，而唔係「應該得」，就睇[驗證](/zh-Hant-HK/reference/verification)。

## 揀一條閱讀路線

- **初學者：** 先睇[開始使用](/zh-Hant-HK/guide/getting-started)，再行[診所預約 project](/zh-Hant-HK/guide/zero-to-one)，先跑通 Handler、ready 訊號同停止。
- **TypeScript 或 Go 熟手：** 先睇[架構](/zh-Hant-HK/guide/architecture)，再睇[服務呼叫](/zh-Hant-HK/guide/service-call)同[套件同 provider 參考](/zh-Hant-HK/reference/providers)，先搞清 ownership 同終態。
- **框架使用者：** 先睇[工具比較](/zh-Hant-HK/guide/comparison)，再睇[遷移同接入](/zh-Hant-HK/guide/migration)，保留原本 router，只接入真正需要嘅邊界。

## 呢度所講嘅 Go 風格

阻塞工作將 Context 放喺第一個參數，資源邊個持有要寫清楚，停止之後有穩定終態，小 interface 用結構類型滿足。唔係將 Go 命名、channel 或 goroutine 生搬去 TypeScript；TS export 保持自然，第三方套件獨有語意亦留返喺原生物件。
