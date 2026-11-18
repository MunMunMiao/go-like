# 驗證

一道指令可以存在，卻還沒有通過。一條綠燈的通道不表示每一個插頭、runtime、範例或打包後的 tarball 都能用。記錄候選樹、工具版本、確切指令、結束狀態、計數與清理。

## 證據通道

| 通道         | 它檢查什麼                                                                       | 外部服務             | 通過不能證明什麼                    |
| ------------ | -------------------------------------------------------------------------------- | -------------------- | ----------------------------------- |
| 格式         | 原始碼與文件的格式                                                               | 否                   | Runtime 行為                        |
| Lint         | Oxlint 規則                                                                      | 否                   | 型別或 runtime 行為                 |
| 型別檢查     | 根目錄、套件、範例與 E2E 的 TypeScript                                           | 否                   | 建置輸出或 provider 行為            |
| 單元測試     | 可決定的測試                                                                     | 否                   | 真實網路、Docker 或打包後的 tarball |
| 建置         | 套件的 ESM 與宣告檔                                                              | 否                   | 取用端的解析                        |
| Runtime E2E  | 已宣告之處的 Bun 與 Node fixture                                                 | 通常否               | 每一個插頭                          |
| Provider E2E | Consul、etcd、Kubernetes、ZooKeeper、Redis、RabbitMQ、NATS，以及其他已宣告的服務 | 是                   | 正式環境可用性或託管 CI             |
| 範例 E2E     | 範例程序、請求、就緒、停止與清理                                                 | 有時                 | 每個範例的另一份安裝                |
| 已發布       | Node 與 Bun fixture 取用打包後的 tarball                                         | 否，插頭 import 除外 | npm 發布                            |
| Soak         | 長時間的 HTTP 或服務行為                                                         | 通常否               | 一輪短測試，或每一個插頭            |
| 文件建置     | VitePress                                                                        | 否                   | 瀏覽器版面或翻譯品質                |
| 稽核         | 依賴漏洞報告                                                                     | 否                   | 應用程式授權                        |

目前的公開清單是 20 個套件與 75 個入口。見[套件參考](/zh-Hant-TW/reference/packages)。

## 已宣告的指令

從 repository 根目錄：

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` 依序執行 `test:protobuf`、`fmt:check`、`lint:check`、`typecheck`、`build` 與 `test:unit:coverage`。覆蓋率階段會執行每個根目錄與 workspace 的覆蓋率腳本，並以 `coverage:verify` 結束。`examples/payments-ledger` 是單元範圍的例外：它的覆蓋率腳本也會跑 PostgreSQL 與 NATS 情境，因此需要 Docker。

`fmt` 修復格式。`lint` 套用安全的 Oxlint 修復、格式化結果，並且只在零警告時成功：

```sh
bun run fmt
bun run lint
```

個別階段用來縮小失敗範圍。通過一個階段不能取代 `verify`：

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

`test:unit:coverage` 檢查可執行原始碼清單，以及每個檔案的行與函式覆蓋率。它不主張分支覆蓋率。`test:stability` 把每個根目錄與 workspace 的執行隨機化，每個測試檔重複兩次，並印出 seed。它不會重試。`test:parallel` 用兩個隔離的 Bun worker 把單元範圍跑一次。穩定性與平行都不在 `verify` 裡。

文件建置與稽核保持分開：

```sh
bun run doc:build
bun run audit
```

`test:protobuf` 執行 Buf lint 與產生、檢查產生出來的 fixture 型別，並執行它的 RPC 整合測試。它不是唯讀的格式檢查。

## E2E 範圍

根腳本是：

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

範圍腳本會先建置，`test:e2e:grpc-soak` 除外：它產生 protobuf，然後執行 `e2e/grpc-soak.ts`。直接的 `bun e2e/run.ts --scope <name>` 不一定會建置。寫明你跑的是哪一個。

Provider E2E 需要它宣告的 Docker 服務與清理。已發布檢查會打包 tarball，並把它們裝進預備好的取用端。Soak 預設 60 分鐘：

```sh
bun run test:e2e:soak
```

一輪短的 HTTP 執行不是那個 soak。

本頁列出根 manifest 裡的腳本。它沒有記錄它們的結束狀態。逐步的 suite 編排跟 E2E runner 放在一起，不在這裡。

## 工具鏈觀察

這個 repository 不把 runtime 或工具版本宣告成執行要件。一條通道檢查每個必要工具能否執行，然後記錄環境。缺少工具、逾時、非零狀態，或失敗的取用端，都會讓這次執行失敗。版本字串不會讓它失敗。

依賴版本、lockfile 與固定的 fixture 是可重現性的輸入。

## 這條文件線的基準證據

提供的契約稽核在 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` 上報告了下列結果：

```text
bun run typecheck  -> passed
bun run test:unit  -> passed, 2,736 tests across root and 87 workspaces
bun run fmt:check  -> passed, 1,514 files
source export audit -> 66 declared entries imported without an import error
```

那份稽核描述的是遷移前的樹。目前的原始碼在 20 個套件上匯出 75 個入口。該稽核沒有執行 `build`、`doc:build`、`audit`、Docker provider E2E、跨 runtime 執行、已發布 tarball 檢查、npm 查詢、託管 CI，或 60 分鐘 soak。這次文件修訂沒有用一輪新的通過結果取代那份記錄。

## 一個結果允許你說什麼

| 結果             | 可以這樣說                                           |
| ---------------- | ---------------------------------------------------- |
| 原始碼匯出檢查   | 「這個套件在這棵樹上匯出這個符號。」                 |
| 針對性型別檢查   | 「這份原始碼在這道指令下通過型別檢查。」             |
| 針對性單元測試   | 「這些案例在這道指令下通過。」                       |
| `bun run verify` | 「對這棵樹與這個環境，記錄到的 verify 序列通過了。」 |
| Provider E2E     | 「這個情境在記錄到的服務與清理下通過。」             |
| Runtime fixture  | 「這個 fixture 在這個 runtime 版本下通過。」         |
| 已發布的取用端   | 「記錄到的 fixture 取用了這個打包後的產物。」        |
| 文件建置         | 「VitePress 建置了設定好的路由。」                   |
| Soak             | 「這段時間與這份負載在記錄到的殘量下完成。」         |

編輯用的帳冊見[聲明與證據](/reference/claims)。

## 已知邊界

- Manifest 裡的 `publishConfig` 不能證明 npm 已發布。
- 一個 workflow 檔不能證明託管 CI 的結果。
- 套件腳本可以是一條已宣告的通道，而最近沒有通過。
- 記憶體 provider 不能證明跨程序或廠商協定的行為。
- Web `ReadableStream` 不能證明內部的全雙工 RPC。
- TLS 選項不能證明應用程式的身分驗證。
- 停止逾時不能證明每一個原生資源都已結束。
