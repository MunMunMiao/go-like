# 設定、註冊、快取與儲存

四個領域喺運維上成日一齊出現，但用途唔同。`@likego/config` 將多個來源合併成不可變 last-good 快照，並管理已接納 watcher；`@likego/registry` 發布服務節點同探索可用 endpoint；`@likego/cache` 保存可以隨時丟棄嘅 bytes 值同可選 TTL；`@likego/store` 提供 Context-first 持久 bytes 記錄、revision、TTL、CAS、prefix 查詢同穩定分頁。

設定來源有環境值、檔案、Consul、etcd，以及透過 `@likego/config-vault` 讀取 Vault KV v2。Registry 可以揀 mDNS、Consul、etcd、Kubernetes EndpointSlice 或 ZooKeeper。Cache provider 有 `@likego/cache-memory` 同 `@likego/cache-redis`。Store 有單 owner 檔案快照、Consul KV、etcd KV，以及透過 `@likego/store-vault` 使用 Vault KV v2。每個實作都係獨立平鋪套件，冇揀嘅 provider 唔會跟埋入相依樹。

Provider 明確接收位址、憑證同宿主能力。可攜 HTTP provider 用傳入嘅單參數 Fetch，唔讀 runtime global。敏感 token 只放 header，公開錯誤唔可以帶 token 或 response body。watch 遇到 etcd compaction、Kubernetes `410 Gone` 呢類缺口，會先重取完整快照再繼續。ZooKeeper watch 喺一次性通知或者 session 過期之後亦會重新掛載；如果取消發生喺 `multi` 已提交之後，provider 會等真實結果並按精確狀態回滾，結果仍然唔明確時就關閉 session，再恢復之前已接納嘅註冊 owner。

檔案 Store 適合少量本機狀態，唔係多程序資料庫；Registry 記錄短暫可達性，亦唔係永久業務紀錄。守住呢啲界線，先至唔會畀一個表面方便嘅 API 誤導。
