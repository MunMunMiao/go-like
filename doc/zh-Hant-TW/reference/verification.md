# 驗證

go-like 的驗證分成多條 evidence lane，不應把所有結果壓成兩類測試。`bun run test:unit` 執行不依賴外部服務的單元測試；`bun run test:e2e` 在本地建置套件，並驗證真實 provider、跨 runtime、可執行 example 與發布 tarball consumer。Docker suite 會啟動真實服務，再清理自己建立的資源。

Format、Lint、Typecheck、Build、Runtime E2E、Provider E2E、Example E2E、Published、Soak、Documentation build 與 Audit 應分開記錄。Repository 的標準門禁是 `bun run verify`，會依序執行 `fmt:check`、`lint`、`typecheck`、`build`、`test:unit` 與 `test:unit:coverage`，並強制驗證 coverage。完整 evidence lane、歷史 baseline 與本次文件 run record 請看[英文 Verification](/reference/verification)。

```sh
bun run verify
bun run test:e2e
bun run test:e2e:soak
```

單獨執行某個階段只用於縮小失敗範圍，局部通過不能取代 `bun run verify`。`bun run lint` 檢查 Oxlint 靜態規則，不等同於型別檢查或執行 runtime 行為。E2E 與 soak 仍是本機按需執行的獨立檢查。`fmt`、`lint`、`typecheck`、`build`、`audit` 與 `doc:build` 是工程指令，不是額外測試類型。`doc:build` 會檢查英文與已設定 locale 的 VitePress route，不等於瀏覽器 layout 或翻譯品質已通過。指令存在不代表已經通過，應以當次執行的退出狀態與日誌為準。完整 evidence lane、歷史 baseline 與本次文件 run record 請看[英文 Verification](/reference/verification)。
