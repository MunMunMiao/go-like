# 驗證

LikeGo 只分兩類測試：`bun run test:unit` 會執行唔依賴外部服務嘅單元測試；`bun run test:e2e` 會喺本地構建
套件，並驗證真實 provider、跨 runtime、可執行 example 同發布 tarball consumer。Docker suite 會啟動真實
服務，再清理自己建立嘅資源。

CI 只執行安裝、格式檢查、類型檢查、構建同單元測試；Docker、跨 runtime、example 同 soak E2E 要喺具備
所需 runtime 同 Docker 嘅本地環境執行：

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

`test:unit:coverage` 只係可選 coverage 報告。`fmt`、`typecheck`、`build`、`audit` 同 `doc:build` 係工程指令，
唔係額外測試類型。指令存在唔代表已經通過，應以當次執行嘅退出狀態同 log 為準。
