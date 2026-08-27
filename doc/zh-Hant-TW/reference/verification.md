# 驗證

go-like 的驗證分成多條 evidence lane，不應把所有結果壓成兩類測試。`bun run test:unit` 執行不依賴外部服務的單元測試；`bun run test:e2e` 在本地建置套件，並驗證真實 provider、跨 runtime、可執行 example 與發布 tarball consumer。Docker suite 會啟動真實服務，再清理自己建立的資源。

Format、Lint、Typecheck、Build、Runtime E2E、Provider E2E、Example E2E、Published、Soak、Documentation build 與 Audit 應分開記錄。Repository 的標準門禁是 `bun run verify`，會依序執行 `fmt:check`、`lint:check`、`typecheck`、`build` 與 `test:unit:coverage`；coverage 階段會執行一次 root 與 workspace 的 coverage script，並強制驗證 coverage。`examples/payments-ledger` 是唯一超出單元測試範圍的例外：它還會執行真實 PostgreSQL/NATS integration scenario，因此需要 Docker。完整 evidence lane、歷史 baseline 與本次文件 run record 請看[英文 Verification](/reference/verification)。

```sh
bun run verify
bun run test:parallel
bun run test:stability
bun run test:e2e
bun run test:e2e:soak
```

`test:parallel` 使用兩個隔離的 Bun worker 執行一次相同的單元測試範圍，用來檢查檔案層級的平行安全。`test:stability` 會隨機排列各段測試並將每個測試檔案重複兩次，輸出可重現的 seed，而且不使用 retry。兩者都是獨立檢查，不屬於 canonical gate，也不能取代 `verify`；`test:stability` 尋找順序相依與偶發失敗，和驗證 60 分鐘執行行為的 `test:e2e:soak` 不同。

單獨執行某個階段只用於縮小失敗範圍，局部通過不能取代 `bun run verify`。`bun run fmt` 會修正格式。`bun run lint` 會套用安全的 Oxlint 修正、重新格式化，並在仍有 warning 時失敗。門禁使用不修改檔案的 `fmt:check` 與 `lint:check`，其中 `lint:check` 同樣要求零 warning。這些指令不等同於型別檢查或執行 runtime 行為。E2E 與 soak 仍是本機按需執行的獨立檢查。`fmt`、`lint`、`typecheck`、`build`、`audit` 與 `doc:build` 是工程指令，不是額外測試類型。`doc:build` 會檢查英文與已設定 locale 的 VitePress route，不等於瀏覽器 layout 或翻譯品質已通過。指令存在不代表已經通過，應以當次執行的退出狀態與日誌為準。完整 evidence lane、歷史 baseline 與本次文件 run record 請看[英文 Verification](/reference/verification)。
