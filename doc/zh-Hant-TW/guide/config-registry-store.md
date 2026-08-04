# 設定、服務註冊、快取與儲存

這四個領域常在維運流程中一起出現，但用途不同。`@go-like/config` 把多個來源合併成不可變的 last-good 快照，並管理已接納的 watcher；`@go-like/registry` 發布服務節點、探索可用 endpoint；`@go-like/cache` 保存可隨時捨棄的 bytes 值與可選 TTL；`@go-like/store` 則提供 Context-first 持久 bytes 記錄、revision、TTL、CAS、prefix 查詢及穩定分頁。

設定來源包含環境值、檔案、Consul、etcd，以及透過 `@go-like/config-vault` 讀取 Vault KV v2。Registry 可選 mDNS、Consul、etcd、Kubernetes EndpointSlice 或 ZooKeeper。Cache provider 有 `@go-like/cache-memory` 與 `@go-like/cache-redis`。Store 有單 owner 檔案快照、Consul KV、etcd KV，以及透過 `@go-like/store-vault` 使用 Vault KV v2。每個實作都是獨立套件，沒選到的 provider 不會混進相依套件。

Provider 明確接收位址、憑證和宿主能力。可攜式 HTTP provider 使用傳入的單參數 Fetch，不讀 runtime 全域狀態。敏感 token 只放 header，公開錯誤不夾帶 token 或 response body。watch 遇到 etcd compaction 或 Kubernetes `410 Gone` 時，會先重新取得完整快照再接續。ZooKeeper watch 在一次性通知或 session 過期後也會重新掛載；如果取消發生在 `multi` 已提交之後，provider 會等待真實結果並依精確狀態回滾，結果仍然不明確時則關閉 session，再恢復先前已接納的註冊 owner。

檔案 Store 適合少量本機狀態，不能當成多程序資料庫；Registry 資料描述短暫可達性，也不是業務永久紀錄。先守住這些界線，比提供一個什麼都像能做的 API 實際得多。
