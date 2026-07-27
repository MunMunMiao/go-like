# 驗證

LikeGo 只區分兩類測試：`bun run test:unit` 執行不依賴外部服務的單元測試；`bun run test:e2e` 在本地建置
套件，並驗證真實 provider、跨 runtime、可執行 example 與發布 tarball consumer。Docker suite 會啟動真實
服務，再清理自己建立的資源。

CI 只執行安裝、格式檢查、型別檢查、建置與單元測試；Docker、跨 runtime、example 與 soak E2E 要在具備
所需 runtime 與 Docker 的本地環境執行：

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

`test:unit:coverage` 只是選用的 coverage 報告。`fmt`、`typecheck`、`build`、`audit` 與 `doc:build` 是工程指令，
不是額外測試類型。指令存在不代表已經通過，應以當次執行的退出狀態與日誌為準。
