# 驗證

go-like 的驗證分成多條 evidence lane。命令存在唔代表已經通過；一條 lane 變綠，亦唔代表所有 provider、runtime、example 或 published package 都正常。記錄時應保留 candidate tree、工具版本、完整命令、退出狀態、數量同清理結果。

## Evidence lanes

| Lane                | 會檢查                                                                 | 通常需唔需要外部服務 | 通過後仍然唔代表                                      |
| ------------------- | ---------------------------------------------------------------------- | -------------------- | ----------------------------------------------------- |
| Format              | 原始碼同文件格式                                                       | 唔需要               | runtime 行為或 API 相容性                             |
| Typecheck           | root、E2E、package 同 example 的 TypeScript 契約                       | 唔需要               | build output、runtime 語意或 provider 行為            |
| Unit                | 確定性 root、package 同 example 測試                                   | 唔需要               | 真實網絡、Docker、published tarball 或跨 runtime 行為 |
| Build               | package ESM 同 declaration output                                      | 唔需要               | consumer resolution 或 runtime 行為                   |
| Runtime E2E         | 已宣告嘅 Bun、Node.js 同 Deno fixture                                  | 通常唔需要           | 所有 provider 或所有 package 都支援每個 runtime       |
| Provider E2E        | 真實 Consul、etcd、Kubernetes、ZooKeeper、Redis、RabbitMQ、NATS 等服務 | 需要                 | production 可用性或 hosted CI 結果                    |
| Example E2E         | example process、request、readiness、停止同清理                        | 視乎 example         | 每個 example 喺獨立安裝中都正常                       |
| Published           | 實際打包嘅 tarball 被 Node、Bun、Deno fixture 消費                     | 通常唔需要           | 已經發布到 npm 或有外部使用者採用                     |
| Soak                | 長時間 HTTP 或 service 行為                                            | 通常唔需要           | 短測試或所有 provider 行為                            |
| Documentation build | VitePress route 同 Markdown build                                      | 唔需要               | 瀏覽器 layout 或本地化語意 parity                     |
| Audit               | dependency vulnerability report                                        | 唔需要               | application security design 或 authorization 完整性   |

## 常用命令

喺 repository root 執行：

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit
bun run doc:build
bun run audit
```

Coverage 係獨立報告：

```sh
bun run test:unit:coverage
```

E2E 可以按 scope 收窄：

```sh
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e
bun run test:e2e:soak
```

公開 scope script 會先 build；直接執行 `bun e2e/run.ts ...` 或 workspace E2E command 就未必會先 build，所以 run record 要寫清楚前置條件。Provider E2E 需要指定 Docker service 同清理；soak script 預設要求 60 分鐘，短時間 k6 或 HTTP 測試唔可以當成 60 分鐘穩定性證明。

目前 checkout 宣告嘅工具版本、完整 evidence lane、歷史 baseline 同文件 run record，請參考[英文 Verification](/reference/verification)。本地 runtime patch 版本唔同，只可以作診斷用途，唔代表完整 release matrix 已經通過。

## 記錄結果時要講到幾盡

每次驗證至少記錄：

```text
candidate tree:  <commit SHA 或明確的 dirty-tree 描述>
environment:     <OS、container/host、process mode>
Bun:             <版本或未使用>
Node.js:         <版本或未使用>
Deno:            <版本或未使用>
command:         <完整命令>
started:         <開始時間>
finished:        <完成時間>
exit status:     <整數>
summary:         <測試數量、package 數量或 route 數量>
Docker residual: <none，或者列出仍然存在的 container>
process/socket residual: <none，或者列出觀察結果>
notes:           <已知限制同跳過嘅 scope>
```

`doc:build` 通過只可以話「VitePress 成功建立已設定嘅文件 route」；唔可以延伸成瀏覽器 layout、翻譯質素、runtime 行為、provider E2E、npm publication 或 production adoption 都已經通過。完整嘅 claim 邊界請看[英文 Claims](/reference/claims)。
