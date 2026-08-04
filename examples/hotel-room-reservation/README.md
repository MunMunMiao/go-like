# 酒店房晚库存预留

## 行业问题

酒店库存按房型和入住夜逐夜扣减。一笔跨夜预留只要有任意一晚容量不足就必须整体失败，释放预留后每一晚的容量都必须恢复。

## 独有业务不变量

- 任意房型、任意房晚都不得超卖。
- 跨夜预留必须全段成功或完全不占用库存。
- 释放操作幂等，并恢复该预留覆盖的全部房晚。

## 源码结构

- `src/service.ts`：房晚模型、逐夜库存、预留与释放操作，以及库存 readiness。
- `src/http.ts`：预留与释放的标准 Fetch 路由。
- `src/main.ts`：唯一直接执行入口，启动 Node HTTP Server 并承接进程信号。

## go-like 能力

使用 `@go-like/context` 贯穿预留仓储操作，使用 `@go-like/web` 提供预留与释放的标准 Fetch 入口，并使用 `@go-like/health` 在房型库存目录未加载时让 readiness 失败关闭。

## 验证矩阵

| 场景                      | 证据                               |
| ------------------------- | ---------------------------------- |
| 跨夜库存不超卖            | `test/main.test.ts` 的容量用例     |
| 释放恢复全部房晚          | `test/main.test.ts` 的释放用例     |
| 空库存目录 readiness 失败 | `test/main.test.ts` 的健康探针用例 |
| 标准 Fetch 入口           | `test/main.test.ts` 的 HTTP 用例   |

```bash
bun run --filter @go-like/example-hotel-room-reservation typecheck
bun run --filter @go-like/example-hotel-room-reservation test:unit
```

## Docker 判定

本案例使用内存房晚仓储，不声明已连接 PMS、渠道管理或支付系统，因此不需要 Docker。接入真实库存数据库时，必须增加并发事务和约束的真实集成验证。

## 非目标

不实现房价、税费、入住人资料、支付担保、渠道同步或超售补偿。

## 直接运行

```sh
bun run --cwd examples/hotel-room-reservation start
```

`start` 会先构建本地 go-like 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `GO_LIKE_EXAMPLE_READY=...` 后预留一个房间：

```sh
curl -sS http://127.0.0.1:3000/v1/room-holds \
  -H 'content-type: application/json' \
  -d '{"holdId":"hold-demo","roomType":"standard","checkInNight":1,"checkOutNight":3,"rooms":1}'
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，go-like 会有序停止 HTTP Server。
