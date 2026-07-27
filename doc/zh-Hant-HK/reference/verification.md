# 驗證

LikeGo 唔會將單元測試通過講成全部能力已經證實。可攜套件要跑嚴格 TypeScript、原始碼政策、production coverage、build 同發布套件 smoke；契約適用時，亦會分別喺 Bun、Node.js、Deno runtime lane 驗證。

依賴外部服務嘅 provider 必須連真實容器，image 固定到不可變 digest。測試會建立真正 Consul、etcd、NATS、OpenTelemetry Collector、Redis/BullMQ、ZooKeeper、Kubernetes/K3s 資源，驗證完再確認資源同容器清乾淨。Fake provider 適合測邊界，但唔可以代替真實協議 gate。

唯一完整、可以阻斷發布嘅根 gate 係：

```sh
bun run verify
```

各 provider 嘅 Docker 指令同局部檢查放喺自己 package scripts，並輸出機器可讀結果標記；佢哋適合診斷，但唔可以代替完整根 gate。發布狀態只取最後一次完整 `bun run verify` 嘅終態，同時仲要核對生成套件內容、workspace manifest、Docker cleanup 同 `git status`。指令啱啱開始唔叫成功，冇 error log 亦唔等於已經驗完。
