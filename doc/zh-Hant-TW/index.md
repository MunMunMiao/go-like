# go-like

go-like 是一套給 TypeScript 後端使用的 Go 風格微服務工具套件。它把生命週期、Context、服務呼叫、服務探索、訊息、設定、儲存、健康檢查與可觀測性拆成清楚的小套件，不會要求團隊把現有框架或 runtime 全部換掉。

可攜式程式碼只依賴標準 Web API，像是 `Request`、`Response`、`Headers`、`AbortSignal`、Web Streams 與外部傳入的 `fetch`。Node.js、Bun、Deno 專屬能力會放在獨立入口。已經匯出 Fetch 的框架不需要 go-like adapter 套件：Hono、Elysia 與 H3 2.x 的 `app.fetch` 可以直接交給 `@go-like/web`；H3 1.x 使用 `toWebHandler(app)`。Croner、BullMQ、NATS、Pino、Winston 等資源才使用生命週期適配器。

第一次閱讀建議從[開始使用](/zh-Hant-TW/guide/getting-started)開始，再按[診所預約：從 0 到 1](/zh-Hant-TW/guide/zero-to-one)依里程碑走過引導專案。已經有現成服務要導入時，可以看[遷移與導入](/zh-Hant-TW/guide/migration)；想知道 go-like 和其他工具各自負責什麼，請看[工具比較](/zh-Hant-TW/guide/comparison)。

想知道每個套件與 provider 到底負責什麼，就看[套件與 provider 參考](/zh-Hant-TW/reference/providers)和[套件參考](/zh-Hant-TW/reference/packages)；想確認哪些能力真的跑過測試，而不是「照理說應該可以」，請看[驗證](/zh-Hant-TW/reference/verification)。

## 選一條閱讀路線

- **初學者：** 先看[開始使用](/zh-Hant-TW/guide/getting-started)，再走[診所預約專案](/zh-Hant-TW/guide/zero-to-one)，先跑通 Handler、ready 訊號與停止。
- **TypeScript 或 Go 專家：** 先讀[架構](/zh-Hant-TW/guide/architecture)，再讀[服務呼叫](/zh-Hant-TW/guide/service-call)與[套件與 provider 參考](/zh-Hant-TW/reference/providers)，先確認 ownership 和終態。
- **框架使用者：** 先看[工具比較](/zh-Hant-TW/guide/comparison)，再看[遷移與導入](/zh-Hant-TW/guide/migration)，保留原本的 router，只導入需要的邊界。

## 這裡所說的 Go 風格

會阻塞的工作把 Context 放在第一個參數、資源由誰持有要講清楚、停止後要有穩定終態，小介面則透過結構型別實作。這不代表硬搬 Go 的命名或 channel；TypeScript 仍使用自然的 export，第三方套件特有語意也保留在原生物件上。
