# 驗證

LikeGo 不會把單元測試通過當成所有能力都已確認。可攜式套件要跑嚴格 TypeScript、原始碼政策、production coverage、build 與發布套件 smoke；合約適用時，還會分別在 Bun、Node.js、Deno runtime lane 驗證。

依賴外部服務的 provider 必須連到真實容器，映像固定到不可變 digest。測試會建立真正的 Consul、etcd、NATS、OpenTelemetry Collector、Redis/BullMQ、ZooKeeper、Kubernetes/K3s 資源，驗證後再確認資源與容器都清乾淨。Fake provider 適合測邊界，但不能取代真實協定測試。

唯一完整、可阻擋發布的根 gate 是：

```sh
bun run verify
```

各 provider 的 Docker 指令與局部檢查放在自己 package scripts，並輸出機器可讀結果標記；它們適合診斷，但不能取代完整根 gate。發布狀態只取最後一次完整 `bun run verify` 的終態，同時還要核對生成套件內容、workspace manifest、Docker 清理與 `git status`。指令啟動不等於通過，沒有錯誤輸出也不能當完成證明。
