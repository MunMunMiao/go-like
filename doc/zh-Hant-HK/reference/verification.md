# 驗證

命令可以存在而從未通過。一條綠色通道唔代表每隻插頭、每個 runtime、每個例子或每個已打包 tarball 都得。記錄候選樹、工具版本、完整命令、退出狀態、數目同清理。

## 證據通道

| 通道                | 檢查咩                                                                      | 外部服務                 | 通過仍然唔證明                    |
| ------------------- | --------------------------------------------------------------------------- | ------------------------ | --------------------------------- |
| Format              | 原始碼同文件格式                                                            | 唔需要                   | Runtime 行為                      |
| Lint                | Oxlint 規則                                                                 | 唔需要                   | 型別或 runtime 行為               |
| Typecheck           | 根、套件、例子同 E2E TypeScript                                             | 唔需要                   | Build 輸出或 provider 行為        |
| Unit                | 確定性測試                                                                  | 唔需要                   | 真實網絡、Docker 或已打包 tarball |
| Build               | 套件 ESM 同宣告                                                             | 唔需要                   | Consumer resolution               |
| Runtime E2E         | 已宣告嘅 Bun 同 Node fixture                                                | 通常唔需要               | 每隻插頭                          |
| Provider E2E        | Consul、etcd、Kubernetes、ZooKeeper、Redis、RabbitMQ、NATS 同其他已宣告服務 | 需要                     | 正式可用性或 hosted CI            |
| Example E2E         | 例子程序、請求、就緒、停止同清理                                            | 有時需要                 | 每個例子嘅獨立安裝                |
| Published           | 已打包 tarball 被 Node 同 Bun fixture 消費                                  | 唔需要，插頭 import 除外 | npm 發布                          |
| Soak                | 長時間 HTTP 或服務行為                                                      | 通常唔需要               | 短測試，或每隻插頭                |
| Documentation build | VitePress                                                                   | 唔需要                   | 瀏覽器版面或翻譯質素              |
| Audit               | 依賴漏洞報告                                                                | 唔需要                   | 應用授權                          |

而家嘅公開清單係 20 個套件同 75 個入口。見[套件](/zh-Hant-HK/reference/packages)。

## 已宣告命令

由 repo 根：

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` 按次序行 `test:protobuf`、`fmt:check`、`lint:check`、`typecheck`、`build` 同 `test:unit:coverage`。Coverage 階段行每個根同 workspace coverage script，並以 `coverage:verify` 結束。`examples/payments-ledger` 係單元範圍例外，佢嘅 coverage script 亦行 PostgreSQL 同 NATS 場景，因此需要 Docker。

`fmt` 修復格式。`lint` 套用安全嘅 Oxlint 修正、格式化結果，而且只有零 warning 先成功：

```sh
bun run fmt
bun run lint
```

個別階段收窄失敗。通過一個階段唔取代 `verify`：

```sh
bun run test:protobuf
bun run fmt:check
bun run lint:check
bun run typecheck
bun run build
bun run test:unit
bun run test:unit:coverage
bun run test:parallel
bun run test:stability
```

`test:unit:coverage` 檢查可執行原始碼清單，以及逐檔案嘅行同函式覆蓋。佢唔聲稱分支覆蓋。`test:stability` 隨機排列每次根同 workspace 運行，將每個測試檔案重複兩次，並印出 seed。佢唔 retry。`test:parallel` 用兩個隔離 Bun worker 行一次單元範圍。Stability 同 parallel 都唔屬於 `verify`。

文件建置同審查保持獨立：

```sh
bun run doc:build
bun run audit
```

`test:protobuf` 行 Buf lint 同產生，檢查產生出嚟嘅 fixture 型別，並且執行佢嘅 RPC 整合測試。佢唔係唯讀格式檢查。

## E2E 範圍

根 script 係：

```sh
bun run test:e2e:suites
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e
bun run test:e2e:soak
bun run test:e2e:grpc-soak
```

範圍 script 會先 build，`test:e2e:grpc-soak` 除外，佢產生 protobuf 然後行 `e2e/grpc-soak.ts`。直接 `bun e2e/run.ts --scope <name>` 唔一定會 build。講清楚你行咗邊條。

Provider E2E 需要佢宣告嘅 Docker 服務同清理。Published 檢查打包 tarball 並安裝入暫存 consumer。Soak 預設 60 分鐘：

```sh
bun run test:e2e:soak
```

一次短 HTTP 運行唔係該 soak。

呢頁列出根 manifest 入面嘅 script。佢唔記錄佢哋嘅退出狀態。逐步 suite 佈局喺 E2E runner，唔喺呢度。

## 工具鏈觀察

Repo 唔將 runtime 或工具版本宣佈為執行要求。一條通道檢查每個所需工具可唔可以執行，然後記錄環境。缺少工具、逾時、非零狀態或失敗 consumer 會令該次運行失敗。版本字串本身唔會。

依賴版本、lockfile 同固定 fixture 係可重現輸入。

## 呢條文件軌道嘅基線證據

提供嘅契約審查報告咗 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` 上嘅以下結果：

```text
bun run typecheck  -> passed
bun run test:unit  -> passed, 2,736 tests across root and 87 workspaces
bun run fmt:check  -> passed, 1,514 files
source export audit -> 66 declared entries imported without an import error
```

該審查描述遷移前嘅樹。而家嘅原始碼喺 20 個套件匯出 75 個入口。該審查冇行 `build`、`doc:build`、`audit`、Docker provider E2E、跨 runtime 執行、已發布 tarball 檢查、npm 查詢、hosted CI，或 60 分鐘 soak。呢次文件修改唔用一個新嘅通過結果取代該記錄。

## 一個結果容許你講咩

| 結果               | 安全講法                                         |
| ------------------ | ------------------------------------------------ |
| 原始碼 export 檢查 | 「呢個套件喺呢棵樹匯出呢個符號。」               |
| 針對性 typecheck   | 「呢份原始碼喺呢條命令之下通過型別檢查。」       |
| 針對性單元測試     | 「呢啲案例喺呢條命令之下通過。」                 |
| `bun run verify`   | 「記錄到嘅 verify 序列喺呢棵樹同呢個環境通過。」 |
| Provider E2E       | 「呢個場景喺記錄到嘅服務同清理之下通過。」       |
| Runtime fixture    | 「呢個 fixture 喺呢個 runtime 版本之下通過。」   |
| Published consumer | 「呢個已打包產物被記錄到嘅 fixture 消費。」      |
| 文件建置           | 「VitePress 建置咗已設定嘅路由。」               |
| Soak               | 「呢段時間同工作量喺記錄到嘅殘留之下完成。」     |

編輯帳用[聲明](/reference/claims)。

## 已知邊界

- Manifest `publishConfig` 唔確立 npm 發布。
- Workflow 檔案唔確立 hosted CI 結果。
- 套件 script 可以係已宣告通道，而冇最近一次通過。
- Memory provider 唔確立跨程序或廠商協議行為。
- Web `ReadableStream` 唔確立內部全雙工 RPC。
- TLS option 唔確立應用身分驗證。
- 停止逾時唔確立每個原生資源已經結束。
